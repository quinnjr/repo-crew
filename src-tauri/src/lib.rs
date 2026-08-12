use keyring::Entry;
use serde_json::{json, Value};
use std::fs;
use std::io;
use std::path::Path;
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;
use tauri::Manager;

mod oauth;

/// Keychain coordinates, matching the bundle identifier in `tauri.conf.json`.
///
/// Treat these as frozen from the first release onward: changing either one
/// orphans every token already stored by an installed copy of the app, with no
/// migration path, because the old entry is no longer addressable.
const KEYRING_SERVICE: &str = "dev.quinnjr.repo-crew";
const KEYRING_USER: &str = "github-token";

/// Pre-keychain releases wrote the token here in plaintext. Kept only so an
/// existing install can be migrated and the file deleted.
const LEGACY_TOKEN_FILE: &str = "token.txt";

const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const READ_TIMEOUT: Duration = Duration::from_secs(30);

/// The credential as it lives in the keychain, serialised as JSON.
///
/// `refresh`/`expires_at` are absent when GitHub issues a non-expiring token
/// (user-token expiry disabled on the app). Values stored by pre-OAuth
/// versions are bare PAT strings — `parse_stored` accepts those too, so an
/// existing install stays signed in until it signs out.
#[derive(Clone, Debug, PartialEq, serde::Serialize, serde::Deserialize)]
pub(crate) struct StoredToken {
    pub(crate) access: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) refresh: Option<String>,
    /// Unix seconds after which `access` stops working.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) expires_at: Option<u64>,
}

pub(crate) struct AppState {
    /// In-process cache so a fleet sweep does not hit the keychain once per
    /// query — some backends prompt or rate-limit on repeated reads. Cleared
    /// when GitHub rejects the token, so a revoked credential does not keep
    /// being re-sent for the rest of the process lifetime.
    token: Mutex<Option<StoredToken>>,
    /// The access token GitHub last answered 401 to (and that could not be
    /// refreshed). Without this, the 401 clears the cache and the very next
    /// query reads the same dead token straight back out of the keychain —
    /// an infinite 401 loop that never reaches the sign-in screen.
    rejected: Mutex<Option<String>>,
    /// Refresh tokens are single-use: this gate serialises refreshes so two
    /// parallel queries cannot burn the same one (the loser would sign the
    /// whole app out).
    refresh_gate: Mutex<()>,
    /// Cancel flag for the in-flight browser sign-in, if any.
    pub(crate) login_cancel: Mutex<Option<Arc<AtomicBool>>>,
    /// One agent for the whole process: connection pooling and keep-alive,
    /// instead of a fresh TLS handshake per query.
    pub(crate) agent: ureq::Agent,
}

/// Survive a poisoned mutex rather than panicking. The token path is exactly
/// where a previous panic should degrade instead of cascading.
pub(crate) fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

pub(crate) fn now_unix() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn entry() -> Result<Entry, String> {
    Entry::new(KEYRING_SERVICE, KEYRING_USER).map_err(|e| format!("keychain unavailable: {e}"))
}

/// A token goes into an `Authorization` header, where a control byte turns
/// into a malformed request (or worse, header injection). GitHub tokens are
/// ASCII; anything else was a paste accident.
pub(crate) fn valid_token_bytes(token: &str) -> bool {
    !token.is_empty() && token.bytes().all(|b| b.is_ascii_graphic())
}

/// Read a keychain value into a token: JSON from an OAuth sign-in, or a bare
/// string from a pre-OAuth install (treated as a non-expiring access token).
pub(crate) fn parse_stored(raw: &str) -> Option<StoredToken> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    match serde_json::from_str::<StoredToken>(trimmed) {
        Ok(token) if valid_token_bytes(&token.access) => Some(token),
        Ok(_) => None,
        Err(_) => valid_token_bytes(trimmed).then(|| StoredToken {
            access: trimmed.to_string(),
            refresh: None,
            expires_at: None,
        }),
    }
}

/// The precedence seam between the storage layers, pure so it can be tested
/// without a keychain: cache wins, blank/malformed values fall through, and
/// an access token GitHub already rejected never comes back.
fn pick_stored(
    cached: Option<StoredToken>,
    stored_raw: Option<String>,
    rejected: Option<&str>,
) -> Option<StoredToken> {
    cached
        .into_iter()
        .chain(stored_raw.as_deref().and_then(parse_stored))
        .find(|t| Some(t.access.as_str()) != rejected)
}

