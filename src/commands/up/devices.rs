//! Device pairing for Tunnel access: one-time pairing codes minted on the
//! original port, redeemed on the Tunnel port for a device cookie, and the
//! paired-device list the desktop dashboard manages.

use std::collections::HashMap;
use std::path::PathBuf;
#[cfg(test)]
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::{Arc, Mutex};

use axum::body::Body;
use axum::extract::{Path, Request, State};
use axum::http::{header, HeaderMap, HeaderValue, Method, StatusCode};
use axum::middleware::Next;
use axum::response::{Html, IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use futures::StreamExt as _;
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest as _, Sha256};
use tokio_util::sync::CancellationToken;

use super::{bad_request, not_found, ApiError, ApiResult, AppState, UiDist};
use crate::error::Result;
use crate::store::{now_ms, Store, TunnelDevice};

/// The pairing page a pairing QR code opens; the code rides in the `#`
/// fragment, so it never reaches a request line, a log or a Referer.
pub(super) const PAIR_PAGE_PATH: &str = "/pair";
/// Where the pairing page redeems its code for a device cookie.
pub(super) const PAIR_REDEEM_PATH: &str = "/api/tunnel/pair";
/// `__Host-` binds the cookie to the tunnel origin: Secure, Path=/, no Domain.
const DEVICE_COOKIE: &str = "__Host-orx_device";
/// How long a pairing code stays redeemable.
const PAIRING_CODE_TTL_MS: i64 = 5 * 60 * 1000;
/// The browser keeps the cookie as long as it allows (Chrome caps at 400
/// days); the store's sliding 30-day expiry is what actually ends a device.
const DEVICE_COOKIE_MAX_AGE_SECS: u64 = 400 * 24 * 60 * 60;
const DEVICE_NAME_MAX_CHARS: usize = 80;

/// Paired devices and outstanding pairing codes, shared by both listeners.
pub(super) struct TunnelDevices {
    /// `None` resolves the store's current data dir on every use, so a data
    /// dir move is followed; tests pin a throwaway directory.
    store_dir: Option<PathBuf>,
    /// Hashes of unredeemed pairing codes and when each expires. In memory
    /// only: a restart invalidates every outstanding code.
    codes: Mutex<HashMap<String, i64>>,
    /// One token per device seen since start, cancelled when the device is
    /// revoked so its open streams close.
    sessions: Mutex<HashMap<String, CancellationToken>>,
    #[cfg(test)]
    clock_skew_ms: AtomicI64,
}

impl TunnelDevices {
    pub(super) fn new(store_dir: Option<PathBuf>) -> Self {
        Self {
            store_dir,
            codes: Mutex::default(),
            sessions: Mutex::default(),
            #[cfg(test)]
            clock_skew_ms: AtomicI64::new(0),
        }
    }

    /// The store Tunnel access reads: paired devices, and the sessions and
    /// defaults the permission-mode limit compares against.
    pub(super) fn store(&self) -> Result<Store> {
        match &self.store_dir {
            Some(dir) => Store::open_at(dir.clone()),
            None => Store::open(),
        }
    }

    fn now(&self) -> i64 {
        #[cfg(test)]
        return now_ms() + self.clock_skew_ms.load(Ordering::Relaxed);
        #[cfg(not(test))]
        now_ms()
    }

    #[cfg(test)]
    pub(super) fn advance_clock(&self, ms: i64) {
        self.clock_skew_ms.fetch_add(ms, Ordering::Relaxed);
    }

    /// Mints a single-use pairing code valid for five minutes.
    fn mint_code(&self) -> (String, i64) {
        let now = self.now();
        let code = uuid::Uuid::new_v4().simple().to_string();
        let expires_at = now + PAIRING_CODE_TTL_MS;
        let mut codes = self.codes.lock().unwrap();
        codes.retain(|_, expires| *expires > now);
        codes.insert(digest(&code), expires_at);
        (code, expires_at)
    }

    /// Consumes `code`; true only for an unexpired code never redeemed before.
    fn redeem_code(&self, code: &str) -> bool {
        let now = self.now();
        let expires = self.codes.lock().unwrap().remove(&digest(code));
        expires.is_some_and(|expires| expires > now)
    }

