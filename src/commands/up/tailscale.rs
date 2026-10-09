//! The Tailscale serve tunnel provider: `tailscale serve` run in the
//! foreground as our child, publishing the Tunnel port at
//! `https://<machine>.<tailnet>.ts.net`. Foreground serve config belongs to
//! the CLI's session, so tailscaled drops it when the child exits for any
//! reason and nothing lingers in the user's serve config.

use std::path::PathBuf;
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use serde_json::Value;
use tokio::io::AsyncBufReadExt as _;

use super::tunnel_access::{Availability, ProviderChild, TunnelProvider};
use crate::error::{anyhow, Result};

/// The port `tailscale serve` takes on the tailnet address.
const HTTPS_PORT: u16 = 443;
/// Foreground serve with `--https=<port> <target>` arrived in 1.52.
const MINIMUM_VERSION: (u32, u32) = (1, 52);
/// Long enough for a bad flag or a serve conflict to end the child.
const STARTUP_GRACE: Duration = Duration::from_millis(1500);
const PROBE_TIMEOUT: Duration = Duration::from_secs(10);

const INSTALL_GUIDANCE: &str = "Tailscale is not installed. Install it from \
https://tailscale.com/download and log in, then turn on Tunnel access again. \
OpenResearch never downloads it for you.";

pub(super) struct TailscaleServe;

#[async_trait]
impl TunnelProvider for TailscaleServe {
    async fn check(&self) -> Availability {
        let Some(binary) = binary() else {
            return Availability::NotInstalled {
                message: INSTALL_GUIDANCE.into(),
            };
        };
        if let Ok(version) = probe(&binary, &["version"]).await {
            if let Some(unsupported) = check_version(&version) {
                return unsupported;
            }
        }
        let status = match probe(&binary, &["status", "--json"]).await {
            Ok(status) => status,
            Err(error) => {
                return Availability::Unavailable {
                    message: format!(
                        "Tailscale is installed but not running. Open the Tailscale app or \
                         start tailscaled, then try again. ({error})"
                    ),
                }
            }
        };
        let origin = match origin_from_status(&status) {
            Ok(origin) => origin,
            Err(unavailable) => return unavailable,
        };
        let serve = match probe(&binary, &["serve", "status", "--json"]).await {
            Ok(serve) => serve,
            Err(error) => {
                return Availability::Unavailable {
                    message: format!("Could not read your Tailscale serve configuration: {error}"),
                }
            }
        };
        if let Some(conflict) = serve_conflict(&serve) {
            return conflict;
        }
        Availability::Ready { origin }
    }

    async fn start(&self, port: u16) -> Result<Box<dyn ProviderChild>> {
        let binary = binary().ok_or_else(|| anyhow!("{INSTALL_GUIDANCE}"))?;
        let mut command = tokio::process::Command::new(&binary);
        command
            .arg("serve")
            .arg(format!("--https={HTTPS_PORT}"))
            .arg(format!("http://127.0.0.1:{port}"))
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        hide_console(&mut command);
        let mut child = command
            .spawn()
            .map_err(|error| anyhow!("Could not start tailscale serve: {error}"))?;
        let output = Arc::new(Mutex::new(Vec::new()));
        if let Some(stderr) = child.stderr.take() {
            let output = output.clone();
            tokio::spawn(async move {
                let mut lines = tokio::io::BufReader::new(stderr).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    let mut output = output.lock().unwrap();
                    output.push(line);
                    let excess = output.len().saturating_sub(10);
                    output.drain(..excess);
                }
            });
        }
        let mut child = ServeChild { child, output };
        tokio::select! {
            reason = child.exited() => Err(anyhow!("{reason}")),
            _ = tokio::time::sleep(STARTUP_GRACE) => Ok(Box::new(child) as Box<dyn ProviderChild>),
        }
    }
}

struct ServeChild {
    child: tokio::process::Child,
    /// The last lines tailscale wrote to stderr, to explain an exit.
    output: Arc<Mutex<Vec<String>>>,
}

#[async_trait]
impl ProviderChild for ServeChild {
    async fn exited(&mut self) -> String {
        let status = self.child.wait().await;
        // Let the stderr reader drain what the child wrote last.
        tokio::time::sleep(Duration::from_millis(50)).await;
        let output = self.output.lock().unwrap().join("\n");
        let status = match status {
            Ok(status) => status.to_string(),
            Err(error) => error.to_string(),
        };
        if output.trim().is_empty() {
            format!("tailscale serve stopped ({status}).")
        } else {
            format!("tailscale serve stopped ({status}): {}", output.trim())
        }
    }