/// Refresh a minute early so a token cannot expire between this check and the
/// request that uses it.
pub(crate) fn needs_refresh(expires_at: Option<u64>, now: u64) -> bool {
    matches!(expires_at, Some(t) if now + 60 >= t)
}

/// Overwrite then unlink. An unlink alone leaves the plaintext token
/// recoverable from the freed blocks; zeroing first is best-effort (no sync,
/// no rename dance) but strictly better than not trying.
fn remove_legacy_file(path: &Path) -> Result<(), String> {
    let meta = match fs::metadata(path) {
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(format!("could not inspect {}: {e}", path.display())),
        Ok(meta) => meta,
    };
    let _ = fs::write(path, vec![0u8; meta.len() as usize]);
    fs::remove_file(path).map_err(|e| format!("could not remove {}: {e}", path.display()))
}

/// Move a plaintext token from the old config file into the keychain, then
/// shred the file. Silent on failure: a missing legacy file is the norm.
fn migrate_legacy_token(app: &tauri::AppHandle) -> Option<String> {
    let path = app.path().app_config_dir().ok()?.join(LEGACY_TOKEN_FILE);
    let token = fs::read_to_string(&path).ok()?.trim().to_string();
    if token.is_empty() {
        let _ = remove_legacy_file(&path);
        return None;
    }
    match entry().and_then(|e| e.set_password(&token).map_err(|e| e.to_string())) {
        Ok(()) => {
            let _ = remove_legacy_file(&path);
            log::info!("migrated GitHub token from config file into the system keychain");
            Some(token)
        }
        Err(e) => {
            // Leave the file alone rather than lose the only copy of the token.
            log::warn!("could not migrate token into the keychain: {e}");
            Some(token)
        }
    }
}

/// Read the keychain, keeping "no entry" distinct from "cannot ask".
///
/// A locked or absent Secret Service is not the same as a missing token:
/// reporting it as missing would route the user to sign-in and invite them to
/// authorize into a keychain that cannot store the result.
fn read_keychain() -> Result<Option<String>, String> {
    match entry()?.get_password() {
        Ok(t) => Ok(Some(t)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(format!("could not read the keychain: {e}")),
    }
}

/// Persist a token everywhere it lives: keychain first (the durable copy),
/// then the in-process cache. A fresh credential also clears the rejected
/// marker — it has earned a fresh chance.
pub(crate) fn store_token(app: &tauri::AppHandle, token: &StoredToken) -> Result<(), String> {
    let state = app.state::<AppState>();
    let raw = serde_json::to_string(token).map_err(|e| format!("could not encode the token: {e}"))?;
    entry()?
        .set_password(&raw)
        .map_err(|e| format!("could not save to the keychain: {e}"))?;
    *lock(&state.token) = Some(token.clone());
    *lock(&state.rejected) = None;
    Ok(())
}

/// Resolve the credential from cache, then the keychain, then the legacy
/// file. `Ok(None)` means signed out; `Err` means the keychain itself is
/// unusable. Note this is not side-effect free: on first call it may perform
/// the legacy migration (writing the keychain and deleting `token.txt`).
fn resolve_token(app: &tauri::AppHandle, state: &AppState) -> Result<Option<StoredToken>, String> {
    if let Some(cached) = lock(&state.token).clone() {
        return Ok(Some(cached));
    }
    let stored = read_keychain()?;
    let rejected = lock(&state.rejected).clone();
    let token = pick_stored(None, stored, rejected.as_deref())
        .or_else(|| pick_stored(None, migrate_legacy_token(app), rejected.as_deref()));
    if let Some(t) = &token {
        *lock(&state.token) = Some(t.clone());
    }
    Ok(token)
}

/// What a refresh attempt concluded — the caller acts differently on each.
enum RefreshOutcome {
    /// A fresh (or freshly-observed) credential to use.
    Refreshed(StoredToken),
    /// GitHub declared the credential dead; it has been cleared.
    Rejected,
    /// GitHub could not be asked. The credential is untouched: a network
    /// blip at the wrong moment must not sign the user out.
    Unreachable(String),
}

/// Trade the refresh token for a new pair, serialised through `refresh_gate`.
///
/// If another thread already refreshed while this one waited at the gate, its
/// result is reused instead of burning the (single-use) refresh token twice.
/// Only a definitive rejection clears the stored credential: the pair is dead
/// then, and keeping it would loop the app through 401s forever. An expired
/// token with no refresh token is equally dead and cleared the same way.
fn refresh_and_store(app: &tauri::AppHandle, stale: &StoredToken) -> RefreshOutcome {
    let state = app.state::<AppState>();
    let _gate = lock(&state.refresh_gate);

    if let Some(current) = lock(&state.token).clone() {
        if current.access != stale.access {
            return RefreshOutcome::Refreshed(current);
        }
    }
    let Some(refresh) = stale.refresh.clone() else {
        log::info!("token expired with no refresh token; clearing the dead credential");
        let _ = clear_stored(app);
        return RefreshOutcome::Rejected;
    };
    match oauth::refresh_grant(&state.agent, &refresh) {
        Ok(fresh) => {
            if let Err(e) = store_token(app, &fresh) {
                // The new token works for this session even if it could not
                // be persisted; the next launch just signs in again.
                log::warn!("refreshed the token but could not store it: {e}");
                *lock(&state.token) = Some(fresh.clone());
            }
            RefreshOutcome::Refreshed(fresh)
        }
        Err(oauth::TokenEndpointError::Rejected(e)) => {
            log::warn!("GitHub rejected the refresh token: {e}");
            let _ = clear_stored(app);
            RefreshOutcome::Rejected
        }
        Err(oauth::TokenEndpointError::Unreachable(e)) => {
            log::warn!("could not reach GitHub to refresh the token: {e}");
            RefreshOutcome::Unreachable(e)
        }
    }
}

/// Remove the credential everywhere. See `clear_token` for the ordering
/// rationale.
fn clear_stored(app: &tauri::AppHandle) -> Result<(), String> {
    let state = app.state::<AppState>();
    let keychain = match entry() {
        Ok(e) => match e.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(format!("could not clear the keychain entry: {e}")),
        },
        Err(e) => Err(e),
    };

    let legacy = match app.path().app_config_dir() {
        Ok(dir) => remove_legacy_file(&dir.join(LEGACY_TOKEN_FILE)),
        Err(e) => Err(format!(
            "could not locate the config dir to clear the legacy token file: {e}"
        )),
    };

    *lock(&state.token) = None;
    *lock(&state.rejected) = None;
    keychain.and(legacy)
}