    /// The paired device presenting the cookie in `headers`, if any.
    fn authenticate(&self, headers: &HeaderMap) -> Result<Option<DeviceSession>> {
        let Some(token) = device_token(headers) else {
            return Ok(None);
        };
        let lookup = self
            .store()?
            .authenticate_tunnel_device(&digest(token), self.now())?;
        let Some(device) = lookup else {
            return Ok(None);
        };
        let revoked = self.session_token(&device.id);
        // A revoke deletes the row, then cancels and drops the token. If it
        // landed between the lookup and taking the token, the token taken here
        // is fresh, so check the row again rather than serve a stream nothing
        // will ever cancel.
        if !self.store()?.tunnel_device_exists(&device.id)? {
            return Ok(None);
        }
        Ok(Some(DeviceSession {
            device_id: device.id,
            revoked,
        }))
    }

    /// Pairs a device without the code dance and returns its `Cookie` header
    /// value, for tests of what a paired device may do.
    #[cfg(test)]
    pub(super) fn pair_for_test(&self) -> String {
        let token = uuid::Uuid::new_v4().simple().to_string();
        let id = uuid::Uuid::new_v4().to_string();
        self.store()
            .unwrap()
            .insert_tunnel_device(&id, "Test device", &digest(&token), self.now())
            .unwrap();
        format!("{DEVICE_COOKIE}={token}")
    }

    fn session_token(&self, device_id: &str) -> CancellationToken {
        self.sessions
            .lock()
            .unwrap()
            .entry(device_id.to_string())
            .or_default()
            .clone()
    }

    fn revoke(&self, device_id: &str) -> Result<bool> {
        let removed = self.store()?.delete_tunnel_device(device_id)?;
        if let Some(token) = self.sessions.lock().unwrap().remove(device_id) {
            token.cancel();
        }
        Ok(removed)
    }

    fn revoke_all(&self) -> Result<usize> {
        let removed = self.store()?.delete_all_tunnel_devices()?;
        for (_, token) in self.sessions.lock().unwrap().drain() {
            token.cancel();
        }
        Ok(removed)
    }
}

/// Present in a request's extensions when a paired device made it.
#[derive(Clone, Debug)]
pub(super) struct DeviceSession {
    /// The paired device, for Tunnel access handlers that need it.
    #[allow(dead_code)]
    pub(super) device_id: String,
    /// Cancelled the moment the device is revoked; a long-lived handler (a
    /// WebSocket, say) must stop when it fires.
    pub(super) revoked: CancellationToken,
}

fn digest(value: &str) -> String {
    format!("{:x}", Sha256::digest(value.as_bytes()))
}

fn device_token(headers: &HeaderMap) -> Option<&str> {
    headers
        .get_all(header::COOKIE)
        .iter()
        .filter_map(|value| value.to_str().ok())
        .flat_map(|value| value.split(';'))
        .filter_map(|pair| pair.trim().split_once('='))
        .find(|(name, _)| *name == DEVICE_COOKIE)
        .map(|(_, token)| token)
        .filter(|token| !token.is_empty())
}

/// Tunnel port device authentication. A paired device passes, tagged with its
/// `DeviceSession`; anyone else reaches only the pairing page, the redeem
/// endpoint and built UI assets, and a page navigation shows the pairing page
/// instead of the app.
pub(super) async fn authenticate(
    State(devices): State<Arc<TunnelDevices>>,
    mut request: Request,
    next: Next,
) -> Response {
    match devices.authenticate(request.headers()) {
        Ok(Some(session)) => {
            let revoked = session.revoked.clone();
            request.extensions_mut().insert(session);
            return close_stream_on(next.run(request).await, revoked);
        }
        Ok(None) => {}
        Err(error) => return ApiError::from(error).into_response(),
    }
    let (method, path) = (request.method(), request.uri().path());
    if open_to_unpaired(method, path) {
        return next.run(request).await;
    }
    if matches!(*method, Method::GET | Method::HEAD) && !is_api(path) {
        return (StatusCode::UNAUTHORIZED, Html(PAIR_PAGE)).into_response();
    }
    ApiError(
        StatusCode::UNAUTHORIZED,
        "Pair this device from the desktop dashboard first.".into(),
    )
    .into_response()
}

