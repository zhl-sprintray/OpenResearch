//! The Tunnel port: a second loopback listener over the same `AppState`,
//! opened only while Tunnel access is on. Every request on it is Tunnel access
//! (ADR 0001) — decided by the listener, never by Host or forwarding headers.

use std::sync::Arc;

use axum::extract::{MatchedPath, Request, State};
use axum::http::{header, Method, StatusCode};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::Router;

use super::devices::{self, PAIR_PAGE_PATH, PAIR_REDEEM_PATH};
use super::{app, track_active, ApiError, AppState};
use crate::commands::up_remote::secure_response;
use crate::error::{anyhow, Result};

/// The Tunnel port's router: the dashboard's routes behind the Tunnel guards,
/// outermost first: secure headers, Origin, device authentication, route
/// allowlist, Tunnel access marker.
fn tunnel_router(state: AppState, origin: TunnelOrigin) -> Router {
    let devices = state.tunnel_devices.clone();
    app(state.clone())
        .merge(devices::pairing_routes().with_state(state))
        .route_layer(middleware::from_fn(mark_tunnel_access))
        .route_layer(middleware::from_fn(require_allowed_route))
        .layer(middleware::from_fn(track_active))
        .layer(middleware::from_fn_with_state(
            devices,
            devices::authenticate,
        ))
        .layer(middleware::from_fn_with_state(
            origin,
            require_tunnel_origin,
        ))
        .layer(middleware::from_fn(secure_headers))
}

/// Present in a request's extensions when it arrived on the Tunnel port, so
/// handlers can narrow what Tunnel access may do.
#[derive(Clone, Copy, Debug)]
pub(super) struct TunnelAccess;

async fn mark_tunnel_access(mut request: Request, next: Next) -> Response {
    request.extensions_mut().insert(TunnelAccess);
    next.run(request).await
}