/// Remove the credential everywhere (access and refresh token together).
///
/// The keychain entry goes first: clearing the cache before a delete that then
/// fails would leave the app "logged out" while the credential survives on
/// disk, silently signing the user back in on the next launch. The legacy
/// file is shredded, and an unresolvable config dir is reported rather than
/// swallowed — that is the one case where a plaintext copy could survive a
/// "sign out" without the user hearing about it.
#[tauri::command]
fn clear_token(app: tauri::AppHandle) -> Result<(), String> {
    clear_stored(&app)
}

/// Reports whether a credential is stored — never the credential itself, so
/// secrets stay out of the webview. `Err` means the keychain cannot be asked
/// (locked or missing Secret Service), which the frontend surfaces instead of
/// showing sign-in. See `resolve_token` for its migration side effect.
#[tauri::command]
fn has_token(app: tauri::AppHandle, state: tauri::State<'_, AppState>) -> Result<bool, String> {
    resolve_token(&app, &state).map(|t| t.is_some())
}

/// The blocking body of `github_graphql`: resolve (refreshing an expired
/// token proactively), send, and on an unexpected 401 refresh-and-retry once
/// before declaring the session dead.
fn execute_graphql(app: &tauri::AppHandle, payload: Value) -> Value {
    let state = app.state::<AppState>();

    let mut token = match resolve_token(app, &state) {
        Ok(Some(t)) => t,
        Ok(None) => return json!({ "ok": false, "error": "not_authenticated", "status": 0 }),
        Err(e) => {
            return json!({ "ok": false, "error": "keychain_unavailable", "detail": e, "status": 0 })
        }
    };

    if needs_refresh(token.expires_at, now_unix()) {
        token = match refresh_and_store(app, &token) {
            RefreshOutcome::Refreshed(t) => t,
            RefreshOutcome::Rejected => {
                return json!({ "ok": false, "error": "not_authenticated", "status": 0 })
            }
            // GitHub is unreachable for refreshes, but this request may still
            // land inside the 60 s early-refresh window — and if the token is
            // truly dead, the 401 path below reports the real situation.
            RefreshOutcome::Unreachable(_) => token,
        };
    }

    let mut refreshed = false;
    loop {
        let response = state
            .agent
            .post("https://api.github.com/graphql")
            .set("Authorization", &format!("Bearer {}", token.access))
            .set("Accept", "application/vnd.github+json")
            .set("X-GitHub-Api-Version", "2022-11-28")
            // By reference: cloning the whole query tree on every send would
            // tax each of the many calls in a sweep for the sake of the rare
            // once-per-8-hours retry below.
            .send_json(&payload);

        return match response {
            Ok(resp) => {
                let status = resp.status();
                match resp.into_json::<Value>() {
                    Ok(body) => json!({ "ok": true, "status": status, "data": body }),
                    Err(e) => json!({ "ok": false, "error": e.to_string(), "status": status }),
                }
            }
            Err(ureq::Error::Status(401, resp)) => {
                // An 8-hour token can die mid-session; one refresh gets the
                // sweep back without a trip through the sign-in screen.
                if !refreshed && token.refresh.is_some() {
                    refreshed = true;
                    match refresh_and_store(app, &token) {
                        RefreshOutcome::Refreshed(fresh) => {
                            token = fresh;
                            continue;
                        }
                        RefreshOutcome::Rejected => {
                            return json!({ "ok": false, "error": "not_authenticated", "status": 401 })
                        }
                        // The access token 401'd but the refresh endpoint is
                        // unreachable — report a transient failure and keep
                        // the credential; the next request tries again.
                        RefreshOutcome::Unreachable(e) => {
                            return json!({
                                "ok": false,
                                "error": format!("could not refresh the session: {e}"),
                                "status": 0
                            })
                        }
                    }
                }
                // The credential no longer works; stop re-sending it AND stop
                // re-reading it out of the keychain on the next query.
                *lock(&state.token) = None;
                *lock(&state.rejected) = Some(token.access.clone());
                let detail = resp.into_string().unwrap_or_default();
                json!({ "ok": false, "error": "not_authenticated", "detail": detail, "status": 401 })
            }
            Err(ureq::Error::Status(code, resp)) => {
                let body = resp.into_string().unwrap_or_default();
                json!({ "ok": false, "error": format!("HTTP {code}"), "detail": body, "status": code })
            }
            Err(e) => json!({ "ok": false, "error": e.to_string(), "status": 0 }),
        };
    }
}