fn is_api(path: &str) -> bool {
    path == "/api" || path.starts_with("/api/")
}

/// What a device that has not paired may load: the pairing page, the redeem
/// endpoint, and built UI assets — never the app shell or any data.
fn open_to_unpaired(method: &Method, path: &str) -> bool {
    match *method {
        Method::POST => path == PAIR_REDEEM_PATH,
        Method::GET | Method::HEAD => {
            path == PAIR_PAGE_PATH
                || path
                    .strip_prefix('/')
                    .filter(|asset| !asset.is_empty() && *asset != "index.html")
                    .is_some_and(|asset| UiDist::get(asset).is_some())
        }
        _ => false,
    }
}

/// Ends an event stream when `closed` fires (its device is revoked, or
/// Tunnel access is turned off). Other responses are complete bodies and
/// need no help.
pub(super) fn close_stream_on(response: Response, closed: CancellationToken) -> Response {
    let streaming = response
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| value.starts_with("text/event-stream"));
    if !streaming {
        return response;
    }
    let (parts, body) = response.into_parts();
    let body = body.into_data_stream().take_until(closed.cancelled_owned());
    Response::from_parts(parts, Body::from_stream(body))
}

/// Routes served only on the Tunnel port.
pub(super) fn pairing_routes() -> Router<AppState> {
    Router::new()
        .route(PAIR_PAGE_PATH, get(pair_page))
        .route(PAIR_REDEEM_PATH, post(redeem_pairing_code))
}

async fn pair_page() -> Response {
    (
        [(header::CACHE_CONTROL, HeaderValue::from_static("no-store"))],
        Html(PAIR_PAGE),
    )
        .into_response()
}

#[derive(Deserialize)]
struct RedeemReq {
    code: String,
}

