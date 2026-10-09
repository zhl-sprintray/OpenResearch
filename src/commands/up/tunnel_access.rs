//! Turning Tunnel access on and off: the tunnel provider that publishes the
//! Tunnel port, the persisted setting, the single-instance lock, and the
//! original-port endpoints the desktop dashboard drives them with.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use serde::{Deserialize, Serialize};

use super::tunnel::{open_tunnel_port, TunnelOrigin, TunnelPort};
use super::{ApiError, AppState};
use crate::commands::remote_host::DashboardLock;
use crate::error::{anyhow, Result};
use axum::extract::State;
use axum::http::StatusCode;
use axum::Json;

/// What a provider reports before it is started.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) enum Availability {
    NotInstalled {
        message: String,
    },
    LoggedOut {
        message: String,
    },
    /// Installed and logged in, but unusable as is (daemon down, too old,
    /// HTTPS certificates off).
    Unavailable {
        message: String,
    },
    /// The user's own configuration already serves the port we would take.
    Conflict {
        message: String,
    },
    Ready {
        origin: String,
    },
}

/// A tunnel program that publishes a loopback port at a public https origin.
#[async_trait]
pub(super) trait TunnelProvider: Send + Sync {
    async fn check(&self) -> Availability;
    /// Starts publishing `port`; the returned child stops publishing when
    /// stopped or dropped.
    async fn start(&self, port: u16) -> Result<Box<dyn ProviderChild>>;
}

/// A running provider process.
#[async_trait]
pub(super) trait ProviderChild: Send {
    /// Resolves with a reason when the process exits on its own. Cancel-safe.
    async fn exited(&mut self) -> String;
    async fn stop(self: Box<Self>);
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub(super) enum ProviderState {
    NotInstalled,
    LoggedOut,
    Unavailable,
    Conflict,
    Ready,
    Connected,
    Disconnected,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct TunnelStatus {
    pub(super) enabled: bool,
    pub(super) provider: &'static str,
    pub(super) state: ProviderState,
    pub(super) origin: Option<String>,
    pub(super) message: Option<String>,
    /// Why this dashboard can never turn Tunnel access on.
    pub(super) blocked: Option<Blocked>,
}

/// Dashboards that refuse Tunnel access outright.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub(super) enum Blocked {
    /// This `orx up` serves an SSH workspace (Remote).
    Remote,
    /// A development slot, which must never be exposed.
    DevSlot,
}

impl Blocked {
    fn explanation(self) -> &'static str {
        match self {
            Self::Remote => {
                "Tunnel access is unavailable while the dashboard is connected to an SSH workspace."
            }
            Self::DevSlot => "Tunnel access is always off in a dev slot.",
        }
    }
}

/// Turns Tunnel access on and off for this `orx up`.
#[derive(Clone)]
pub(super) struct TunnelAccessControl {
    inner: Arc<Inner>,
}

struct Inner {
    provider: Arc<dyn TunnelProvider>,
    config_dir: PathBuf,
    backoff: Backoff,
    /// How another instance's refusal names this one.
    holder: String,
    blocked: Option<Blocked>,
    /// The running session; the async lock serializes enable and disable.
    session: tokio::sync::Mutex<Option<Session>>,
}

/// Tunnel access while on: the Tunnel port and the supervised provider.
struct Session {
    origin: String,
    live: Arc<std::sync::Mutex<Live>>,
    stop: tokio::sync::oneshot::Sender<()>,
    supervisor: tokio::task::JoinHandle<()>,
    _port: TunnelPort,
    _lock: DashboardLock,
}

impl Session {
    /// Stops the provider, then the Tunnel port.
    async fn stop(self) {
        let _ = self.stop.send(());
        let _ = self.supervisor.await;
    }
}

/// The provider process as last observed by the supervisor.
#[derive(Clone)]
enum Live {
    Connected,
    Disconnected { reason: String },
}