/// Refuses every route `classify` does not allow — including routes nobody
/// classified yet, so a new route fails closed (ADR 0001).
async fn require_allowed_route(request: Request, next: Next) -> Response {
    let route = request
        .extensions()
        .get::<MatchedPath>()
        .map(|matched| matched.as_str());
    match route.and_then(|route| classify(request.method(), route)) {
        Some(TunnelRoute::Allow) => next.run(request).await,
        Some(TunnelRoute::Deny) | None => ApiError(
            StatusCode::FORBIDDEN,
            "This action is unavailable over Tunnel access.".into(),
        )
        .into_response(),
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum TunnelRoute {
    Allow,
    Deny,
}

/// The Tunnel access allowlist: every registered route, by method and matched
/// path, is explicitly allowed or denied. `None` means unclassified, which is
/// refused at runtime and fails the completeness test.
fn classify(method: &Method, route: &str) -> Option<TunnelRoute> {
    use TunnelRoute::{Allow, Deny};
    match (method, route) {
        // Pairing, on the Tunnel port only.
        (&Method::GET | &Method::HEAD, PAIR_PAGE_PATH) | (&Method::POST, PAIR_REDEEM_PATH) => {
            Some(Allow)
        }
        (_, PAIR_PAGE_PATH | PAIR_REDEEM_PATH) => Some(Deny),
        // Browsing.
        (
            _,
            "/api/health"
            | "/_orx/runtime"
            | "/api/events"
            | "/api/projects"
            | "/api/projects/activity"
            | "/api/projects/{id}"
            | "/api/projects/{id}/experiments"
            | "/api/projects/{id}/runs"
            | "/api/runs"
            | "/api/runs/{id}"
            | "/api/runs/{id}/log"
            | "/api/runs/{id}/logs"
            | "/api/runs/{id}/diff"
            | "/api/experiments/{id}/diff"
            | "/api/experiments/{id}/archive"
            | "/api/experiments/{id}/commits"
            | "/api/experiments/{id}/commits/{sha}/diff"
            | "/api/projects/{id}/files"
            | "/api/projects/{id}/files/file"
            | "/api/skills"
            | "/api/skills/{name}"
            | "/api/harnesses"
            | "/api/harnesses/{id}/snapshot"
            | "/api/agent/status",
        ) => Some(Deny),
        // Chat.
        (
            _,
            "/api/chat/sessions"
            | "/api/chat/sessions/{id}"
            | "/api/chat/sessions/{id}/messages"
            | "/api/chat/sessions/{id}/message"
            | "/api/chat/sessions/{id}/interrupt"
            | "/api/chat/sessions/{id}/respond"
            | "/api/chat/sessions/{id}/queue/{itemId}"
            | "/api/chat/attachments/{name}"
            | "/api/chat/sessions/{id}/worktree"
            | "/api/chat/sessions/{id}/compact"
            | "/api/chat/sessions/{id}/turns/{turnId}/recover"
            | "/api/chat/sessions/{id}/side"
            | "/api/chat/sessions/{id}/fork"
            | "/api/chat/sessions/{id}/branch"
            | "/api/chat/native-sessions"
            | "/api/chat/native-sessions/import",
        ) => Some(Deny),
        // Runs.
        (_, "/api/runs/{id}/cancel" | "/api/instances" | "/api/compute/backends") => Some(Deny),
        // Never over Tunnel access: shells, terminals, arbitrary files,
        // credentials and settings, installs and updates, project lifecycle.
        (
            _,
            "/api/chat/sessions/{id}/shell"
            | "/api/projects/{id}/terminal"
            | "/api/files/abs"
            | "/api/files/abs/raw"
            | "/api/projects/{id}/file"
            | "/api/projects/{id}/file/raw"
            | "/api/projects/{id}/file/open"
            | "/api/projects/{id}/file/reveal"
            | "/api/projects/{id}/file/latex"
            | "/api/projects/{id}/file/overleaf"
            | "/api/projects/{id}/file/overleaf/sync"
            | "/api/projects/{id}/file/overleaf/status"
            | "/api/projects/{id}/file/overleaf/upload"
            | "/api/projects/{id}/file/overleaf/live"
            | "/api/projects/{id}/working-tree"
            | "/api/projects/{id}/code-tree"
            | "/api/projects/{id}/open"
            | "/api/projects/{id}/git"
            | "/api/projects/{id}/git/init"
            | "/api/projects/{id}/github"
            | "/api/projects/{id}/github/disable"
            | "/api/projects/{id}/github/push"
            | "/api/projects/{id}/starter-prompts"
            | "/api/projects/{id}/ui-state"
            | "/api/projects/starter-prompts/prewarm"
            | "/api/project-path/status"
            | "/api/project-path/pick"
            | "/api/onboarding/complete"
            | "/api/git/install"
            | "/api/github/account"
            | "/api/github/project-repo-preview"
            | "/api/github/repo-access"
            | "/api/papers/search"
            | "/api/papers/resolve"
            | "/api/latex/engine"
            | "/api/overleaf/settings"
            | "/api/overleaf/token"
            | "/api/overleaf/session"
            | "/api/overleaf/session/import"
            | "/api/settings/hf"
            | "/api/settings/tinker"
            | "/api/settings/k8s"
            | "/api/settings/modal"
            | "/api/settings/env"
            | "/api/settings/env/{key}"
            | "/api/settings/data-dir"
            | "/api/settings/data-dir/validate"
            | "/api/settings/data-dir/move"
            | "/api/settings/git"
            | "/api/settings/projects"
            | "/api/settings/telemetry"
            | "/api/settings/profile"
            | "/api/settings/ui-state"
            | "/api/settings/ssh"
            | "/api/settings/ssh/config"
            | "/api/settings/ssh/default"
            | "/api/settings/ssh/master"
            | "/api/settings/ssh/preflight"
            | "/api/settings/ssh/connect"
            | "/api/settings/slurm"
            | "/api/settings/slurm/preflight"
            | "/api/settings/ray"
            | "/api/settings/ray/preflight"
            | "/api/settings/compute"
            | "/api/settings/compute/default"
            | "/api/settings/local"
            | "/api/settings/openresearch"
            | "/api/settings/openresearch/login"
            | "/api/settings/openresearch/ssh-key"
            | "/api/settings/commands/run"
            | "/api/settings/lit-sources"
            | "/api/telemetry/event"
            | "/api/telemetry/locale"
            | "/api/update"
            | "/api/update/apply"
            | "/api/update/restart"
            | "/api/update/auto"
            | "/api/update/install-cli"
            | "/api/remote/sessions"
            | "/api/remote/sessions/{id}"
            | "/api/remote/sessions/{id}/reconnect"
            | "/api/remote/sessions/{id}/disconnect"
            | "/api/harnesses/setup"
            | "/api/harnesses/setup/commands"
            | "/api/local-models"
            | "/api/local-models/discover"
            | "/api/local-models/{id}/check"
            | "/api/local-models/{id}"
            | "/api/user-skills"
            | "/api/latex-templates"
            | "/api/internal/permissions"
            // Pairing codes and the device list are managed from this computer.
            | "/api/tunnel/pairing-codes"
            | "/api/tunnel/devices"
            | "/api/tunnel/devices/{id}",
        ) => Some(Deny),
        _ => None,
    }
}

/// The tunnel's public https origin, e.g. `https://laptop.tailnet.ts.net`.
#[derive(Clone)]
pub(super) struct TunnelOrigin(Arc<str>);

impl TunnelOrigin {
    pub(super) fn new(origin: &str) -> Result<Self> {
        let url = reqwest::Url::parse(origin)
            .map_err(|error| anyhow!("Invalid tunnel origin {origin:?}: {error}"))?;
        if url.scheme() != "https" || url.host_str().is_none() {
            return Err(anyhow!(
                "The tunnel origin must be an https URL, got {origin:?}"
            ));
        }
        Ok(Self(url.origin().ascii_serialization().into()))
    }
}

async fn secure_headers(request: Request, next: Next) -> Response {
    secure_response(next.run(request).await)
}

/// Unsafe and WebSocket requests must come from the tunnel's own page. Unlike
/// the original port, a missing Origin is refused too.
async fn require_tunnel_origin(
    State(origin): State<TunnelOrigin>,
    request: Request,
    next: Next,
) -> Response {
    let websocket = request
        .headers()
        .get(header::UPGRADE)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| value.eq_ignore_ascii_case("websocket"));
    let unsafe_method = !matches!(
        *request.method(),
        Method::GET | Method::HEAD | Method::OPTIONS
    );
    let matches = request
        .headers()
        .get(header::ORIGIN)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| value == &*origin.0);
    if (unsafe_method || websocket) && !matches {
        return ApiError(StatusCode::FORBIDDEN, "Invalid Origin header.".into()).into_response();
    }
    next.run(request).await
}

