//! Loopback OAuth sign-in against the repo-crew GitHub App.
//!
//! The flow is the GitHub Desktop pattern: open the browser at GitHub's
//! authorize URL, catch the redirect on a one-shot 127.0.0.1 listener,
//! exchange the code for a user-to-server token, and put it in the keychain.
//! The webview only ever hears "signed in / failed" — the code, the client
//! secret, and the tokens never cross IPC.
//!
//! There is deliberately NO app private key anywhere in this module: that key
//! mints installation tokens for every install of the app and must never ship
//! in a distributed binary. User sign-in needs only the client id and secret.

use serde_json::{json, Value};
use std::io::{Read, Write};
use std::net::TcpListener;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tauri::Emitter;

use crate::{lock, now_unix, store_token, valid_token_bytes, AppState, StoredToken};

/// Fixed, uncommon port. GitHub matches callback URLs exactly, so this must
/// agree with the app registration: `http://127.0.0.1:43117/callback`.
const CALLBACK_ADDR: &str = "127.0.0.1:43117";
const CALLBACK_PATH: &str = "/callback";
const REDIRECT_URI: &str = "http://127.0.0.1:43117/callback";

/// How long the listener waits for the user to finish in the browser.
const LOGIN_DEADLINE: Duration = Duration::from_secs(300);

/// Baked in at compile time so the public repo never carries them. A build
/// without them still runs — sign-in reports itself unconfigured instead.
struct OauthApp {
    client_id: &'static str,
    client_secret: &'static str,
}

fn app_credentials() -> Option<OauthApp> {
    Some(OauthApp {
        client_id: option_env!("REPO_CREW_GH_CLIENT_ID")?,
        client_secret: option_env!("REPO_CREW_GH_CLIENT_SECRET")?,
    })
}

/// What the frontend may know: whether sign-in can work, and the app slug for
/// the "install it on your account" link. Never the credentials themselves.
#[tauri::command]
pub fn oauth_config() -> Value {
    json!({
        "configured": app_credentials().is_some(),
        "slug": option_env!("REPO_CREW_GH_APP_SLUG"),
    })
}

/// Hex-encoded CSRF token for the `state` parameter.
fn random_state() -> Result<String, String> {
    let mut buf = [0u8; 24];
    getrandom::fill(&mut buf).map_err(|e| format!("no randomness available: {e}"))?;
    Ok(buf.iter().map(|b| format!("{b:02x}")).collect())
}

/// Pull `code` and `state` out of an HTTP request target like
/// `/callback?code=abc&state=def`. Values GitHub sends here are URL-safe, so
/// no percent-decoding is needed. Returns (path, code, state).
pub(crate) fn parse_callback(target: &str) -> (&str, Option<&str>, Option<&str>) {
    let (path, query) = match target.split_once('?') {
        Some((p, q)) => (p, q),
        None => (target, ""),
    };
    let mut code = None;
    let mut state = None;
    for pair in query.split('&') {
        match pair.split_once('=') {
            Some(("code", v)) if !v.is_empty() => code = Some(v),
            Some(("state", v)) if !v.is_empty() => state = Some(v),
            _ => {}
        }
    }
    (path, code, state)
}

/// How a token-endpoint call failed. The distinction is load-bearing: a
/// rejected grant is dead and its credential should be discarded, while an
/// unreachable endpoint says nothing about the credential — clearing it for
/// a network blip would sign the user out for being offline.
#[derive(Debug, PartialEq)]
pub(crate) enum TokenEndpointError {
    /// GitHub answered and said no — the grant is dead.
    Rejected(String),
    /// GitHub could not be reached or answered abnormally — try again later.
    Unreachable(String),
}

impl std::fmt::Display for TokenEndpointError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            TokenEndpointError::Rejected(m) | TokenEndpointError::Unreachable(m) => f.write_str(m),
        }
    }
}

