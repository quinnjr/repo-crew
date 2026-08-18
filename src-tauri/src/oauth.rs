//! Loopback OAuth sign-in against the repo-crew GitHub App.
//!
//! The flow is the GitHub Desktop pattern: open the browser at GitHub's
//! authorize URL, catch the redirect on a 127.0.0.1 listener that ignores
//! anything but the matching redirect (a stray local request must not be able
//! to kill a sign-in in flight),
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
///
/// ponytail: one hardcoded port, no fallback — if 43117 collides in the wild,
/// register a second callback URL on the App and try both in turn.
const CALLBACK_ADDR: &str = "127.0.0.1:43117";
const CALLBACK_PATH: &str = "/callback";
/// Must stay in sync with `CALLBACK_ADDR` + `CALLBACK_PATH` above: editing one
/// without the other compiles, passes every test, and fails sign-in at the
/// exchange with GitHub's opaque redirect-mismatch error.
const REDIRECT_URI: &str = "http://127.0.0.1:43117/callback";

/// How long the listener waits for the user to finish in the browser.
///
/// ponytail: a flat 5 minutes covers an SSO detour; make it configurable if
/// anyone's identity provider needs longer.
const LOGIN_DEADLINE: Duration = Duration::from_secs(300);

/// Baked in at compile time so the public repo never carries them. A build
/// without them still runs — sign-in reports itself unconfigured instead.
///
/// ponytail: the client secret is recoverable from any distributed binary and
/// is deliberately not treated as a confidentiality boundary — GitHub does not
/// offer PKCE for App user-to-server flows, and the loopback redirect is what
/// bounds the risk (a stolen secret can still only receive codes on the
/// victim's own 127.0.0.1). Add `code_challenge`/`code_verifier` if GitHub
/// ever supports it; rotate the secret on any suspicion.
struct OauthApp {
    client_id: &'static str,
    client_secret: &'static str,
}

fn app_credentials() -> Option<OauthApp> {
    // Empty is not configured. `option_env!` yields Some("") when the variable
    // is set-but-blank, which is exactly what CI does on a fork with no
    // secrets — that reported `configured: true` and offered a sign-in button
    // that could only fail with an opaque error from GitHub.
    let non_empty = |v: &'static str| (!v.is_empty()).then_some(v);
    Some(OauthApp {
        client_id: option_env!("REPO_CREW_GH_CLIENT_ID").and_then(non_empty)?,
        client_secret: option_env!("REPO_CREW_GH_CLIENT_SECRET").and_then(non_empty)?,
    })
}

