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
use super::{app, not_found, track_active, ApiError, AppState};
use crate::commands::up_remote::secure_response;
use crate::error::{anyhow, Result};
use crate::local::harness::{self, PermissionMode};
use crate::store::StoredChatSession;

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
        // Browsing, read-only: projects, experiments, runs and their logs,
        // artifacts, sessions and messages, the event stream, and what the
        // new-session page needs (skills, harnesses and models, the preferred
        // agent in the UI state).
        (
            &Method::GET | &Method::HEAD,
            "/api/health"
            | "/_orx/runtime"
            | "/api/events"
            | "/api/projects"
            | "/api/projects/activity"
            | "/api/projects/{id}"
            | "/api/projects/{id}/experiments"
            | "/api/projects/{id}/runs"
            | "/api/projects/{id}/ui-state"
            | "/api/runs/{id}"
            | "/api/runs/{id}/log"
            | "/api/runs/{id}/logs"
            | "/api/runs/{id}/diff"
            | "/api/experiments/{id}/diff"
            | "/api/experiments/{id}/commits"
            | "/api/experiments/{id}/commits/{sha}/diff"
            | "/api/projects/{id}/files"
            | "/api/projects/{id}/files/file"
            | "/api/chat/sessions"
            | "/api/chat/sessions/{id}/messages"
            | "/api/chat/attachments/{name}"
            | "/api/skills"
            | "/api/skills/{name}"
            | "/api/harnesses"
            | "/api/harnesses/{id}/snapshot"
            | "/api/settings/ui-state",
        ) => Some(Allow),
        // Chat: create a session, send (images included) or steer, interrupt,
        // answer prompts, and change a session's permission or Plan mode —
        // the chat handlers keep those changes same-or-stricter.
        (
            &Method::POST,
            "/api/chat/sessions"
            | "/api/chat/sessions/{id}/message"
            | "/api/chat/sessions/{id}/interrupt"
            | "/api/chat/sessions/{id}/respond",
        )
        | (&Method::PATCH, "/api/chat/sessions/{id}") => Some(Allow),
        // Runs: cancel.
        (&Method::POST, "/api/runs/{id}/cancel") => Some(Allow),
        // Everything else on those paths (writes, other methods), and the
        // routes the groups above leave out.
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
            | "/api/projects/{id}/ui-state"
            | "/api/runs"
            | "/api/runs/{id}"
            | "/api/runs/{id}/cancel"
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
            | "/api/settings/ui-state"
            | "/api/agent/status"
            | "/api/instances"
            | "/api/compute/backends"
            | "/api/chat/sessions"
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
            | "/api/tunnel/access"
            // Pairing codes and the device list are managed from this computer.
            | "/api/tunnel/pairing-codes"
            | "/api/tunnel/devices"
            | "/api/tunnel/devices/{id}",
        ) => Some(Deny),
        _ => None,
    }
}

// --- permission limits -----------------------------------------------------
//
// Over Tunnel access a session's permission and Plan modes may only stay the
// same or get stricter, and a new session is never looser than the local
// default. The chat handlers call these when a request carries `TunnelAccess`.

/// How much a permission policy lets the agent do without asking, strictest
/// first. Every harness's own ids resolve to one of these policies through
/// `PermissionMode::from_id`, so one ordering serves them all:
///
/// 1. `Plan`: proposes only, executes nothing.
/// 2. `Ask`: prompts before every action that needs approval.
/// 3. `AcceptEdits`: file edits go through unasked; other tools still prompt.
/// 4. `Auto`: the agent (or its reviewer) approves requests on its own.
/// 5. `Bypass`: no prompts and no sandbox.
fn looseness(mode: PermissionMode) -> u8 {
    match mode {
        PermissionMode::Plan => 0,
        PermissionMode::Ask => 1,
        PermissionMode::AcceptEdits => 2,
        PermissionMode::Auto => 3,
        PermissionMode::Bypass => 4,
    }
}