/// Turn GitHub's token-endpoint JSON into a stored token. GitHub reports
/// grant failures as 200s with an `error` field, so that is checked first.
pub(crate) fn token_from_response(v: &Value, now: u64) -> Result<StoredToken, TokenEndpointError> {
    if let Some(err) = v["error"].as_str() {
        return Err(TokenEndpointError::Rejected(
            v["error_description"].as_str().unwrap_or(err).to_string(),
        ));
    }
    let access = v["access_token"]
        .as_str()
        .filter(|t| valid_token_bytes(t))
        .ok_or_else(|| TokenEndpointError::Unreachable("GitHub returned no usable access token".into()))?;
    Ok(StoredToken {
        access: access.to_string(),
        refresh: v["refresh_token"].as_str().map(str::to_string),
        expires_at: v["expires_in"].as_u64().map(|secs| now + secs),
    })
}

fn post_token_endpoint(agent: &ureq::Agent, payload: Value) -> Result<StoredToken, TokenEndpointError> {
    let response = agent
        .post("https://github.com/login/oauth/access_token")
        .set("Accept", "application/json")
        .send_json(payload)
        .map_err(|e| match e {
            // A 4xx is GitHub's verdict on the grant; 5xx and transport
            // errors say nothing about it.
            ureq::Error::Status(code @ 400..=499, _) => {
                TokenEndpointError::Rejected(format!("GitHub answered HTTP {code}"))
            }
            ureq::Error::Status(code, _) => {
                TokenEndpointError::Unreachable(format!("GitHub answered HTTP {code}"))
            }
            other => TokenEndpointError::Unreachable(other.to_string()),
        })?;
    let body: Value = response
        .into_json()
        .map_err(|e| TokenEndpointError::Unreachable(format!("unreadable token response: {e}")))?;
    token_from_response(&body, now_unix())
}

/// Exchange an authorization code for a token. Both failure kinds read the
/// same to the sign-in flow — it retries by signing in again.
fn exchange_code(agent: &ureq::Agent, app: &OauthApp, code: &str) -> Result<StoredToken, String> {
    post_token_endpoint(
        agent,
        json!({
            "client_id": app.client_id,
            "client_secret": app.client_secret,
            "code": code,
            "redirect_uri": REDIRECT_URI,
        }),
    )
    .map_err(|e| e.to_string())
}

/// Confirm a freshly-exchanged token actually answers as an account BEFORE it
/// overwrites the stored credential. Without this, a transient failure after
/// storing leaves the UI reporting the old account while every request runs
/// as the new one — the invariant the old validate-before-store flow kept.
fn verify_access(agent: &ureq::Agent, access: &str) -> Result<(), String> {
    let response = agent
        .post("https://api.github.com/graphql")
        .set("Authorization", &format!("Bearer {access}"))
        .set("Accept", "application/vnd.github+json")
        .send_json(json!({ "query": "query { viewer { login } }" }))
        .map_err(|e| match e {
            ureq::Error::Status(code, _) => format!("the new token was not accepted (HTTP {code})"),
            other => format!("could not verify the new token: {other}"),
        })?;
    let body: Value = response
        .into_json()
        .map_err(|e| format!("could not verify the new token: {e}"))?;
    match body["data"]["viewer"]["login"].as_str() {
        Some(_) => Ok(()),
        None => Err("the new token returned no account".into()),
    }
}

/// Trade a refresh token for a fresh access/refresh pair. Refresh tokens are
/// single-use; the caller serialises calls so two threads cannot burn the
/// same one.
pub(crate) fn refresh_grant(
    agent: &ureq::Agent,
    refresh_token: &str,
) -> Result<StoredToken, TokenEndpointError> {
    let app = app_credentials()
        .ok_or_else(|| TokenEndpointError::Unreachable("this build has no OAuth credentials".into()))?;
    post_token_endpoint(
        agent,
        json!({
            "client_id": app.client_id,
            "client_secret": app.client_secret,
            "grant_type": "refresh_token",
            "refresh_token": refresh_token,
        }),
    )
}

fn http_page(status: &str, body: &str) -> String {
    let html = format!(
        "<!doctype html><meta charset=\"utf-8\"><title>Repo Crew</title>\
         <body style=\"font-family:system-ui;display:grid;place-items:center;height:90vh;background:#26261f;color:#d8d5c5\">\
         <div style=\"text-align:center\">{body}</div></body>"
    );
    format!(
        "HTTP/1.1 {status}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{html}",
        html.len()
    )
}