/// Headers tunnels and reverse proxies add (Tailscale serve, cloudflared,
/// ngrok, nginx). Nothing local sends them: the desktop webview and browsers
/// talk to 127.0.0.1 directly, the Vite dev proxy runs without `xfwd`, and the
/// Remote gateway strips them before forwarding.
const TUNNEL_PROXY_HEADERS: &[&str] = &[
    "forwarded",
    "x-forwarded-for",
    "x-forwarded-host",
    "x-forwarded-proto",
    "x-real-ip",
    "cf-connecting-ip",
    "tailscale-user-login",
    "tailscale-user-name",
];

/// Original-port guard: a tunnel aimed at the wrong listener fails loudly
/// instead of handing a public URL full, unauthenticated local access.
pub(super) async fn reject_tunnel_proxy_headers(request: Request, next: Next) -> Response {
    let forwarded = TUNNEL_PROXY_HEADERS
        .iter()
        .find(|name| request.headers().contains_key(**name));
    if let Some(name) = forwarded {
        return ApiError(
            StatusCode::MISDIRECTED_REQUEST,
            format!(
                "This request came through a tunnel or proxy ({name} header), but this port only \
                 serves this computer. Point the tunnel at the Tunnel port instead."
            ),
        )
        .into_response();
    }
    next.run(request).await
}