/// Whether `requested` is a valid mode for `harness` no looser than `ceiling`
/// (a valid id for the same harness). An unknown id is refused.
fn within(harness: &str, requested: &str, ceiling: Option<&str>) -> bool {
    let Some(requested) = harness::permission_mode_for(harness, requested) else {
        return false;
    };
    let ceiling = ceiling.and_then(|ceiling| harness::permission_mode_for(harness, ceiling));
    ceiling.is_some_and(|ceiling| looseness(requested) <= looseness(ceiling))
}

fn looser_refused() -> ApiError {
    ApiError(
        StatusCode::FORBIDDEN,
        "Over Tunnel access a session's permission and Plan modes can only stay the same or \
         get stricter."
            .into(),
    )
}

fn chat_session(
    state: &AppState,
    session_id: &str,
) -> std::result::Result<StoredChatSession, ApiError> {
    state
        .tunnel_devices
        .store()?
        .get_chat_session(session_id)?
        .ok_or_else(|| not_found("chat session"))
}

/// The mode a session runs under now: its stored id, or the harness default.
fn current_mode(session: &StoredChatSession) -> Option<String> {
    harness::effective_permission_id(&session.harness, session.permission_mode.as_deref())
}

/// The permission mode a session created on this computer starts with: the
/// preferred agent's mode when it is this harness, else the harness default.
fn local_default_mode(
    state: &AppState,
    harness_id: &str,
) -> std::result::Result<Option<String>, ApiError> {
    let preferred = state
        .tunnel_devices
        .store()?
        .ui_state()?
        .preferred_agent
        .filter(|agent| agent.harness == harness_id)
        .and_then(|agent| agent.permission_mode);
    Ok(harness::effective_permission_id(
        harness_id,
        preferred.as_deref(),
    ))
}

/// A change to an existing session's modes (a PATCH or a turn override):
/// the permission mode no looser than the current one, Plan never turned off.
pub(super) fn limit_session_change(
    state: &AppState,
    session_id: &str,
    permission_mode: Option<&str>,
    plan_mode: Option<bool>,
) -> std::result::Result<(), ApiError> {
    let permission_mode = permission_mode.filter(|mode| !mode.trim().is_empty());
    if permission_mode.is_none() && plan_mode.is_none() {
        return Ok(());
    }
    let session = chat_session(state, session_id)?;
    if let Some(requested) = permission_mode {
        if !within(
            &session.harness,
            requested,
            current_mode(&session).as_deref(),
        ) {
            return Err(looser_refused());
        }
    }
    if session.plan_mode && plan_mode == Some(false) {
        return Err(looser_refused());
    }
    Ok(())
}

/// A new session's permission mode: no looser than the local default, which
/// it also gets when none was asked for (the harness default may be looser).
pub(super) fn limit_new_session(
    state: &AppState,
    harness_id: &str,
    permission_mode: Option<String>,
) -> std::result::Result<Option<String>, ApiError> {
    let ceiling = local_default_mode(state, harness_id)?;
    match permission_mode {
        Some(requested) if !within(harness_id, &requested, ceiling.as_deref()) => {
            Err(looser_refused())
        }
        Some(requested) => Ok(Some(requested)),
        None => Ok(ceiling),
    }
}