/// What the login thread reports back to the webview.
fn emit_login(app: &tauri::AppHandle, result: Result<(), String>) {
    let payload = match result {
        Ok(()) => json!({ "ok": true }),
        Err(e) => json!({ "ok": false, "error": e }),
    };
    if let Err(e) = app.emit("github-login", payload) {
        log::warn!("could not emit login event: {e}");
    }
}

/// Begin the browser sign-in. Returns the authorize URL as soon as the flow
/// is armed — the browser is opened as a courtesy, but a failure to open it
/// is non-fatal because the returned link can be pasted into any browser on
/// this machine. The outcome arrives as a `github-login` event.
#[tauri::command]
pub fn start_github_login(app: tauri::AppHandle, state: tauri::State<'_, AppState>) -> Result<String, String> {
    let creds = app_credentials()
        .ok_or("this build has no OAuth credentials (REPO_CREW_GH_CLIENT_ID/SECRET were unset at compile time)")?;

    // One flow at a time: the port is the natural lock. A stale listener from
    // an abandoned attempt is told to stop and the port retried briefly.
    if let Some(old) = lock(&state.login_cancel).take() {
        old.store(true, Ordering::Relaxed);
    }
    let listener = bind_with_retry().map_err(|e| {
        format!("could not open the sign-in callback on {CALLBACK_ADDR}: {e}")
    })?;
    listener
        .set_nonblocking(true)
        .map_err(|e| format!("could not configure the callback listener: {e}"))?;

    let csrf = random_state()?;
    let cancel = Arc::new(AtomicBool::new(false));
    *lock(&state.login_cancel) = Some(cancel.clone());

    let url = format!(
        "https://github.com/login/oauth/authorize?client_id={}&redirect_uri={}&state={}",
        creds.client_id,
        // The only reserved characters in the URI are :/ — encode them.
        REDIRECT_URI.replace(':', "%3A").replace('/', "%2F"),
        csrf
    );

    let agent = state.agent.clone();
    let handle = app.clone();
    std::thread::spawn(move || {
        let outcome = wait_for_callback(&listener, &csrf, cancel.as_ref())
            .and_then(|code| exchange_code(&agent, &creds, &code))
            // Verified BEFORE stored: a token that cannot be confirmed must
            // not replace the working credential.
            .and_then(|token| verify_access(&agent, &token.access).map(|()| token))
            .and_then(|token| store_token(&handle, &token));
        match outcome {
            // A user-initiated cancel is silent: the frontend asked for it.
            Err(e) if e == CANCELLED => {}
            other => emit_login(&handle, other),
        }
    });

    if let Err(e) = tauri_plugin_opener::open_url(&url, None::<String>) {
        log::warn!("could not open the browser for sign-in: {e}");
    }
    Ok(url)
}

/// Abandon the in-flight sign-in, if any.
#[tauri::command]
pub fn cancel_github_login(state: tauri::State<'_, AppState>) {
    if let Some(cancel) = lock(&state.login_cancel).take() {
        cancel.store(true, Ordering::Relaxed);
    }
}

const CANCELLED: &str = "__cancelled__";