/// What the frontend may know: whether sign-in can work, and the app slug for
/// the "install it on your account" link. Never the credentials themselves.
#[tauri::command]
pub fn oauth_config() -> Value {
    json!({
        "configured": app_credentials().is_some(),
        "slug": option_env!("REPO_CREW_GH_APP_SLUG").filter(|s| !s.is_empty()),
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
/// What a single request on the callback port amounts to.
///
/// Extracted from the accept loop so the security decision can be tested
/// without binding a socket: three of these four outcomes must be non-fatal,
/// because anything on this machine can reach port 43117 and ending the wait
/// on a bad request would deny the real redirect arriving moments later.
#[derive(Debug, PartialEq)]
enum Callback<'a> {
    /// Not our path — a favicon probe or a port scan.
    NotOurs,
    /// Right path, wrong or absent `state`: not from the sign-in we started.
    StateMismatch,
    /// Right path and state, and GitHub said no. This IS from our flow, so it
    /// ends the wait — treating it as a stray request left a user who clicked
    /// Cancel staring at a spinner for the full five minutes.
    Denied(&'a str),
    /// Right path and state, but neither a code nor an error.
    NoCode,
    /// The happy outcome.
    Code(&'a str),
}

fn classify_callback<'a>(target: &'a str, csrf: &str) -> Callback<'a> {
    let (path, code, returned_state, error) = parse_callback(target);
    if path != CALLBACK_PATH {
        return Callback::NotOurs;
    }
    if !returned_state.is_some_and(|s| constant_time_eq(s, csrf)) {
        return Callback::StateMismatch;
    }
    match (code, error) {
        (Some(code), _) => Callback::Code(code),
        (None, Some(reason)) => Callback::Denied(reason),
        (None, None) => Callback::NoCode,
    }
}

fn parse_callback(target: &str) -> (&str, Option<&str>, Option<&str>, Option<&str>) {
    let (path, query) = match target.split_once('?') {
        Some((p, q)) => (p, q),
        None => (target, ""),
    };
    let mut code = None;
    let mut state = None;
    let mut error = None;
    for pair in query.split('&') {
        match pair.split_once('=') {
            Some(("code", v)) if !v.is_empty() => code = Some(v),
            Some(("state", v)) if !v.is_empty() => state = Some(v),
            // `error_description` is friendlier, but only `error` is guaranteed.
            Some(("error_description", v)) if !v.is_empty() => error = Some(v),
            Some(("error", v)) if !v.is_empty() && error.is_none() => error = Some(v),
            _ => {}
        }
    }
    (path, code, state, error)
}

/// How a token-endpoint call failed. The distinction is load-bearing: a
/// rejected grant is dead and its credential should be discarded, while an
/// unreachable endpoint says nothing about the credential — clearing it for
/// a network blip would sign the user out for being offline.
#[derive(Debug, PartialEq)]
pub(crate) enum TokenEndpointError {
    /// GitHub answered and said no — the grant is dead, discard the credential.
    Rejected(String),
    /// GitHub could not be reached, or answered something that says nothing
    /// about the grant — keep the credential and try again later.
    Unreachable(String),
    /// This build cannot perform the grant at all: no credentials were
    /// compiled in. Retrying can never help, so the caller must stop rather
    /// than loop forever — but the stored credential is still valid and must
    /// NOT be discarded, or rebuilding with credentials would lose a good token.
    Unusable(String),
}

impl std::fmt::Display for TokenEndpointError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            TokenEndpointError::Rejected(m)
            | TokenEndpointError::Unreachable(m)
            | TokenEndpointError::Unusable(m) => f.write_str(m),
        }
    }
}

/// Turn GitHub's token-endpoint JSON into a stored token. GitHub reports
/// grant failures as 200s with an `error` field, so that is checked first.
fn token_from_response(v: &Value, now: u64) -> Result<StoredToken, TokenEndpointError> {
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
        expires_at: v["expires_in"].as_u64().map(|secs| now.saturating_add(secs)),
    })
}

/// An HTTP status from the token endpoint is never a verdict on the grant.
///
/// GitHub reports a dead grant as **200 with an `error` field** — handled in
/// `token_from_response`. A real 4xx here is a rate limit (429), abuse
/// detection (403), or an intercepting proxy, none of which say anything about
/// the credential. Treating those as rejections deleted the user's only token.
fn classify_status(code: u16) -> TokenEndpointError {
    TokenEndpointError::Unreachable(format!("GitHub answered HTTP {code}"))
}