/// Execute a GitHub GraphQL request against api.github.com/graphql.
///
/// Returns `{ ok, status, data?, error?, detail? }`. GraphQL-level errors are
/// reported inside `data.errors`, as GitHub does; `error` is reserved for
/// transport and auth failures. A 401 is normalised to `not_authenticated` so
/// the frontend can route to the sign-in screen instead of showing a raw body.
///
/// `async` + `spawn_blocking` matter: a synchronous command runs on the UI
/// thread, so a fleet sweep would freeze the window for the whole run.
#[tauri::command]
async fn github_graphql(
    app: tauri::AppHandle,
    query: String,
    variables: Option<Value>,
) -> Result<Value, String> {
    let payload = json!({ "query": query, "variables": variables.unwrap_or(json!({})) });
    let handle = app.clone();
    tauri::async_runtime::spawn_blocking(move || execute_graphql(&handle, payload))
        .await
        .map_err(|e| format!("request task failed: {e}"))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // webkit2gtk's DMA-BUF renderer dies with a Wayland protocol error
    // (Gdk "Error 71") under the proprietary NVIDIA driver, killing the
    // window at startup. Disable it only for that combination — and only
    // when the user has not set the variable themselves — so every other
    // GPU keeps the accelerated path.
    #[cfg(target_os = "linux")]
    if std::path::Path::new("/proc/driver/nvidia").exists()
        && std::env::var_os("WAYLAND_DISPLAY").is_some()
        && std::env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_none()
    {
        std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
    }

    tauri::Builder::default()
        .manage(AppState {
            token: Mutex::new(None),
            rejected: Mutex::new(None),
            refresh_gate: Mutex::new(()),
            login_cancel: Mutex::new(None),
            agent: ureq::AgentBuilder::new()
                .user_agent(concat!("repo-crew/", env!("CARGO_PKG_VERSION")))
                .timeout_connect(CONNECT_TIMEOUT)
                .timeout_read(READ_TIMEOUT)
                .build(),
        })
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            Ok(())
        })
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            clear_token,
            has_token,
            github_graphql,
            oauth::oauth_config,
            oauth::start_github_login,
            oauth::cancel_github_login
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bare(access: &str) -> StoredToken {
        StoredToken { access: access.into(), refresh: None, expires_at: None }
    }

    #[test]
    fn lock_survives_a_poisoned_mutex() {
        let m: Mutex<Option<StoredToken>> = Mutex::new(Some(bare("gho_before")));

        // Poison the mutex by panicking while the guard is held.
        let poisoned = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _guard = m.lock().unwrap();
            panic!("boom");
        }));
        assert!(poisoned.is_err());
        assert!(m.is_poisoned());

        // The token path must still be usable rather than panicking.
        assert_eq!(lock(&m).clone(), Some(bare("gho_before")));
    }

    #[test]
    fn keyring_identifier_is_pinned() {
        // Guards the doc comment's promise: changing these orphans every
        // stored credential, so a rename must be a deliberate, visible edit
        // that also updates this test and the bundle identifier.
        assert_eq!(KEYRING_SERVICE, "dev.quinnjr.repo-crew");
        assert_eq!(KEYRING_USER, "github-token");
    }

    #[test]
    fn parse_stored_round_trips_the_json_shape() {
        let token = StoredToken {
            access: "ghu_a".into(),
            refresh: Some("ghr_b".into()),
            expires_at: Some(1_755_000_000),
        };
        let raw = serde_json::to_string(&token).unwrap();
        assert_eq!(parse_stored(&raw), Some(token));
    }

    #[test]
    fn parse_stored_accepts_a_pre_oauth_bare_token() {
        // Migration: existing installs stored the PAT as a plain string.
        assert_eq!(parse_stored("  ghp_legacy  "), Some(bare("ghp_legacy")));
    }

    #[test]
    fn parse_stored_rejects_garbage() {
        assert_eq!(parse_stored(""), None);
        assert_eq!(parse_stored("   "), None);
        assert_eq!(parse_stored("two words"), None);
        // Valid JSON, malformed access token inside.
        assert_eq!(parse_stored(r#"{"access":"bad token"}"#), None);
    }

    #[test]
    fn pick_stored_prefers_the_cache_and_skips_rejected() {
        assert_eq!(
            pick_stored(Some(bare("gho_cached")), Some("gho_stored".into()), None),
            Some(bare("gho_cached"))
        );
        // The 401 loop this breaks: cache cleared, keychain still holds the
        // dead token, and without the filter it would be re-sent forever.
        assert_eq!(pick_stored(None, Some("gho_dead".into()), Some("gho_dead")), None);
        assert_eq!(
            pick_stored(None, Some("gho_new".into()), Some("gho_dead")),
            Some(bare("gho_new"))
        );
    }

    #[test]
    fn needs_refresh_fires_a_minute_early_and_never_for_long_lived_tokens() {
        assert!(!needs_refresh(None, u64::MAX));
        assert!(!needs_refresh(Some(1_000), 900));
        assert!(needs_refresh(Some(1_000), 940)); // within the 60 s skew
        assert!(needs_refresh(Some(1_000), 1_001)); // already dead
    }

    #[test]
    fn valid_token_bytes_rejects_header_hazards() {
        assert!(valid_token_bytes("ghp_abc123"));
        assert!(!valid_token_bytes(""));
        assert!(!valid_token_bytes("gho_a b"));
        assert!(!valid_token_bytes("gho_a\r\nInjected: yes"));
        assert!(!valid_token_bytes("gho_é"));
    }

    #[test]
    fn remove_legacy_file_tolerates_a_missing_file() {
        let path = std::env::temp_dir().join("repo-crew-test-nonexistent-token.txt");
        let _ = fs::remove_file(&path);
        assert_eq!(remove_legacy_file(&path), Ok(()));
    }

    #[test]
    fn remove_legacy_file_shreds_then_unlinks() {
        let path = std::env::temp_dir().join(format!("repo-crew-test-token-{}.txt", std::process::id()));
        fs::write(&path, "gho_secret").unwrap();
        assert_eq!(remove_legacy_file(&path), Ok(()));
        assert!(!path.exists());
    }
}