    async fn stop(mut self: Box<Self>) {
        // A clean exit lets the CLI end its serve session itself; tailscaled
        // also drops it if we have to kill the child.
        #[cfg(unix)]
        if let Some(pid) = self.child.id() {
            unsafe {
                libc::kill(pid as libc::pid_t, libc::SIGTERM);
            }
            if tokio::time::timeout(Duration::from_secs(3), self.child.wait())
                .await
                .is_ok()
            {
                return;
            }
        }
        let _ = self.child.kill().await;
    }
}

/// The `tailscale` CLI: on PATH, else where the desktop apps install it.
fn binary() -> Option<PathBuf> {
    crate::local::shell_env::find_on_path("tailscale").or_else(|| {
        let candidates: &[&str] = if cfg!(target_os = "macos") {
            &["/Applications/Tailscale.app/Contents/MacOS/Tailscale"]
        } else if cfg!(windows) {
            &[r"C:\Program Files\Tailscale\tailscale.exe"]
        } else {
            &[]
        };
        candidates
            .iter()
            .map(PathBuf::from)
            .find(|path| path.is_file())
    })
}

#[cfg(windows)]
fn hide_console(command: &mut tokio::process::Command) {
    command.creation_flags(windows_sys::Win32::System::Threading::CREATE_NO_WINDOW);
}

#[cfg(not(windows))]
fn hide_console(_command: &mut tokio::process::Command) {}

/// Runs a read-only tailscale command. Its stdout counts even on a nonzero
/// exit, since some versions exit 1 alongside a JSON status.
async fn probe(binary: &PathBuf, args: &[&str]) -> Result<String> {
    let mut command = tokio::process::Command::new(binary);
    command.args(args).stdin(Stdio::null()).kill_on_drop(true);
    hide_console(&mut command);
    let output = tokio::time::timeout(PROBE_TIMEOUT, command.output())
        .await
        .map_err(|_| anyhow!("tailscale {} timed out", args.join(" ")))??;
    let stdout = String::from_utf8_lossy(&output.stdout).into_owned();
    if output.status.success() || stdout.trim_start().starts_with('{') {
        return Ok(stdout);
    }
    let stderr = String::from_utf8_lossy(&output.stderr);
    Err(anyhow!("{}", stderr.trim()))
}

/// Refuses CLIs older than foreground `--https` serve. An unreadable version
/// is let through; a real incompatibility then shows when serve exits.
fn check_version(output: &str) -> Option<Availability> {
    let version = output.lines().next()?.trim();
    let mut parts = version.split('.');
    let major = parts.next()?.parse::<u32>().ok()?;
    let minor = parts.next()?.parse::<u32>().ok()?;
    ((major, minor) < MINIMUM_VERSION).then(|| Availability::Unavailable {
        message: format!(
            "Tailscale {version} is too old for Tunnel access. Update Tailscale to {}.{} or newer.",
            MINIMUM_VERSION.0, MINIMUM_VERSION.1
        ),
    })
}

/// The https origin this machine has on its tailnet, from
/// `tailscale status --json`, or why there is none to publish at.
fn origin_from_status(status: &str) -> std::result::Result<String, Availability> {
    let status: Value =
        serde_json::from_str(status).map_err(|error| Availability::Unavailable {
            message: format!("Could not read tailscale status: {error}"),
        })?;
    match status["BackendState"].as_str().unwrap_or_default() {
        "Running" => {}
        "NeedsLogin" => {
            return Err(Availability::LoggedOut {
                message: "Tailscale is logged out. Log in from the Tailscale app or run \
                          `tailscale up`, then try again."
                    .into(),
            })
        }
        "NeedsMachineAuth" => {
            return Err(Availability::LoggedOut {
                message: "This computer is waiting for approval by your tailnet admin.".into(),
            })
        }
        "Stopped" => {
            return Err(Availability::Unavailable {
                message: "Tailscale is disconnected. Connect it from the Tailscale app or run \
                          `tailscale up`, then try again."
                    .into(),
            })
        }
        other => {
            return Err(Availability::Unavailable {
                message: format!(
                    "Tailscale is not ready ({}). Try again in a moment.",
                    if other.is_empty() {
                        "unknown state"
                    } else {
                        other
                    }
                ),
            })
        }
    }
    let host = status["Self"]["DNSName"]
        .as_str()
        .unwrap_or_default()
        .trim_end_matches('.');
    if host.is_empty() {
        return Err(Availability::Unavailable {
            message: "This computer has no MagicDNS name. Turn on MagicDNS in the Tailscale \
                      admin console, then try again."
                .into(),
        });
    }
    let https = status["CertDomains"]
        .as_array()
        .is_some_and(|domains| domains.iter().any(|domain| domain.as_str() == Some(host)));
    if !https {
        return Err(Availability::Unavailable {
            message: "HTTPS certificates are off for your tailnet. Turn on HTTPS in the \
                      Tailscale admin console (DNS page), then try again."
                .into(),
        });
    }
    Ok(format!("https://{host}"))
}