/// A running Tunnel port listener. Dropping it stops serving.
pub(super) struct TunnelPort {
    port: u16,
    server: tokio::task::JoinHandle<()>,
}

impl TunnelPort {
    pub(super) fn port(&self) -> u16 {
        self.port
    }
}

impl Drop for TunnelPort {
    fn drop(&mut self) {
        self.server.abort();
    }
}

/// Opens the Tunnel port on 127.0.0.1 with a random port, sharing `state`
/// with the original listener.
pub(super) async fn open_tunnel_port(state: AppState, origin: TunnelOrigin) -> Result<TunnelPort> {
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
        .await
        .map_err(|error| anyhow!("Could not open the Tunnel port: {error}"))?;
    let port = listener.local_addr()?.port();
    let app = tunnel_router(state, origin);
    let server = tokio::spawn(async move {
        if let Err(error) = axum::serve(listener, app).await {
            eprintln!("orx up: Tunnel port stopped: {error}");
        }
    });
    Ok(TunnelPort { port, server })
}

#[cfg(test)]
mod tests {
    use super::*;

    const TUNNEL_ORIGIN: &str = "https://laptop.example.ts.net";

    async fn tunnel_port() -> TunnelPort {
        open_tunnel_port(
            super::super::tests::test_state(),
            TunnelOrigin::new(TUNNEL_ORIGIN).unwrap(),
        )
        .await
        .unwrap()
    }

    fn client() -> reqwest::Client {
        crate::net::loopback_client().build().unwrap()
    }

    fn url(port: &TunnelPort, path: &str) -> String {
        format!("http://127.0.0.1:{}{path}", port.port())
    }