fn bind_with_retry() -> std::io::Result<TcpListener> {
    // The previous flow's listener closes when its cancel flag is seen, which
    // takes up to one poll interval — retry across that window.
    let mut last = None;
    for _ in 0..12 {
        match TcpListener::bind(CALLBACK_ADDR) {
            Ok(l) => return Ok(l),
            Err(e) => last = Some(e),
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    Err(last.expect("bind loop ran"))
}

/// Accept connections until the GitHub redirect arrives, the deadline passes,
/// or the flow is cancelled. Non-callback requests (favicon probes and the
/// like) get a 404 and the wait continues.
fn wait_for_callback(listener: &TcpListener, csrf: &str, cancel: &AtomicBool) -> Result<String, String> {
    let deadline = Instant::now() + LOGIN_DEADLINE;
    loop {
        if cancel.load(Ordering::Relaxed) {
            return Err(CANCELLED.into());
        }
        if Instant::now() >= deadline {
            return Err("timed out waiting for the browser — try signing in again".into());
        }
        let mut conn = match listener.accept() {
            Ok((conn, _)) => conn,
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                std::thread::sleep(Duration::from_millis(100));
                continue;
            }
            Err(e) => return Err(format!("callback listener failed: {e}")),
        };

        // The request line is all that matters; GitHub sends a plain GET.
        let _ = conn.set_read_timeout(Some(Duration::from_secs(5)));
        let mut buf = [0u8; 4096];
        let n = conn.read(&mut buf).unwrap_or(0);
        let request = String::from_utf8_lossy(&buf[..n]);
        let target = request
            .lines()
            .next()
            .and_then(|line| line.split_whitespace().nth(1))
            .unwrap_or("/");

        let (path, code, returned_state) = parse_callback(target);
        if path != CALLBACK_PATH {
            let _ = conn.write_all(http_page("404 Not Found", "Not here.").as_bytes());
            continue;
        }
        // A bad request must NOT end the wait: anything on this machine (a
        // port scanner, a hostile page firing a cross-origin GET) can reach
        // this port, and letting it kill the listener would deny the real
        // redirect that arrives moments later. Reject and keep waiting; the
        // deadline handles genuine abandonment.
        if returned_state != Some(csrf) {
            log::warn!("ignored a callback request whose state did not match this sign-in");
            let _ = conn.write_all(http_page(
                "400 Bad Request",
                "<h3>Sign-in rejected</h3><p>The request did not come from the sign-in this app started.</p>",
            ).as_bytes());
            continue;
        }
        let Some(code) = code else {
            log::warn!("ignored a callback request that carried no authorization code");
            let _ = conn.write_all(http_page(
                "400 Bad Request",
                "<h3>Sign-in failed</h3><p>GitHub sent no authorization code.</p>",
            ).as_bytes());
            continue;
        };
        let _ = conn.write_all(http_page(
            "200 OK",
            "<h3>Signed in</h3><p>You can close this tab and return to Repo Crew.</p>",
        ).as_bytes());
        return Ok(code.to_string());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_callback_extracts_code_and_state() {
        let (path, code, state) = parse_callback("/callback?code=abc123&state=deadbeef");
        assert_eq!(path, "/callback");
        assert_eq!(code, Some("abc123"));
        assert_eq!(state, Some("deadbeef"));
    }

    #[test]
    fn parse_callback_handles_reordered_and_missing_params() {
        let (_, code, state) = parse_callback("/callback?state=s&code=c");
        assert_eq!((code, state), (Some("c"), Some("s")));
        let (path, code, state) = parse_callback("/favicon.ico");
        assert_eq!(path, "/favicon.ico");
        assert_eq!((code, state), (None, None));
        // Empty values are as good as absent.
        let (_, code, _) = parse_callback("/callback?code=&state=s");
        assert_eq!(code, None);
    }

    #[test]
    fn token_response_with_refresh_fields() {
        let v = serde_json::json!({
            "access_token": "ghu_abc", "expires_in": 28800,
            "refresh_token": "ghr_def", "refresh_token_expires_in": 15811200,
            "token_type": "bearer", "scope": ""
        });
        let t = token_from_response(&v, 1_000).unwrap();
        assert_eq!(t.access, "ghu_abc");
        assert_eq!(t.refresh.as_deref(), Some("ghr_def"));
        assert_eq!(t.expires_at, Some(29_800));
    }

    #[test]
    fn token_response_without_expiry_is_long_lived() {
        let v = serde_json::json!({ "access_token": "ghu_abc", "token_type": "bearer", "scope": "" });
        let t = token_from_response(&v, 1_000).unwrap();
        assert_eq!(t.refresh, None);
        assert_eq!(t.expires_at, None);
    }

    #[test]
    fn token_response_error_field_is_a_definitive_rejection() {
        let v = serde_json::json!({
            "error": "bad_verification_code",
            "error_description": "The code passed is incorrect or expired."
        });
        assert_eq!(
            token_from_response(&v, 0).unwrap_err(),
            TokenEndpointError::Rejected("The code passed is incorrect or expired.".into())
        );
    }

    #[test]
    fn token_response_malformed_body_is_not_a_rejection() {
        // A weird body must not read as "the grant is dead" — that verdict
        // deletes credentials.
        let v = serde_json::json!({ "access_token": "bad token\r\n" });
        assert!(matches!(
            token_from_response(&v, 0),
            Err(TokenEndpointError::Unreachable(_))
        ));
    }
}