/// Restart delays after the provider exits on its own: doubling from
/// `initial` up to `max`, back to `initial` once a child stayed up `stable`.
#[derive(Clone, Copy)]
pub(super) struct Backoff {
    pub(super) initial: Duration,
    pub(super) max: Duration,
    pub(super) stable: Duration,
}

impl Default for Backoff {
    fn default() -> Self {
        Self {
            initial: Duration::from_secs(1),
            max: Duration::from_secs(60),
            stable: Duration::from_secs(60),
        }
    }
}

impl TunnelAccessControl {
    pub(super) fn new(provider: Arc<dyn TunnelProvider>, config_dir: PathBuf) -> Self {
        Self::with_backoff(provider, config_dir, Backoff::default())
    }

    fn with_backoff(
        provider: Arc<dyn TunnelProvider>,
        config_dir: PathBuf,
        backoff: Backoff,
    ) -> Self {
        Self {
            inner: Arc::new(Inner {
                provider,
                config_dir,
                backoff,
                holder: "another OpenResearch instance".into(),
                blocked: None,
                session: tokio::sync::Mutex::new(None),
            }),
        }
    }

    /// Names this instance to another one that finds Tunnel access taken.
    pub(super) fn held_by(mut self, holder: impl Into<String>) -> Self {
        Arc::get_mut(&mut self.inner)
            .expect("configured before it is shared")
            .holder = holder.into();
        self
    }

    /// Refuses Tunnel access for this whole run.
    pub(super) fn blocked(mut self, blocked: Blocked) -> Self {
        Arc::get_mut(&mut self.inner)
            .expect("configured before it is shared")
            .blocked = Some(blocked);
        self
    }

    pub(super) async fn status(&self) -> TunnelStatus {
        if let Some(blocked) = self.inner.blocked {
            return TunnelStatus {
                enabled: false,
                provider: PROVIDER_NAME,
                state: ProviderState::Unavailable,
                origin: None,
                message: Some(blocked.explanation().into()),
                blocked: Some(blocked),
            };
        }
        if let Some(session) = self.inner.session.lock().await.as_ref() {
            let live = session.live.lock().unwrap().clone();
            let (state, message) = match live {
                Live::Connected => (ProviderState::Connected, None),
                Live::Disconnected { reason } => (ProviderState::Disconnected, Some(reason)),
            };
            return TunnelStatus {
                enabled: true,
                provider: PROVIDER_NAME,
                state,
                origin: Some(session.origin.clone()),
                message,
                blocked: None,
            };
        }
        idle_status(&self.inner.provider.check().await)
    }

    /// Turns Tunnel access on and remembers it for later starts.
    pub(super) async fn enable(&self, state: &AppState) -> Result<TunnelStatus> {
        self.turn_on(state).await?;
        save_enabled(&self.inner.config_dir, true)?;
        Ok(self.status().await)
    }

    /// Turns Tunnel access off and remembers it for later starts.
    pub(super) async fn disable(&self) -> Result<TunnelStatus> {
        self.turn_off().await;
        save_enabled(&self.inner.config_dir, false)?;
        Ok(self.status().await)
    }

    /// At startup: turns Tunnel access back on if it was on, or as
    /// `override_enabled` says for this run without changing the saved setting.
    pub(super) async fn restore(&self, state: &AppState, override_enabled: Option<bool>) {
        if self.inner.blocked.is_some()
            || !override_enabled.unwrap_or_else(|| saved_enabled(&self.inner.config_dir))
        {
            return;
        }
        match self.turn_on(state).await {
            Ok(()) => {
                if let Some(origin) = self.status().await.origin {
                    eprintln!("orx up: Tunnel access on at {origin}");
                }
            }
            Err(error) => eprintln!("orx up: could not turn on Tunnel access: {error}"),
        }
    }

    /// At exit: stops publishing without changing the saved setting.
    pub(super) async fn shutdown(&self) {
        self.turn_off().await;
    }