    #[tokio::test]
    async fn unpaired_requests_cannot_reach_the_api() {
        let port = tunnel_port().await;
        let response = client()
            .get(url(&port, "/api/projects"))
            .header("host", "laptop.example.ts.net")
            .header("origin", TUNNEL_ORIGIN)
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), 401);
    }

    #[tokio::test]
    async fn unpaired_requests_reach_only_pairing_and_static_assets() {
        let port = tunnel_port().await;
        let asset = super::super::UiDist::iter()
            .find(|path| path != "index.html")
            .expect("a built ui asset");
        for (path, expected) in [
            ("/pair".to_string(), 200),
            (format!("/{asset}"), 200),
            ("/".to_string(), 401),
            ("/projects/p1".to_string(), 401),
        ] {
            let response = client().get(url(&port, &path)).send().await.unwrap();
            assert_eq!(response.status(), expected, "{path}");
        }
    }

    #[tokio::test]
    async fn the_redeem_endpoint_is_open_to_unpaired_devices() {
        let port = tunnel_port().await;
        let response = client()
            .post(url(&port, PAIR_REDEEM_PATH))
            .header("origin", TUNNEL_ORIGIN)
            .send()
            .await
            .unwrap();
        // Past authentication and the allowlist; the missing body is the
        // handler's to refuse.
        assert_eq!(response.status(), 400);
    }

    #[tokio::test]
    async fn unsafe_and_websocket_requests_need_the_tunnel_origin() {
        let port = tunnel_port().await;
        for origin in [None, Some("https://evil.example"), Some("http://127.0.0.1")] {
            let mut request = client().post(url(&port, PAIR_REDEEM_PATH));
            if let Some(origin) = origin {
                request = request.header("origin", origin);
            }
            let response = request.send().await.unwrap();
            assert_eq!(response.status(), 403, "{origin:?}");
        }
        let websocket = client()
            .get(url(&port, PAIR_PAGE_PATH))
            .header("connection", "upgrade")
            .header("upgrade", "websocket")
            .header("origin", "https://evil.example")
            .send()
            .await
            .unwrap();
        assert_eq!(websocket.status(), 403);
        let plain_read = client()
            .get(url(&port, PAIR_PAGE_PATH))
            .send()
            .await
            .unwrap();
        assert_eq!(plain_read.status(), 200);
    }

    #[tokio::test]
    async fn responses_carry_the_secure_headers() {
        let port = tunnel_port().await;
        for path in [PAIR_PAGE_PATH, "/api/projects"] {
            let response = client().get(url(&port, path)).send().await.unwrap();
            let headers = response.headers();
            assert_eq!(headers["x-content-type-options"], "nosniff", "{path}");
            assert_eq!(headers["referrer-policy"], "no-referrer", "{path}");
        }
    }

    /// The allowlist sees every method on a matched path (an unsupported one
    /// included, before it becomes a 405), so each registered path must be
    /// classified under every method.
    #[test]
    fn every_registered_route_is_classified_for_tunnel_access() {
        let paths = super::super::routes().paths;
        assert!(paths.len() > 100, "only {} routes recorded", paths.len());
        let unclassified = paths
            .iter()
            .flat_map(|path| {
                [
                    Method::GET,
                    Method::HEAD,
                    Method::OPTIONS,
                    Method::POST,
                    Method::PUT,
                    Method::PATCH,
                    Method::DELETE,
                ]
                .map(|method| (method, *path))
            })
            .filter(|(method, path)| classify(method, path).is_none())
            .map(|(method, path)| format!("{method} {path}"))
            .collect::<Vec<_>>();
        assert!(
            unclassified.is_empty(),
            "classify these routes in tunnel::classify (allow or deny): {unclassified:#?}"
        );
    }

    #[test]
    fn dangerous_routes_are_denied() {
        for (method, route) in [
            (Method::GET, "/api/projects/{id}/terminal"),
            (Method::POST, "/api/chat/sessions/{id}/shell"),
            (Method::GET, "/api/files/abs"),
            (Method::GET, "/api/files/abs/raw"),
            (Method::PUT, "/api/projects/{id}/file"),
            (Method::PATCH, "/api/projects/{id}/file"),
            (Method::DELETE, "/api/projects/{id}/files"),
            (Method::POST, "/api/settings/env"),
            (Method::DELETE, "/api/settings/env/{key}"),
            (Method::GET, "/api/settings/ssh/connect"),
            (Method::GET, "/api/settings/commands/run"),
            (Method::DELETE, "/api/projects/{id}"),
            (Method::POST, "/api/update/apply"),
            (Method::POST, "/api/settings/data-dir/move"),
        ] {
            assert_eq!(
                classify(&method, route),
                Some(TunnelRoute::Deny),
                "{method} {route}"
            );
        }
    }

    #[test]
    fn unknown_routes_are_unclassified_so_they_fail_closed() {
        assert_eq!(classify(&Method::GET, "/api/brand-new"), None);
    }

    async fn original_port() -> String {
        let app = super::super::router(super::super::tests::test_state(), None);
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        tokio::spawn(async move { axum::serve(listener, app).await });
        base
    }

    #[tokio::test]
    async fn the_original_port_refuses_requests_a_tunnel_forwarded() {
        let base = original_port().await;
        for (name, value) in [
            ("x-forwarded-for", "100.64.0.7"),
            ("x-forwarded-host", "laptop.example.ts.net"),
            ("x-forwarded-proto", "https"),
            ("forwarded", "for=100.64.0.7;proto=https"),
            ("cf-connecting-ip", "203.0.113.9"),
            ("tailscale-user-login", "me@example.com"),
        ] {
            let response = client()
                .get(format!("{base}/api/health"))
                .header(name, value)
                .send()
                .await
                .unwrap();
            assert_eq!(response.status(), 421, "{name}");
            let body: serde_json::Value = response.json().await.unwrap();
            assert!(
                body["error"].as_str().unwrap().contains("Tunnel port"),
                "{body}"
            );
        }
    }

    #[tokio::test]
    async fn the_original_port_still_serves_local_requests() {
        let base = original_port().await;
        let response = client()
            .get(format!("{base}/api/health"))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), 200);
    }
}