async fn redeem_pairing_code(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(req): Json<RedeemReq>,
) -> std::result::Result<Response, ApiError> {
    let devices = &state.tunnel_devices;
    if !devices.redeem_code(req.code.trim()) {
        return Err(bad_request(
            "This pairing code is invalid, expired or already used. Add the device again from \
             the desktop dashboard.",
        ));
    }
    let token = format!(
        "{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    );
    let user_agent = headers
        .get(header::USER_AGENT)
        .and_then(|value| value.to_str().ok());
    let now = devices.now();
    let device = TunnelDevice {
        id: uuid::Uuid::new_v4().to_string(),
        name: device_name(user_agent),
        paired_at: now,
        last_seen_at: now,
    };
    devices
        .store()?
        .insert_tunnel_device(&device.id, &device.name, &digest(&token), now)?;
    state.chat.emit_event("tunnel.device_paired", json!(device));
    let cookie = format!(
        "{DEVICE_COOKIE}={token}; HttpOnly; Secure; SameSite=Strict; Path=/; \
         Max-Age={DEVICE_COOKIE_MAX_AGE_SECS}"
    );
    Ok((
        StatusCode::SEE_OTHER,
        [
            (header::LOCATION, HeaderValue::from_static("/")),
            (
                header::SET_COOKIE,
                HeaderValue::from_str(&cookie).map_err(bad_request)?,
            ),
            (header::CACHE_CONTROL, HeaderValue::from_static("no-store")),
        ],
    )
        .into_response())
}

/// A readable default name, e.g. "iPhone · Safari"; the user can rename it.
fn device_name(user_agent: Option<&str>) -> String {
    let ua = user_agent.unwrap_or_default();
    let device = if ua.contains("iPhone") {
        "iPhone"
    } else if ua.contains("iPad") {
        "iPad"
    } else if ua.contains("Android") {
        if ua.contains("Mobile") {
            "Android phone"
        } else {
            "Android tablet"
        }
    } else if ua.contains("Macintosh") {
        "Mac"
    } else if ua.contains("Windows") {
        "Windows"
    } else if ua.contains("CrOS") {
        "Chromebook"
    } else if ua.contains("Linux") {
        "Linux"
    } else {
        "Device"
    };
    let browser = if ua.contains("EdgA/") || ua.contains("EdgiOS/") || ua.contains("Edg/") {
        Some("Edge")
    } else if ua.contains("FxiOS/") || ua.contains("Firefox/") {
        Some("Firefox")
    } else if ua.contains("CriOS/") || ua.contains("Chrome/") {
        Some("Chrome")
    } else if ua.contains("Safari/") {
        Some("Safari")
    } else {
        None
    };
    match browser {
        Some(browser) => format!("{device} · {browser}"),
        None => device.to_string(),
    }
}

// --- device management (original port only; denied by the allowlist) -------

/// Mints a pairing code. The desktop dashboard turns `path` into the QR link
/// `https://<tunnel>/pair#<code>`.
pub(super) async fn mint_pairing_code(State(state): State<AppState>) -> Json<Value> {
    let (code, expires_at) = state.tunnel_devices.mint_code();
    Json(json!({
        "code": code,
        "path": format!("{PAIR_PAGE_PATH}#{code}"),
        "expiresAt": expires_at,
    }))
}

pub(super) async fn list_devices(State(state): State<AppState>) -> ApiResult {
    let devices = &state.tunnel_devices;
    let list = devices.store()?.list_tunnel_devices(devices.now())?;
    Ok(Json(json!(list)))
}

#[derive(Deserialize)]
pub(super) struct RenameReq {
    name: String,
}

pub(super) async fn rename_device(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(req): Json<RenameReq>,
) -> std::result::Result<StatusCode, ApiError> {
    let name = req.name.trim();
    if name.is_empty() || name.chars().count() > DEVICE_NAME_MAX_CHARS {
        return Err(bad_request(format!(
            "A device name needs 1 to {DEVICE_NAME_MAX_CHARS} characters."
        )));
    }
    if !state
        .tunnel_devices
        .store()?
        .rename_tunnel_device(&id, name)?
    {
        return Err(not_found("device"));
    }
    Ok(StatusCode::NO_CONTENT)
}

/// Revokes one device; its open event streams close at once.
pub(super) async fn revoke_device(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> std::result::Result<StatusCode, ApiError> {
    if !state.tunnel_devices.revoke(&id)? {
        return Err(not_found("device"));
    }
    Ok(StatusCode::NO_CONTENT)
}

pub(super) async fn revoke_all_devices(State(state): State<AppState>) -> ApiResult {
    let revoked = state.tunnel_devices.revoke_all()?;
    Ok(Json(json!({ "revoked": revoked })))
}

/// Served by Rust rather than the SPA so an unpaired visitor never loads the
/// app shell: it reads the code from the fragment, clears it from the address
/// bar and redeems it. English and Simplified Chinese by browser language.
const PAIR_PAGE: &str = include_str!("pair.html");

#[cfg(test)]
mod tests {
    use super::super::tunnel::{open_tunnel_port, TunnelOrigin, TunnelPort};
    use super::super::AppState;
    use super::*;
    use serde_json::Value;

    const TUNNEL_ORIGIN: &str = "https://laptop.example.ts.net";
    const IPHONE_SAFARI: &str = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) \
        AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";

    /// Both listeners over one shared `AppState`, as `orx up` runs them.
    struct Ports {
        state: AppState,
        tunnel: TunnelPort,
        original: String,
    }

    impl Ports {
        async fn open() -> Self {
            let state = super::super::tests::test_state();
            let tunnel = open_tunnel_port(state.clone(), TunnelOrigin::new(TUNNEL_ORIGIN).unwrap())
                .await
                .unwrap();
            let app = super::super::router(state.clone(), None);
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let original = format!("http://{}", listener.local_addr().unwrap());
            tokio::spawn(async move { axum::serve(listener, app).await });
            Self {
                state,
                tunnel,
                original,
            }
        }

        fn tunnel(&self, path: &str) -> String {
            format!("http://127.0.0.1:{}{path}", self.tunnel.port())
        }

        fn original(&self, path: &str) -> String {
            format!("{}{path}", self.original)
        }

        async fn mint_code(&self) -> String {
            let response = client()
                .post(self.original("/api/tunnel/pairing-codes"))
                .send()
                .await
                .unwrap();
            assert_eq!(response.status(), 200);
            let body: Value = response.json().await.unwrap();
            body["code"].as_str().unwrap().to_string()
        }

        async fn redeem(&self, code: &str) -> reqwest::Response {
            client()
                .post(self.tunnel(PAIR_REDEEM_PATH))
                .header("origin", TUNNEL_ORIGIN)
                .header("user-agent", IPHONE_SAFARI)
                .json(&serde_json::json!({ "code": code }))
                .send()
                .await
                .unwrap()
        }

        /// Pairs a device and returns its `Cookie` header value.
        async fn pair(&self) -> String {
            let code = self.mint_code().await;
            let response = self.redeem(&code).await;
            assert_eq!(response.status(), 303);
            device_cookie(&response).expect("a device cookie")
        }

        async fn tunnel_get(&self, path: &str, cookie: Option<&str>) -> u16 {
            let mut request = client().get(self.tunnel(path));
            if let Some(cookie) = cookie {
                request = request.header("cookie", cookie);
            }
            request.send().await.unwrap().status().as_u16()
        }

        async fn devices(&self) -> Vec<Value> {
            let response = client()
                .get(self.original("/api/tunnel/devices"))
                .send()
                .await
                .unwrap();
            assert_eq!(response.status(), 200);
            response.json().await.unwrap()
        }
    }

    fn client() -> reqwest::Client {
        crate::net::loopback_client()
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .unwrap()
    }

    fn device_cookie(response: &reqwest::Response) -> Option<String> {
        let set_cookie = response.headers().get("set-cookie")?.to_str().ok()?;
        Some(set_cookie.split(';').next()?.trim().to_string())
    }

    /// An app route that stays off the Tunnel allowlist: past authentication a
    /// paired device gets 403 there, an unpaired one 401.
    const DENIED_ROUTE: &str = "/api/settings/env";

    #[tokio::test]
    async fn a_code_minted_on_the_original_port_pairs_a_device() {
        let ports = Ports::open().await;
        let code = ports.mint_code().await;
        let response = ports.redeem(&code).await;
        assert_eq!(response.status(), 303);
        assert_eq!(response.headers()["location"], "/");
        let set_cookie = response.headers()["set-cookie"].to_str().unwrap();
        assert!(set_cookie.starts_with("__Host-orx_device="), "{set_cookie}");
        for attribute in ["HttpOnly", "Secure", "SameSite=Strict", "Path=/"] {
            assert!(set_cookie.contains(attribute), "{set_cookie}");
        }
        let cookie = device_cookie(&response).unwrap();

        assert_eq!(ports.tunnel_get("/", Some(&cookie)).await, 200);
        assert_eq!(ports.tunnel_get(DENIED_ROUTE, Some(&cookie)).await, 403);
        assert_eq!(ports.tunnel_get(DENIED_ROUTE, None).await, 401);
        assert_eq!(
            ports
                .tunnel_get(DENIED_ROUTE, Some("__Host-orx_device=forged"))
                .await,
            401
        );

        let devices = ports.devices().await;
        assert_eq!(devices.len(), 1);
        assert_eq!(devices[0]["name"], "iPhone · Safari");
        assert!(devices[0]["pairedAt"].as_i64().is_some());
        assert!(devices[0]["lastSeenAt"].as_i64().is_some());
        assert!(devices[0].get("tokenHash").is_none());
    }

    #[tokio::test]
    async fn a_pairing_code_works_only_once() {
        let ports = Ports::open().await;
        let code = ports.mint_code().await;
        assert_eq!(ports.redeem(&code).await.status(), 303);
        let again = ports.redeem(&code).await;
        assert_eq!(again.status(), 400);
        assert!(device_cookie(&again).is_none());
        assert_eq!(ports.redeem("made-up").await.status(), 400);
        assert_eq!(ports.devices().await.len(), 1);
    }

    #[tokio::test]
    async fn a_pairing_code_expires_after_five_minutes() {
        let ports = Ports::open().await;
        let fresh = ports.mint_code().await;
        let stale = ports.mint_code().await;
        ports
            .state
            .tunnel_devices
            .advance_clock(5 * 60 * 1000 - 1_000);
        assert_eq!(ports.redeem(&fresh).await.status(), 303);
        ports.state.tunnel_devices.advance_clock(1_000);
        let response = ports.redeem(&stale).await;
        assert_eq!(response.status(), 400);
        assert!(device_cookie(&response).is_none());
    }

    #[tokio::test]
    async fn devices_are_managed_only_from_the_original_port() {
        let ports = Ports::open().await;
        let cookie = ports.pair().await;
        for (method, path) in [
            (Method::POST, "/api/tunnel/pairing-codes"),
            (Method::GET, "/api/tunnel/devices"),
            (Method::DELETE, "/api/tunnel/devices"),
            (Method::PATCH, "/api/tunnel/devices/some-id"),
            (Method::DELETE, "/api/tunnel/devices/some-id"),
        ] {
            let request = |cookie: Option<&str>| {
                let mut request = client()
                    .request(method.clone(), ports.tunnel(path))
                    .header("origin", TUNNEL_ORIGIN);
                if let Some(cookie) = cookie {
                    request = request.header("cookie", cookie.to_string());
                }
                request
            };
            let paired = request(Some(&cookie)).send().await.unwrap();
            assert_eq!(paired.status(), 403, "{method} {path}");
            let unpaired = request(None).send().await.unwrap();
            assert_eq!(unpaired.status(), 401, "{method} {path}");
        }
    }

    #[tokio::test]
    async fn revoking_a_device_takes_effect_immediately() {
        let ports = Ports::open().await;
        let kept = ports.pair().await;
        let lost = ports.pair().await;
        let devices = ports.devices().await;
        let lost_id = devices[0]["id"].as_str().unwrap();
        let response = client()
            .delete(ports.original(&format!("/api/tunnel/devices/{lost_id}")))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), 204);
        assert_eq!(ports.tunnel_get(DENIED_ROUTE, Some(&lost)).await, 401);
        assert_eq!(ports.tunnel_get(DENIED_ROUTE, Some(&kept)).await, 403);

        let response = client()
            .delete(ports.original("/api/tunnel/devices"))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), 200);
        assert_eq!(ports.tunnel_get(DENIED_ROUTE, Some(&kept)).await, 401);
        assert!(ports.devices().await.is_empty());
    }

    #[tokio::test]
    async fn a_device_can_be_renamed() {
        let ports = Ports::open().await;
        ports.pair().await;
        let id = ports.devices().await[0]["id"].as_str().unwrap().to_string();
        let rename = |name: &'static str, id: String| {
            client()
                .patch(ports.original(&format!("/api/tunnel/devices/{id}")))
                .json(&serde_json::json!({ "name": name }))
                .send()
        };
        assert_eq!(
            rename("  My phone ", id.clone()).await.unwrap().status(),
            204
        );
        assert_eq!(ports.devices().await[0]["name"], "My phone");
        assert_eq!(rename("   ", id).await.unwrap().status(), 400);
        assert_eq!(rename("x", "missing".into()).await.unwrap().status(), 404);
    }

    #[tokio::test]
    async fn pairing_a_device_announces_it_on_the_event_stream() {
        let ports = Ports::open().await;
        let mut events = ports.state.chat.subscribe();
        ports.pair().await;
        let (name, data) = loop {
            let event = events.recv().await.unwrap();
            if event.0 == "tunnel.device_paired" {
                break event;
            }
        };
        assert_eq!(name, "tunnel.device_paired");
        assert_eq!(data["name"], "iPhone · Safari");
        assert_eq!(data["id"], ports.devices().await[0]["id"]);
    }

    #[tokio::test]
    async fn an_unpaired_visitor_sees_only_the_pairing_page() {
        let ports = Ports::open().await;
        for path in ["/", "/projects/p1"] {
            let response = client().get(ports.tunnel(path)).send().await.unwrap();
            assert_eq!(response.status(), 401, "{path}");
            let body = response.text().await.unwrap();
            assert!(body.contains("/api/tunnel/pair"), "{path}");
            assert!(!body.contains("id=\"root\""), "{path}");
        }
    }

    #[test]
    fn device_names_come_from_the_user_agent() {
        for (user_agent, expected) in [
            (Some(IPHONE_SAFARI), "iPhone · Safari"),
            (
                Some(
                    "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like \
                     Gecko) Chrome/129.0.0.0 Mobile Safari/537.36",
                ),
                "Android phone · Chrome",
            ),
            (
                Some(
                    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 \
                     (KHTML, like Gecko) Version/18.0 Safari/605.1.15",
                ),
                "Mac · Safari",
            ),
            (None, "Device"),
        ] {
            assert_eq!(device_name(user_agent), expected);
        }
    }
}