    async fn turn_on(&self, state: &AppState) -> Result<()> {
        if let Some(blocked) = self.inner.blocked {
            return Err(anyhow!("{}", blocked.explanation()));
        }
        let mut session = self.inner.session.lock().await;
        if session.is_none() {
            *session = Some(self.start(state).await?);
        }
        Ok(())
    }

    async fn turn_off(&self) {
        let session = self.inner.session.lock().await.take();
        if let Some(session) = session {
            session.stop().await;
        }
    }

    async fn start(&self, state: &AppState) -> Result<Session> {
        let origin = match self.inner.provider.check().await {
            Availability::Ready { origin } => origin,
            unavailable => {
                return Err(anyhow!(
                    "{}",
                    idle_status(&unavailable).message.unwrap_or_default()
                ))
            }
        };
        let lock = self.lock()?;
        let port = open_tunnel_port(state.clone(), TunnelOrigin::new(&origin)?).await?;
        let child = self.inner.provider.start(port.port()).await?;
        let live = Arc::new(std::sync::Mutex::new(Live::Connected));
        let (stop, stopped) = tokio::sync::oneshot::channel();
        let supervisor = tokio::spawn(supervise(
            self.inner.provider.clone(),
            port.port(),
            origin.clone(),
            child,
            live.clone(),
            self.inner.backoff,
            stopped,
        ));
        Ok(Session {
            origin,
            live,
            stop,
            supervisor,
            _port: port,
            _lock: lock,
        })
    }

    /// One instance per user publishes at a time: the provider's public port
    /// and address belong to the whole machine.
    fn lock(&self) -> Result<DashboardLock> {
        let config_dir = &self.inner.config_dir;
        let holder_path = config_dir.join(HOLDER_FILE);
        match DashboardLock::try_exclusive_at(&config_dir.join(LOCK_FILE))? {
            Some(lock) => {
                crate::local::git::atomic_write_with_mode(
                    &holder_path,
                    self.inner.holder.as_bytes(),
                    Some(0o600),
                )?;
                Ok(lock)
            }
            None => {
                let holder = std::fs::read_to_string(&holder_path)
                    .ok()
                    .map(|holder| holder.trim().to_string())
                    .filter(|holder| !holder.is_empty())
                    .unwrap_or_else(|| "another OpenResearch instance".into());
                Err(anyhow!(
                    "Tunnel access is already on in {holder}. Turn it off there first."
                ))
            }
        }
    }
}

const LOCK_FILE: &str = "tunnel-access.lock";
/// Who holds `LOCK_FILE`, kept beside it so the lock itself stays unread.
const HOLDER_FILE: &str = "tunnel-access.holder";

impl TunnelAccessControl {}

/// Keeps the provider publishing `port`: reports an unexpected exit as
/// disconnected and restarts it with backoff until told to stop.
async fn supervise(
    provider: Arc<dyn TunnelProvider>,
    port: u16,
    origin: String,
    mut child: Box<dyn ProviderChild>,
    live: Arc<std::sync::Mutex<Live>>,
    backoff: Backoff,
    mut stop: tokio::sync::oneshot::Receiver<()>,
) {
    let mut delay = backoff.initial;
    loop {
        let started = tokio::time::Instant::now();
        let reason = tokio::select! {
            reason = child.exited() => reason,
            _ = &mut stop => {
                child.stop().await;
                return;
            }
        };
        eprintln!("orx up: the Tunnel access provider exited: {reason}");
        *live.lock().unwrap() = Live::Disconnected { reason };
        if started.elapsed() >= backoff.stable {
            delay = backoff.initial;
        }
        child = loop {
            tokio::select! {
                _ = tokio::time::sleep(delay) => {}
                _ = &mut stop => return,
            }
            delay = (delay * 2).min(backoff.max);
            match restart(provider.as_ref(), port, &origin).await {
                Ok(child) => break child,
                Err(reason) => {
                    eprintln!("orx up: could not restart Tunnel access: {reason}");
                    *live.lock().unwrap() = Live::Disconnected { reason };
                }
            }
        };
        *live.lock().unwrap() = Live::Connected;
    }
}