/// The mode an answered prompt resumes under, capped at the looser of the
/// session's current mode and the local default — never past what a session
/// created over Tunnel access could start with. Approving a plan necessarily
/// leaves Plan, so the cap is not just the current mode. With no explicit
/// choice the cap itself is returned, so the harness never falls back to its
/// own default (Claude Code resumes a permission approval under
/// bypassPermissions).
pub(super) fn limit_resume_mode(
    state: &AppState,
    session_id: &str,
    resume_mode: Option<&str>,
) -> std::result::Result<Option<String>, ApiError> {
    let session = chat_session(state, session_id)?;
    let current = current_mode(&session);
    let local_default = local_default_mode(state, &session.harness)?;
    let cap = match (current, local_default) {
        (Some(current), Some(local_default)) => {
            if within(&session.harness, &current, Some(&local_default)) {
                Some(local_default)
            } else {
                Some(current)
            }
        }
        (current, local_default) => current.or(local_default),
    };
    match resume_mode.filter(|mode| !mode.trim().is_empty()) {
        Some(requested) if within(&session.harness, requested, cap.as_deref()) => {
            Ok(Some(requested.to_string()))
        }
        Some(_) => Err(looser_refused()),
        None => Ok(cap),
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
    use serde_json::{json, Value};

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
            .json(&serde_json::json!({ "code": "unknown" }))
            .send()
            .await
            .unwrap();
        // Past authentication and the allowlist: the handler itself refuses
        // the unknown code.
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

    /// A paired device on a running Tunnel port.
    struct Paired {
        state: AppState,
        port: TunnelPort,
        cookie: String,
    }

    impl Paired {
        async fn open() -> Self {
            let state = super::super::tests::test_state();
            let port = open_tunnel_port(state.clone(), TunnelOrigin::new(TUNNEL_ORIGIN).unwrap())
                .await
                .unwrap();
            let cookie = state.tunnel_devices.pair_for_test();
            Self {
                state,
                port,
                cookie,
            }
        }

        fn request(&self, method: Method, path: &str) -> reqwest::RequestBuilder {
            client()
                .request(method, url(&self.port, path))
                .header("origin", TUNNEL_ORIGIN)
                .header("cookie", &self.cookie)
        }

        async fn status(&self, method: Method, path: &str, body: Option<Value>) -> u16 {
            let mut request = self.request(method, path);
            if let Some(body) = body {
                request = request.json(&body);
            }
            request.send().await.unwrap().status().as_u16()
        }

        /// Stores a chat session (and its project) where Tunnel access reads.
        fn seed_session(
            &self,
            harness: &str,
            permission_mode: Option<&str>,
            plan_mode: bool,
        ) -> String {
            let store = self.state.tunnel_devices.store().unwrap();
            let project_id = format!("proj_{}", uuid::Uuid::new_v4().simple());
            store
                .create_local_project(&crate::local::model::LocalProject {
                    id: project_id.clone(),
                    name: "Project".into(),
                    slug: project_id.clone(),
                    github_owner: String::new(),
                    github_repo: String::new(),
                    github_sync_enabled: false,
                    baseline_branch: "main".into(),
                    repo_path: std::env::temp_dir()
                        .join(&project_id)
                        .to_string_lossy()
                        .into_owned(),
                    run_command: None,
                    paper_id: None,
                    created_at: 1,
                    updated_at: 1,
                })
                .unwrap();
            let id = format!("chat_{}", uuid::Uuid::new_v4());
            store
                .create_chat_session(&crate::store::StoredChatSession {
                    id: id.clone(),
                    project_id,
                    harness: harness.into(),
                    native_session_id: None,
                    title: None,
                    title_source: None,
                    model: None,
                    service_tier: None,
                    permission_mode: permission_mode.map(str::to_string),
                    plan_mode,
                    plan_reset_pending: false,
                    reasoning_level: None,
                    archived: false,
                    context_usage_json: None,
                    bootstrap_context: None,
                    goal: None,
                    autonomy: None,
                    active_leaf_id: None,
                    parent_session_id: None,
                    side_parent_session_id: None,
                    created_at: 1,
                    updated_at: 1,
                })
                .unwrap();
            id
        }

        /// Makes state-changing handlers stop at their first guard, so a test
        /// sees a request get past the Tunnel access checks without it acting.
        fn hold_mutations(&self) {
            self.state
                .data_dir_move_in_progress
                .store(true, std::sync::atomic::Ordering::SeqCst);
            self.state
                .stopping
                .store(true, std::sync::atomic::Ordering::SeqCst);
        }
    }

    #[tokio::test]
    async fn a_paired_device_reaches_only_allowlisted_routes() {
        let paired = Paired::open().await;
        paired.hold_mutations();
        // Allowed: past the allowlist, the handler answers (whatever it says).
        for (method, path, body) in [
            (Method::GET, "/api/health", None),
            (Method::GET, "/_orx/runtime", None),
            (Method::GET, "/api/projects", None),
            (Method::GET, "/api/projects/missing", None),
            (Method::GET, "/api/runs/missing", None),
            (Method::GET, "/api/runs/missing/log", None),
            (Method::GET, "/api/chat/sessions/missing/messages", None),
            (Method::GET, "/api/projects/missing/files", None),
            (
                Method::POST,
                "/api/chat/sessions/missing/message",
                Some(json!({ "text": "hi" })),
            ),
            (
                Method::POST,
                "/api/chat/sessions/missing/respond",
                Some(json!({ "promptId": "p" })),
            ),
            (Method::POST, "/api/runs/missing/cancel", None),
        ] {
            let status = paired.status(method.clone(), path, body).await;
            assert!(
                status != 401 && status != 403,
                "{method} {path} should be allowed, got {status}"
            );
        }
        // Denied: refused before any handler runs.
        for (method, path) in [
            (Method::GET, "/api/projects/p1/terminal"),
            (Method::POST, "/api/chat/sessions/s1/shell"),
            (Method::GET, "/api/files/abs?path=/etc/passwd"),
            (Method::GET, "/api/files/abs/raw?path=/etc/passwd"),
            (Method::GET, "/api/projects/p1/file?path=a"),
            (Method::PUT, "/api/projects/p1/file"),
            (Method::PATCH, "/api/projects/p1/file"),
            (Method::PATCH, "/api/projects/p1/files"),
            (Method::DELETE, "/api/projects/p1/files"),
            (Method::GET, "/api/settings/env"),
            (Method::POST, "/api/settings/env"),
            (Method::DELETE, "/api/settings/env/KEY"),
            (Method::POST, "/api/settings/hf"),
            (Method::POST, "/api/overleaf/token"),
            (Method::GET, "/api/settings/ssh/connect"),
            (Method::POST, "/api/overleaf/session/import"),
            (Method::DELETE, "/api/projects/p1"),
            (Method::PATCH, "/api/projects/p1"),
            (Method::POST, "/api/projects"),
            (Method::POST, "/api/settings/ui-state"),
            (Method::DELETE, "/api/chat/sessions/s1"),
            (Method::POST, "/api/chat/sessions/s1/turns/t1/recover"),
            (Method::POST, "/api/runs"),
            (Method::POST, "/api/update/apply"),
            (Method::POST, "/api/settings/data-dir/move"),
            (Method::GET, "/api/settings/commands/run"),
            (Method::GET, "/api/harnesses/setup"),
            (Method::POST, "/api/user-skills"),
            (Method::POST, "/api/internal/permissions"),
        ] {
            let status = paired.status(method.clone(), path, None).await;
            assert_eq!(status, 403, "{method} {path}");
        }
    }

    #[tokio::test]
    async fn revoking_a_device_closes_its_open_event_stream() {
        let paired = Paired::open().await;
        let mut events = paired
            .request(Method::GET, "/api/events")
            .send()
            .await
            .unwrap();
        assert_eq!(events.status(), 200);
        assert!(events.headers()["content-type"]
            .to_str()
            .unwrap()
            .starts_with("text/event-stream"));

        let original = original_port_over(paired.state.clone()).await;
        let revoked = client()
            .delete(format!("{original}/api/tunnel/devices"))
            .send()
            .await
            .unwrap();
        assert_eq!(revoked.status(), 200);

        let closed = tokio::time::timeout(std::time::Duration::from_secs(5), async {
            while events.chunk().await.unwrap().is_some() {}
        })
        .await;
        assert!(closed.is_ok(), "the event stream outlived the revoke");
    }

    #[tokio::test]
    async fn runtime_info_says_whether_a_request_is_tunnel_access() {
        let paired = Paired::open().await;
        let over_tunnel: Value = paired
            .request(Method::GET, "/_orx/runtime")
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(over_tunnel["tunnelAccess"], true);

        let original = original_port_over(paired.state.clone()).await;
        let local: Value = client()
            .get(format!("{original}/_orx/runtime"))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(local["tunnelAccess"], false);
        assert_eq!(local["kind"], "local");
    }

    /// Past the Tunnel access checks, a held mutation stops at the handler's
    /// own first guard (409 moving, 503 stopping) instead of acting.
    const REACHED_HANDLER: [u16; 2] = [409, 503];

    #[tokio::test]
    async fn a_session_permission_mode_can_only_get_stricter_over_tunnel_access() {
        let paired = Paired::open().await;
        paired.hold_mutations();
        // Claude Code: plan < manual < acceptEdits < auto < bypassPermissions.
        let claude = paired.seed_session("claude-code", Some("acceptEdits"), false);
        let path = format!("/api/chat/sessions/{claude}");
        for (mode, allowed) in [
            ("bypassPermissions", false),
            ("auto", false),
            ("acceptEdits", true),
            ("manual", true),
            ("plan", true),
        ] {
            let status = paired
                .status(
                    Method::PATCH,
                    &path,
                    Some(json!({ "permissionMode": mode })),
                )
                .await;
            if allowed {
                assert!(REACHED_HANDLER.contains(&status), "{mode}: {status}");
            } else {
                assert_eq!(status, 403, "{mode}");
            }
        }
        // Codex carries Plan on its own axis: turning it off is looser.
        let codex = paired.seed_session("codex", Some("ask"), true);
        let path = format!("/api/chat/sessions/{codex}");
        let off = paired
            .status(Method::PATCH, &path, Some(json!({ "planMode": false })))
            .await;
        assert_eq!(off, 403);
        let on = paired
            .status(Method::PATCH, &path, Some(json!({ "planMode": true })))
            .await;
        assert!(REACHED_HANDLER.contains(&on), "{on}");
    }

    #[tokio::test]
    async fn a_new_session_is_never_looser_than_the_local_default() {
        let paired = Paired::open().await;
        paired.hold_mutations();
        let store = paired.state.tunnel_devices.store().unwrap();
        store
            .set_preferred_agent(&crate::store::StoredAgentSelection {
                harness: "claude-code".into(),
                model: None,
                service_tier: None,
                permission_mode: Some("acceptEdits".into()),
                reasoning_level: None,
            })
            .unwrap();
        for (harness, mode, allowed) in [
            // The preferred agent's mode is the ceiling for its harness...
            ("claude-code", Some("auto"), false),
            ("claude-code", Some("bypassPermissions"), false),
            ("claude-code", Some("acceptEdits"), true),
            ("claude-code", Some("plan"), true),
            ("claude-code", None, true),
            // ...and the harness default for any other.
            ("codex", Some("full-access"), false),
            ("codex", Some("approve-for-me"), true),
            ("codex", Some("ask"), true),
        ] {
            let status = paired
                .status(
                    Method::POST,
                    "/api/chat/sessions",
                    Some(json!({ "projectId": "p1", "harness": harness, "permissionMode": mode })),
                )
                .await;
            if allowed {
                assert!(
                    REACHED_HANDLER.contains(&status),
                    "{harness} {mode:?}: {status}"
                );
            } else {
                assert_eq!(status, 403, "{harness} {mode:?}");
            }
        }
    }

    #[tokio::test]
    async fn messages_and_prompt_answers_cannot_loosen_a_session_over_tunnel_access() {
        let paired = Paired::open().await;
        paired.hold_mutations();
        let manual = paired.seed_session("claude-code", Some("manual"), false);
        let send = format!("/api/chat/sessions/{manual}/message");
        for (mode, allowed) in [("auto", false), ("acceptEdits", false), ("plan", true)] {
            let status = paired
                .status(
                    Method::POST,
                    &send,
                    Some(json!({ "text": "go", "permissionMode": mode })),
                )
                .await;
            if allowed {
                assert!(REACHED_HANDLER.contains(&status), "{mode}: {status}");
            } else {
                assert_eq!(status, 403, "{mode}");
            }
        }
        let steer = paired
            .status(
                Method::POST,
                &send,
                Some(
                    json!({ "text": "go", "mode": "steer", "permissionMode": "bypassPermissions" }),
                ),
            )
            .await;
        assert_eq!(steer, 403);

        // Approving a plan leaves Plan, up to the local default (Claude
        // Code's own default here: auto) and no further.
        let planning = paired.seed_session("claude-code", Some("plan"), false);
        let respond = format!("/api/chat/sessions/{planning}/respond");
        for (mode, allowed) in [
            (Some("bypassPermissions"), false),
            (Some("auto"), true),
            (Some("acceptEdits"), true),
            (None, true),
        ] {
            let status = paired
                .status(
                    Method::POST,
                    &respond,
                    Some(json!({ "promptId": "p", "resumeMode": mode })),
                )
                .await;
            if allowed {
                assert!(REACHED_HANDLER.contains(&status), "{mode:?}: {status}");
            } else {
                assert_eq!(status, 403, "{mode:?}");
            }
        }
    }

    /// Answering a prompt runs the agent, so this checks the resume mode the
    /// respond handler hands on over Tunnel access, fed through Claude Code's
    /// real resume rules: a permission approval with no `resumeMode` (which
    /// locally resumes under bypassPermissions) stays within the cap.
    #[tokio::test]
    async fn approving_a_claude_permission_without_a_resume_mode_stays_within_the_cap() {
        let paired = Paired::open().await;
        paired
            .state
            .tunnel_devices
            .store()
            .unwrap()
            .set_preferred_agent(&crate::store::StoredAgentSelection {
                harness: "claude-code".into(),
                model: None,
                service_tier: None,
                permission_mode: Some("acceptEdits".into()),
                reasoning_level: None,
            })
            .unwrap();
        let session = paired.seed_session("claude-code", Some("manual"), false);
        let Ok(resume_mode) = limit_resume_mode(&paired.state, &session, None) else {
            panic!("the session exists");
        };
        assert_eq!(resume_mode.as_deref(), Some("acceptEdits"));
        let answer = crate::local::chat::PromptAnswer {
            session_id: session,
            prompt_id: "p".into(),
            approve: true,
            resume_mode,
            answers: Vec::new(),
            note: None,
            annotations: Vec::new(),
        };
        for kind in ["permission", "plan"] {
            let (_, mode) = crate::local::harness::claude::synthesize_resume(kind, &answer);
            assert_eq!(mode, Some(PermissionMode::AcceptEdits), "{kind}");
        }
    }

    #[tokio::test]
    async fn the_permission_limit_applies_only_to_tunnel_access() {
        let paired = Paired::open().await;
        paired.hold_mutations();
        let original = original_port_over(paired.state.clone()).await;
        let response = client()
            .post(format!("{original}/api/chat/sessions"))
            .json(&json!({
                "projectId": "p1",
                "harness": "claude-code",
                "permissionMode": "bypassPermissions",
            }))
            .send()
            .await
            .unwrap();
        assert!(REACHED_HANDLER.contains(&response.status().as_u16()));
    }

    #[tokio::test]
    async fn over_tunnel_access_a_session_edit_may_only_touch_its_modes() {
        let paired = Paired::open().await;
        paired.hold_mutations();
        let session = paired.seed_session("claude-code", Some("auto"), false);
        let path = format!("/api/chat/sessions/{session}");
        for body in [
            json!({ "title": "renamed" }),
            json!({ "archived": true }),
            json!({ "goal": "anything" }),
            json!({ "autonomy": "agentic" }),
        ] {
            assert_eq!(
                paired
                    .status(Method::PATCH, &path, Some(body.clone()))
                    .await,
                403,
                "{body}"
            );
        }
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
        original_port_over(super::super::tests::test_state()).await
    }

    async fn original_port_over(state: AppState) -> String {
        let app = super::super::router(state, None);
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