/// Whether the user's serve config (background, or another foreground
/// session) already serves the https port we would take.
fn serve_conflict(serve: &str) -> Option<Availability> {
    if serve.trim().is_empty() {
        return None;
    }
    let config: Value = match serde_json::from_str(serve) {
        Ok(config) => config,
        Err(error) => {
            return Some(Availability::Unavailable {
                message: format!("Could not read your Tailscale serve configuration: {error}"),
            })
        }
    };
    let foreground = config["Foreground"]
        .as_object()
        .into_iter()
        .flat_map(|sessions| sessions.values());
    let taken = std::iter::once(&config)
        .chain(foreground)
        .any(serves_https_port);
    taken.then(|| Availability::Conflict {
        message: format!(
            "Your Tailscale serve configuration already uses port {HTTPS_PORT}. OpenResearch \
             will not overwrite it. Remove it with `tailscale serve --https={HTTPS_PORT} off` \
             (or `tailscale serve reset`), then try again."
        ),
    })
}

fn serves_https_port(config: &Value) -> bool {
    let port = HTTPS_PORT.to_string();
    let suffix = format!(":{HTTPS_PORT}");
    config["TCP"].get(&port).is_some()
        || config["Web"]
            .as_object()
            .is_some_and(|web| web.keys().any(|host| host.ends_with(&suffix)))
}

#[cfg(test)]
mod tests {
    use super::*;

    const RUNNING: &str = r#"{
        "Version": "1.76.1",
        "BackendState": "Running",
        "Self": { "DNSName": "laptop.tail1234.ts.net.", "HostName": "laptop" },
        "CertDomains": ["laptop.tail1234.ts.net"],
        "MagicDNSSuffix": "tail1234.ts.net"
    }"#;

    #[test]
    fn the_origin_is_the_magicdns_name_over_https() {
        assert_eq!(
            origin_from_status(RUNNING).unwrap(),
            "https://laptop.tail1234.ts.net"
        );
    }

    #[test]
    fn a_logged_out_or_unready_tailscale_is_not_published() {
        let logged_out = RUNNING.replace("\"Running\"", "\"NeedsLogin\"");
        assert!(matches!(
            origin_from_status(&logged_out),
            Err(Availability::LoggedOut { .. })
        ));
        let stopped = RUNNING.replace("\"Running\"", "\"Stopped\"");
        assert!(matches!(
            origin_from_status(&stopped),
            Err(Availability::Unavailable { .. })
        ));
        let no_https = RUNNING.replace("[\"laptop.tail1234.ts.net\"]", "[]");
        let Err(Availability::Unavailable { message }) = origin_from_status(&no_https) else {
            panic!("HTTPS off was accepted");
        };
        assert!(message.contains("HTTPS"), "{message}");
    }

    #[test]
    fn port_443_in_the_users_serve_config_is_a_conflict() {
        let background = r#"{
            "TCP": { "443": { "HTTPS": true } },
            "Web": { "laptop.tail1234.ts.net:443": { "Handlers": { "/": { "Proxy": "http://127.0.0.1:3000" } } } }
        }"#;
        let foreground = r#"{
            "Foreground": { "session-1": {
                "TCP": { "443": { "HTTPS": true } },
                "Web": { "laptop.tail1234.ts.net:443": { "Handlers": { "/": { "Proxy": "http://127.0.0.1:3000" } } } }
            } }
        }"#;
        for config in [background, foreground] {
            assert!(matches!(
                serve_conflict(config),
                Some(Availability::Conflict { .. })
            ));
        }
    }

    #[test]
    fn other_serve_ports_and_empty_config_leave_443_free() {
        let other_port = r#"{
            "TCP": { "8443": { "HTTPS": true } },
            "Web": { "laptop.tail1234.ts.net:8443": { "Handlers": { "/": { "Proxy": "http://127.0.0.1:3000" } } } }
        }"#;
        for config in ["", "{}", "{}\n", other_port] {
            assert_eq!(serve_conflict(config), None, "{config}");
        }
    }

    #[test]
    fn clis_older_than_foreground_serve_are_refused() {
        assert!(matches!(
            check_version("1.50.1\n  tailscale commit: abc\n"),
            Some(Availability::Unavailable { .. })
        ));
        assert_eq!(check_version("1.52.0\n"), None);
        assert_eq!(check_version("1.76.1-t1234\n  go version: go1.23\n"), None);
        assert_eq!(check_version("unknown"), None);
    }
}