/// Starts the provider again, unless it can no longer publish at `origin`
/// (logged out, the user took the port, the machine was renamed).
async fn restart(
    provider: &dyn TunnelProvider,
    port: u16,
    origin: &str,
) -> std::result::Result<Box<dyn ProviderChild>, String> {
    match provider.check().await {
        Availability::Ready { origin: current } if current == origin => {}
        Availability::Ready { origin: current } => {
            return Err(format!(
                "The tunnel address changed from {origin} to {current}. Turn Tunnel access off and on again."
            ))
        }
        unavailable => return Err(idle_status(&unavailable).message.unwrap_or_default()),
    }
    provider
        .start(port)
        .await
        .map_err(|error| error.to_string())
}

/// The saved setting, `<config dir>/tunnel-access.json`. Off unless saved on.
#[derive(Default, Serialize, Deserialize)]
struct Settings {
    enabled: bool,
}

const SETTINGS_FILE: &str = "tunnel-access.json";

fn saved_enabled(config_dir: &Path) -> bool {
    std::fs::read_to_string(config_dir.join(SETTINGS_FILE))
        .ok()
        .and_then(|raw| serde_json::from_str::<Settings>(&raw).ok())
        .unwrap_or_default()
        .enabled
}

/// Written owner-only, like the other files in the config directory.
fn save_enabled(config_dir: &Path, enabled: bool) -> Result<()> {
    std::fs::create_dir_all(config_dir)?;
    let body = format!("{}\n", serde_json::to_string_pretty(&Settings { enabled })?);
    crate::local::git::atomic_write_with_mode(
        &config_dir.join(SETTINGS_FILE),
        body.as_bytes(),
        Some(0o600),
    )?;
    Ok(())
}

/// Status while Tunnel access is off: what the provider would do if asked.
fn idle_status(availability: &Availability) -> TunnelStatus {
    let (state, origin, message) = match availability {
        Availability::NotInstalled { message } => {
            (ProviderState::NotInstalled, None, Some(message))
        }
        Availability::LoggedOut { message } => (ProviderState::LoggedOut, None, Some(message)),
        Availability::Unavailable { message } => (ProviderState::Unavailable, None, Some(message)),
        Availability::Conflict { message } => (ProviderState::Conflict, None, Some(message)),
        Availability::Ready { origin } => (ProviderState::Ready, Some(origin.clone()), None),
    };
    TunnelStatus {
        enabled: false,
        provider: PROVIDER_NAME,
        state,
        origin,
        message: message.cloned(),
        blocked: None,
    }
}

const PROVIDER_NAME: &str = "tailscale";

/// `GET /api/tunnel/access` (original port only): whether Tunnel access is
/// on, and what the provider reports.
pub(super) async fn get_tunnel_access(State(state): State<AppState>) -> Json<TunnelStatus> {
    Json(state.tunnel_access.status().await)
}

#[derive(Deserialize)]
pub(super) struct SetTunnelAccess {
    enabled: bool,
}