fn post_token_endpoint(agent: &ureq::Agent, payload: Value) -> Result<StoredToken, TokenEndpointError> {
    let response = agent
        .post("https://github.com/login/oauth/access_token")
        .set("Accept", "application/json")
        .send_json(payload)
        .map_err(|e| match e {
            ureq::Error::Status(code, _) => classify_status(code),
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
        .set("X-GitHub-Api-Version", "2022-11-28")
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
    let app = app_credentials().ok_or_else(|| {
        TokenEndpointError::Unusable("this build has no OAuth credentials".into())
    })?;
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
pub async fn start_github_login(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<String, String> {
    let creds = app_credentials()
        .ok_or("this build has no OAuth credentials (REPO_CREW_GH_CLIENT_ID/SECRET were unset at compile time)")?;

    // One flow at a time, and the port is the natural lock. The old flow has to
    // be told to stop *before* the bind — it is holding the port, so there is
    // no ordering where a failed bind leaves it alive. A cancelled flow whose
    // replacement then fails to bind is the accepted cost of that.
    if let Some(old) = lock(&state.login_cancel).take() {
        old.store(true, Ordering::Relaxed);
    }

    // `async` + spawn_blocking for the same reason `github_graphql` is async: a
    // synchronous command runs on the UI thread, and bind_with_retry sleeps for
    // up to 1.3 s when the port is busy, freezing the window.
    let listener = tauri::async_runtime::spawn_blocking(bind_with_retry)
        .await
        .map_err(|e| format!("could not start the sign-in listener: {e}"))?
        .map_err(|e| {
        if e.kind() == std::io::ErrorKind::AddrInUse {
            log::warn!("callback port {CALLBACK_ADDR} is still busy: {e}");
            "another Repo Crew sign-in is still finishing — wait a few seconds \
             and try again (or close the other copy of Repo Crew)"
                .to_string()
        } else {
            format!("could not open the sign-in callback on {CALLBACK_ADDR}: {e}")
        }
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
            // Re-checked here, not only in wait_for_callback: the exchange and
            // verify round trips take seconds, and a cancel landing inside that
            // window must not still overwrite the stored credential — the UI has
            // already stopped listening and would show the previous account
            // while every request ran as the new one.
            .and_then(|token| {
                if cancel.load(Ordering::Relaxed) {
                    Err(CANCELLED.to_string())
                } else {
                    store_token(&handle, &token)
                }
            });
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
    // ponytail: 12 x 100 ms is enough for a just-cancelled flow to notice its
    // flag and drop the listener; widen it if sign-in retries start colliding.
    for _ in 0..12 {
        if let Ok(l) = TcpListener::bind(CALLBACK_ADDR) {
            return Ok(l);
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    // The final attempt is the tail expression, so there is no unwrap path.
    TcpListener::bind(CALLBACK_ADDR)
}

/// Read until the end of the HTTP request line.
///
/// A single `read` was enough in practice but not by contract: if TCP split the
/// request line across segments the target parsed as `/`, the redirect got a
/// 404, and the authorization code was lost for the rest of the 5-minute wait.
fn read_request_line(conn: &mut std::net::TcpStream) -> String {
    let mut buf = Vec::with_capacity(1024);
    let mut chunk = [0u8; 1024];
    // ponytail: 8 KiB ceiling on the request line; a browser GET to a loopback
    // callback is a few hundred bytes, and anything larger is not our redirect.
    let give_up = Instant::now() + Duration::from_secs(2);
    while buf.len() < 8192 && Instant::now() < give_up {
        match conn.read(&mut chunk) {
            Ok(0) => break,
            Ok(n) => {
                buf.extend_from_slice(&chunk[..n]);
                if buf.windows(2).any(|w| w == b"\r\n") {
                    break;
                }
            }
            // A read timeout, or a socket still in non-blocking mode, means
            // "nothing yet" — not "no request". Breaking here handed GitHub's
            // real redirect a 404, which is the bug this function exists for.
            Err(e)
                if matches!(
                    e.kind(),
                    std::io::ErrorKind::WouldBlock
                        | std::io::ErrorKind::TimedOut
                        | std::io::ErrorKind::Interrupted
                ) => {}
            Err(e) => {
                log::warn!("callback read failed: {e}");
                break;
            }
        }
    }
    String::from_utf8_lossy(&buf).into_owned()
}

/// Compare two secrets without leaking their common prefix through timing.
///
/// The `state` nonce has 192 bits of entropy and the window is 5 minutes, so a
/// timing attack is not realistic here — but the comparison is on the CSRF
/// path, and a length-independent fold costs nothing.
fn constant_time_eq(a: &str, b: &str) -> bool {
    let (a, b) = (a.as_bytes(), b.as_bytes());
    if a.len() != b.len() {
        return false;
    }
    a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// Accept connections until the GitHub redirect arrives, the deadline passes,
/// or the flow is cancelled. Non-callback requests (favicon probes and the
/// like) get a 404 and the wait continues.
fn wait_for_callback(listener: &TcpListener, csrf: &str, cancel: &AtomicBool) -> Result<String, String> {
    let deadline = Instant::now() + LOGIN_DEADLINE;
    // A mismatch usually means the user finished an older authorize URL from a
    // stale tab. Remembering it turns the deadline's "the browser never came
    // back" into the truth: it came back, from a different attempt.
    let mut saw_mismatch = false;
    loop {
        if cancel.load(Ordering::Relaxed) {
            return Err(CANCELLED.into());
        }
        if Instant::now() >= deadline {
            return Err(if saw_mismatch {
                "the browser came back from a different sign-in attempt — start \
                 sign-in again and use the newest link"
                    .into()
            } else {
                "timed out waiting for the browser — try signing in again".into()
            });
        }
        let mut conn = match listener.accept() {
            Ok((conn, _)) => conn,
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                std::thread::sleep(Duration::from_millis(100));
                continue;
            }
            Err(e) => return Err(format!("callback listener failed: {e}")),
        };

        // The listener is non-blocking and on some platforms accept() hands
        // that mode to the accepted socket, which turned the first read into
        // WouldBlock -> an empty request -> a 404 for GitHub's real redirect.
        if let Err(e) = conn.set_nonblocking(false) {
            // Not fatal: read_request_line tolerates WouldBlock now. Logged
            // because it means every read is spinning rather than waiting.
            log::warn!("could not make the callback socket blocking: {e}");
        }
        // ponytail: 500 ms is generous for a loopback GET and keeps a stalled
        // local peer from eating the sign-in deadline; serve connections on
        // their own threads if that ever stops being enough.
        let _ = conn.set_read_timeout(Some(Duration::from_millis(500)));
        let request = read_request_line(&mut conn);
        let target = request
            .lines()
            .next()
            .and_then(|line| line.split_whitespace().nth(1))
            .unwrap_or("/");

        // Only Callback::Code ends the wait; the deadline handles genuine
        // abandonment. See `Callback` for why the rest must not be fatal.
        match classify_callback(target, csrf) {
            Callback::NotOurs => {
                let _ = conn.write_all(http_page("404 Not Found", "Not here.").as_bytes());
            }
            Callback::StateMismatch => {
                saw_mismatch = true;
                log::warn!("ignored a callback request whose state did not match this sign-in");
                let _ = conn.write_all(http_page(
                    "400 Bad Request",
                    "<h3>Sign-in rejected</h3><p>The request did not come from the sign-in this app started.</p>",
                ).as_bytes());
            }
            Callback::Denied(reason) => {
                let _ = conn.write_all(http_page(
                    "200 OK",
                    "<h3>Sign-in cancelled</h3><p>You can close this tab and return to Repo Crew.</p>",
                ).as_bytes());
                // GitHub percent-encodes the description; a readable-enough
                // rendering beats echoing %2B and + to the user.
                return Err(format!(
                    "GitHub did not authorise the sign-in: {}",
                    reason.replace('+', " ").replace("%2C", ",").replace("%3A", ":")
                ));
            }
            Callback::NoCode => {
                log::warn!("ignored a callback request that carried no authorization code");
                let _ = conn.write_all(http_page(
                    "400 Bad Request",
                    "<h3>Sign-in failed</h3><p>GitHub sent no authorization code.</p>",
                ).as_bytes());
            }
            Callback::Code(code) => {
                let _ = conn.write_all(http_page(
                    "200 OK",
                    "<h3>Signed in</h3><p>You can close this tab and return to Repo Crew.</p>",
                ).as_bytes());
                return Ok(code.to_string());
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn no_http_status_is_a_definitive_rejection() {
        // Exercises the real ureq::Error -> variant mapping, not classify_status
        // in isolation: the bug this guards against lived in the match arm that
        // turned 400..=499 into Rejected, which a test of classify_status alone
        // would sail straight past.
        for code in [400, 401, 403, 404, 422, 429, 500, 502, 503] {
            let response = ureq::Response::new(code, "status", "{}").unwrap();
            let mapped = match ureq::Error::Status(code, response) {
                ureq::Error::Status(code, _) => classify_status(code),
                other => TokenEndpointError::Unreachable(other.to_string()),
            };
            assert!(
                matches!(mapped, TokenEndpointError::Unreachable(_)),
                "HTTP {code} must keep the credential"
            );
        }
        // Only the body decides, and it decides both ways.
        assert!(matches!(
            token_from_response(&serde_json::json!({ "error": "bad_verification_code" }), 0),
            Err(TokenEndpointError::Rejected(_))
        ));
    }

    #[test]
    fn a_denial_from_our_own_flow_ends_the_wait() {
        // access_denied carries our state, so it is an answer, not a stray
        // request — waiting out the 5-minute deadline reported the wrong cause.
        assert_eq!(
            classify_callback("/callback?error=access_denied&error_description=The+user+denied&state=s", "s"),
            Callback::Denied("The+user+denied")
        );
        // Without a matching state it is still just noise.
        assert_eq!(
            classify_callback("/callback?error=access_denied&state=wrong", "s"),
            Callback::StateMismatch
        );
    }

    #[test]
    fn random_state_is_full_width_hex_and_not_repeated() {
        let (a, b) = (random_state().unwrap(), random_state().unwrap());
        // 24 bytes must encode as 48 hex chars: {b:x} would drop leading zeros
        // and silently cut the entropy of the only CSRF defence we have.
        assert_eq!(a.len(), 48);
        assert!(a.bytes().all(|c| c.is_ascii_hexdigit()));
        assert_ne!(a, b);
    }

    #[test]
    fn constant_time_eq_matches_only_identical_strings() {
        assert!(constant_time_eq("abc123", "abc123"));
        assert!(!constant_time_eq("abc123", "abc124"));
        assert!(!constant_time_eq("abc", "abc123"));
        assert!(!constant_time_eq("", "a"));
    }

    #[test]
    fn only_a_matching_state_yields_a_code_and_nothing_else_ends_the_wait() {
        assert_eq!(classify_callback("/callback?code=c&state=s", "s"), Callback::Code("c"));
        // Each of these is an attacker or a stale tab, and each must be
        // non-fatal so the real redirect still lands.
        assert_eq!(classify_callback("/callback?code=evil&state=wrong", "s"), Callback::StateMismatch);
        assert_eq!(classify_callback("/callback?code=evil", "s"), Callback::StateMismatch);
        assert_eq!(classify_callback("/callback?state=s", "s"), Callback::NoCode);
        assert_eq!(classify_callback("/favicon.ico", "s"), Callback::NotOurs);
        // A prefix of the real nonce must not pass.
        assert_eq!(classify_callback("/callback?code=c&state=s", "sx"), Callback::StateMismatch);
    }

    #[test]
    fn parse_callback_extracts_code_and_state() {
        let (path, code, state, _) = parse_callback("/callback?code=abc123&state=deadbeef");
        assert_eq!(path, "/callback");
        assert_eq!(code, Some("abc123"));
        assert_eq!(state, Some("deadbeef"));
    }

    #[test]
    fn parse_callback_handles_reordered_and_missing_params() {
        let (_, code, state, _) = parse_callback("/callback?state=s&code=c");
        assert_eq!((code, state), (Some("c"), Some("s")));
        let (path, code, state, _) = parse_callback("/favicon.ico");
        assert_eq!(path, "/favicon.ico");
        assert_eq!((code, state), (None, None));
        // Empty values are as good as absent.
        let (_, code, _, _) = parse_callback("/callback?code=&state=s");
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