/// `PUT /api/tunnel/access` (original port only): turns Tunnel access on or
/// off and saves the choice. A refusal is a 409 carrying the reason.
pub(super) async fn set_tunnel_access(
    State(state): State<AppState>,
    Json(request): Json<SetTunnelAccess>,
) -> std::result::Result<Json<TunnelStatus>, ApiError> {
    let control = state.tunnel_access.clone();
    let status = if request.enabled {
        control
            .enable(&state)
            .await
            .map_err(|error| ApiError(StatusCode::CONFLICT, error.to_string()))?
    } else {
        control.disable().await?
    };
    Ok(Json(status))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    /// A provider whose availability and child exits the test controls.
    #[derive(Default)]
    struct FakeProvider {
        availability: Mutex<Option<Availability>>,
        /// The port each start published, in order.
        started: Mutex<Vec<u16>>,
        /// Makes the running child exit with a reason.
        exits: Mutex<Vec<tokio::sync::oneshot::Sender<String>>>,
        stopped: Arc<std::sync::atomic::AtomicUsize>,
    }

    impl FakeProvider {
        fn with(availability: Availability) -> Arc<Self> {
            Arc::new(Self {
                availability: Mutex::new(Some(availability)),
                ..Self::default()
            })
        }

        fn ready() -> Arc<Self> {
            Arc::new(Self::default())
        }

        fn starts(&self) -> Vec<u16> {
            self.started.lock().unwrap().clone()
        }

        fn stops(&self) -> usize {
            self.stopped.load(std::sync::atomic::Ordering::SeqCst)
        }

        fn exit_child(&self, reason: &str) {
            let exit = self.exits.lock().unwrap().pop().expect("a running child");
            exit.send(reason.into()).unwrap();
        }
    }

    #[async_trait]
    impl TunnelProvider for FakeProvider {
        async fn check(&self) -> Availability {
            self.availability
                .lock()
                .unwrap()
                .clone()
                .unwrap_or(Availability::Ready {
                    origin: ORIGIN.into(),
                })
        }

        async fn start(&self, port: u16) -> Result<Box<dyn ProviderChild>> {
            self.started.lock().unwrap().push(port);
            let (exit, exited) = tokio::sync::oneshot::channel();
            self.exits.lock().unwrap().push(exit);
            Ok(Box::new(FakeChild {
                exited,
                stopped: self.stopped.clone(),
            }))
        }
    }

    struct FakeChild {
        exited: tokio::sync::oneshot::Receiver<String>,
        stopped: Arc<std::sync::atomic::AtomicUsize>,
    }

    #[async_trait]
    impl ProviderChild for FakeChild {
        async fn exited(&mut self) -> String {
            match (&mut self.exited).await {
                Ok(reason) => reason,
                Err(_) => std::future::pending().await,
            }
        }

        async fn stop(self: Box<Self>) {
            self.stopped
                .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        }
    }

    const ORIGIN: &str = "https://laptop.example.ts.net";

    fn temp_config_dir() -> PathBuf {
        std::env::temp_dir().join(format!("orx-tunnel-access-{}", uuid::Uuid::new_v4()))
    }

    fn control(provider: Arc<FakeProvider>) -> TunnelAccessControl {
        TunnelAccessControl::new(provider, temp_config_dir())
    }

    fn state() -> AppState {
        super::super::tests::test_state()
    }

    #[tokio::test]
    async fn enabling_an_unavailable_provider_explains_why() {
        for (availability, expected) in [
            (
                Availability::NotInstalled {
                    message: "Install Tailscale".into(),
                },
                ProviderState::NotInstalled,
            ),
            (
                Availability::LoggedOut {
                    message: "Log in to Tailscale".into(),
                },
                ProviderState::LoggedOut,
            ),
            (
                Availability::Conflict {
                    message: "Your Tailscale serve config already uses port 443".into(),
                },
                ProviderState::Conflict,
            ),
        ] {
            let provider = FakeProvider::with(availability.clone());
            let control = control(provider.clone());
            let error = control.enable(&state()).await.unwrap_err();
            let status = control.status().await;
            let message = status.message.clone().unwrap();
            assert!(error.to_string().contains(&message), "{error}");
            assert!(!status.enabled);
            assert_eq!(status.state, expected);
            assert!(provider.starts().is_empty(), "{availability:?} started");
        }
    }

    #[tokio::test]
    async fn enabling_publishes_the_tunnel_port_at_the_provider_origin() {
        let provider = FakeProvider::ready();
        let control = control(provider.clone());
        let status = control.enable(&state()).await.unwrap();
        assert!(status.enabled);
        assert_eq!(status.state, ProviderState::Connected);
        assert_eq!(status.origin.as_deref(), Some(ORIGIN));
        let [port] = provider.starts()[..] else {
            panic!("expected one start, got {:?}", provider.starts());
        };
        let pair_page = crate::net::loopback_client()
            .build()
            .unwrap()
            .get(format!("http://127.0.0.1:{port}/pair"))
            .send()
            .await
            .unwrap();
        assert_eq!(pair_page.status(), 200);
        assert_eq!(control.status().await.state, ProviderState::Connected);
    }

    fn quick_backoff() -> Backoff {
        Backoff {
            initial: Duration::from_millis(150),
            max: Duration::from_millis(300),
            stable: Duration::from_secs(60),
        }
    }

    /// Polls `check` until it holds, failing after a few seconds.
    async fn eventually(mut check: impl FnMut() -> bool) {
        for _ in 0..200 {
            if check() {
                return;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        panic!("condition never held");
    }

    #[tokio::test]
    async fn a_provider_that_exits_is_reported_disconnected_then_restarted() {
        let provider = FakeProvider::ready();
        let control =
            TunnelAccessControl::with_backoff(provider.clone(), temp_config_dir(), quick_backoff());
        control.enable(&state()).await.unwrap();
        provider.exit_child("tailscaled restarted");

        let mut status = control.status().await;
        for _ in 0..50 {
            if status.state == ProviderState::Disconnected {
                break;
            }
            tokio::time::sleep(Duration::from_millis(2)).await;
            status = control.status().await;
        }
        assert_eq!(status.state, ProviderState::Disconnected);
        assert_eq!(status.message.as_deref(), Some("tailscaled restarted"));
        assert!(status.enabled);

        eventually(|| provider.starts().len() == 2).await;
        let starts = provider.starts();
        assert_eq!(
            starts[0], starts[1],
            "restarts publish the same Tunnel port"
        );
        assert_eq!(control.status().await.state, ProviderState::Connected);
    }

    #[tokio::test]
    async fn disabling_stops_the_provider_and_closes_the_tunnel_port() {
        let provider = FakeProvider::ready();
        let control = control(provider.clone());
        control.enable(&state()).await.unwrap();
        let port = provider.starts()[0];

        let status = control.disable().await.unwrap();
        assert!(!status.enabled);
        assert_eq!(status.state, ProviderState::Ready);
        assert_eq!(provider.stops(), 1);
        let closed = crate::net::loopback_client()
            .build()
            .unwrap()
            .get(format!("http://127.0.0.1:{port}/pair"))
            .send()
            .await;
        assert!(closed.is_err(), "the Tunnel port still answers");
    }

    #[tokio::test]
    async fn the_enabled_setting_is_restored_on_the_next_start() {
        let config_dir = temp_config_dir();
        let first = TunnelAccessControl::new(FakeProvider::ready(), config_dir.clone());
        first.enable(&state()).await.unwrap();
        first.shutdown().await;

        let provider = FakeProvider::ready();
        let restarted = TunnelAccessControl::new(provider.clone(), config_dir.clone());
        restarted.restore(&state(), None).await;
        assert!(restarted.status().await.enabled);
        assert_eq!(provider.starts().len(), 1);
        restarted.disable().await.unwrap();

        let after_disable = TunnelAccessControl::new(FakeProvider::ready(), config_dir);
        after_disable.restore(&state(), None).await;
        assert!(!after_disable.status().await.enabled);
    }

    #[tokio::test]
    async fn the_startup_override_applies_to_one_run_only() {
        let config_dir = temp_config_dir();
        let forced_on = TunnelAccessControl::new(FakeProvider::ready(), config_dir.clone());
        forced_on.restore(&state(), Some(true)).await;
        assert!(forced_on.status().await.enabled);
        forced_on.shutdown().await;

        let next_run = TunnelAccessControl::new(FakeProvider::ready(), config_dir.clone());
        next_run.restore(&state(), None).await;
        assert!(!next_run.status().await.enabled);
        next_run.enable(&state()).await.unwrap();
        next_run.shutdown().await;

        let forced_off = TunnelAccessControl::new(FakeProvider::ready(), config_dir.clone());
        forced_off.restore(&state(), Some(false)).await;
        assert!(!forced_off.status().await.enabled);

        let after = TunnelAccessControl::new(FakeProvider::ready(), config_dir);
        after.restore(&state(), None).await;
        assert!(
            after.status().await.enabled,
            "the override changed the saved setting"
        );
    }

    #[tokio::test]
    async fn only_one_instance_can_have_tunnel_access_on() {
        let config_dir = temp_config_dir();
        let first = TunnelAccessControl::new(FakeProvider::ready(), config_dir.clone())
            .held_by("the desktop app (dashboard http://127.0.0.1:4792)");
        first.enable(&state()).await.unwrap();

        let provider = FakeProvider::ready();
        let second = TunnelAccessControl::new(provider.clone(), config_dir.clone())
            .held_by("orx up (dashboard http://127.0.0.1:4791)");
        let error = second.enable(&state()).await.unwrap_err().to_string();
        assert!(
            error.contains("the desktop app (dashboard http://127.0.0.1:4792)"),
            "{error}"
        );
        assert!(provider.starts().is_empty());
        assert!(!second.status().await.enabled);

        first.disable().await.unwrap();
        second.enable(&state()).await.unwrap();
        assert!(second.status().await.enabled);
    }

    #[tokio::test]
    async fn remote_and_dev_slot_dashboards_refuse_tunnel_access() {
        for (blocked, explanation) in [
            (Blocked::Remote, "SSH workspace"),
            (Blocked::DevSlot, "dev slot"),
        ] {
            let config_dir = temp_config_dir();
            save_enabled(&config_dir, true).unwrap();
            let provider = FakeProvider::ready();
            let control = TunnelAccessControl::new(provider.clone(), config_dir).blocked(blocked);

            control.restore(&state(), Some(true)).await;
            let error = control.enable(&state()).await.unwrap_err().to_string();
            assert!(error.contains(explanation), "{error}");
            let status = control.status().await;
            assert!(!status.enabled);
            assert_eq!(status.blocked, Some(blocked));
            assert!(provider.starts().is_empty());
        }
    }

    /// The original port's router over `state`, served on 127.0.0.1:0.
    async fn dashboard(state: AppState) -> String {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let app = super::super::router(state, None);
        tokio::spawn(async move { axum::serve(listener, app).await });
        url
    }

    #[tokio::test]
    async fn the_desktop_dashboard_reads_and_switches_tunnel_access() {
        let provider = FakeProvider::ready();
        let mut state = state();
        state.tunnel_access = control(provider.clone());
        let url = dashboard(state).await;
        let client = crate::net::loopback_client().build().unwrap();
        let endpoint = format!("{url}/api/tunnel/access");

        let status: serde_json::Value = client
            .get(&endpoint)
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(status["enabled"], false);
        assert_eq!(status["state"], "ready");
        assert_eq!(status["origin"], ORIGIN);

        let enabled: serde_json::Value = client
            .put(&endpoint)
            .json(&serde_json::json!({ "enabled": true }))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(enabled["enabled"], true);
        assert_eq!(enabled["state"], "connected");
        assert_eq!(provider.starts().len(), 1);

        let disabled = client
            .put(&endpoint)
            .json(&serde_json::json!({ "enabled": false }))
            .send()
            .await
            .unwrap();
        assert_eq!(disabled.status(), 200);
        assert_eq!(provider.stops(), 1);
    }

    #[tokio::test]
    async fn a_refused_enable_answers_with_the_reason() {
        let mut state = state();
        state.tunnel_access = control(FakeProvider::with(Availability::LoggedOut {
            message: "Log in to Tailscale".into(),
        }));
        let url = dashboard(state).await;
        let response = crate::net::loopback_client()
            .build()
            .unwrap()
            .put(format!("{url}/api/tunnel/access"))
            .json(&serde_json::json!({ "enabled": true }))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), 409);
        let body: serde_json::Value = response.json().await.unwrap();
        assert_eq!(body["error"], "Log in to Tailscale");
    }
}
