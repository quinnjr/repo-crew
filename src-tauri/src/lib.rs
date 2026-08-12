use keyring::Entry;
use serde_json::{json, Value};
use std::fs;
use std::io;
use std::path::Path;
use std::sync::{Mutex, MutexGuard};
use std::time::Duration;
use tauri::Manager;

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

struct AppState {
    /// In-process cache so a fleet sweep does not hit the keychain once per
    /// query — some backends prompt or rate-limit on repeated reads. Cleared
    /// when GitHub rejects the token, so a revoked credential does not keep
    /// being re-sent for the rest of the process lifetime.
    token: Mutex<Option<String>>,
    /// The token GitHub last answered 401 to. Without this, the 401 clears
    /// the cache and the very next query reads the same dead token straight
    /// back out of the keychain — an infinite 401 loop that never reaches the
    /// sign-in screen.
    rejected: Mutex<Option<String>>,
    /// One agent for the whole process: connection pooling and keep-alive,
    /// instead of a fresh TLS handshake per query.
    agent: ureq::Agent,
}

/// Survive a poisoned mutex rather than panicking. The token path is exactly
/// where a previous panic should degrade instead of cascading.
fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

fn entry() -> Result<Entry, String> {
    Entry::new(KEYRING_SERVICE, KEYRING_USER).map_err(|e| format!("keychain unavailable: {e}"))
}

/// A token goes into an `Authorization` header, where a control byte turns
/// into a malformed request (or worse, header injection). GitHub tokens are
/// ASCII; anything else was a paste accident.
fn valid_token_bytes(token: &str) -> bool {
    !token.is_empty() && token.bytes().all(|b| b.is_ascii_graphic())
}

/// The precedence seam between the storage layers, pure so it can be tested
/// without a keychain: cache wins, blank values fall through, and a token
/// GitHub already rejected never comes back.
fn pick_token(cached: Option<String>, stored: Option<String>, rejected: Option<&str>) -> Option<String> {
    cached
        .into_iter()
        .chain(stored)
        .map(|t| t.trim().to_string())
        .find(|t| valid_token_bytes(t) && Some(t.as_str()) != rejected)
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
/// paste a token into a keychain that cannot store it.
fn read_keychain() -> Result<Option<String>, String> {
    match entry()?.get_password() {
        Ok(t) => Ok(Some(t)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(format!("could not read the keychain: {e}")),
    }
}

/// Resolve the token from cache, then the keychain, then the legacy file.
///
/// `Ok(None)` means signed out; `Err` means the keychain itself is unusable.
/// Note this is not side-effect free: on first call it may perform the legacy
/// migration (writing the keychain and deleting `token.txt`).
fn resolve_token(app: &tauri::AppHandle, state: &AppState) -> Result<Option<String>, String> {
    if let Some(cached) = lock(&state.token).clone() {
        return Ok(Some(cached));
    }
    let stored = read_keychain()?;
    let rejected = lock(&state.rejected).clone();
    let token = pick_token(None, stored, rejected.as_deref())
        .or_else(|| pick_token(None, migrate_legacy_token(app), rejected.as_deref()));
    if let Some(t) = &token {
        *lock(&state.token) = Some(t.clone());
    }
    Ok(token)
}

#[tauri::command]
fn set_token(state: tauri::State<'_, AppState>, token: String) -> Result<(), String> {
    let trimmed = token.trim().to_string();
    if trimmed.is_empty() {
        return Err("token is empty".into());
    }
    if !valid_token_bytes(&trimmed) {
        return Err("token contains characters that cannot go in an HTTP header".into());
    }
    entry()?
        .set_password(&trimmed)
        .map_err(|e| format!("could not save to the keychain: {e}"))?;
    *lock(&state.token) = Some(trimmed);
    // A fresh credential gets a fresh chance, even if it equals the old one —
    // the user may have un-revoked it, and one wasted 401 is cheap.
    *lock(&state.rejected) = None;
    Ok(())
}

/// Remove the credential everywhere.
///
/// The keychain entry goes first: clearing the cache before a delete that then
/// fails would leave the app "logged out" while the credential survives on
/// disk, silently signing the user back in on the next launch. The legacy
/// file is shredded, and an unresolvable config dir is reported rather than
/// swallowed — that is the one case where a plaintext copy could survive a
/// "sign out" without the user hearing about it.
#[tauri::command]
fn clear_token(app: tauri::AppHandle, state: tauri::State<'_, AppState>) -> Result<(), String> {
    let keychain = match entry() {
        Ok(e) => match e.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(format!("could not clear the keychain entry: {e}")),
        },
        Err(e) => Err(e),
    };

    let legacy = match app.path().app_config_dir() {
        Ok(dir) => remove_legacy_file(&dir.join(LEGACY_TOKEN_FILE)),
        Err(e) => Err(format!("could not locate the config dir to clear the legacy token file: {e}")),
    };

    *lock(&state.token) = None;
    *lock(&state.rejected) = None;
    keychain.and(legacy)
}

/// Reports whether a token is stored — never the token itself, so the secret
/// stays out of the webview. `Err` means the keychain cannot be asked (locked
/// or missing Secret Service), which the frontend surfaces instead of showing
/// sign-in. See `resolve_token` for its migration side effect.
#[tauri::command]
fn has_token(app: tauri::AppHandle, state: tauri::State<'_, AppState>) -> Result<bool, String> {
    resolve_token(&app, &state).map(|t| t.is_some())
}

/// Ask GitHub who a token belongs to WITHOUT storing it.
///
/// Settings uses this to vet a replacement token before overwriting the
/// working credential — storing first and rolling back on failure would
/// destroy the good token to test the bad one.
#[tauri::command]
async fn validate_token(state: tauri::State<'_, AppState>, token: String) -> Result<String, String> {
    let trimmed = token.trim().to_string();
    if trimmed.is_empty() {
        return Err("token is empty".into());
    }
    if !valid_token_bytes(&trimmed) {
        return Err("token contains characters that cannot go in an HTTP header".into());
    }

    let agent = state.agent.clone();
    let response = tauri::async_runtime::spawn_blocking(move || {
        agent
            .post("https://api.github.com/graphql")
            .set("Authorization", &format!("Bearer {trimmed}"))
            .set("Accept", "application/vnd.github+json")
            .set("X-GitHub-Api-Version", "2022-11-28")
            .send_json(json!({ "query": "query { viewer { login } }" }))
            .map_err(Box::new)
    })
    .await
    .map_err(|e| format!("request task failed: {e}"))?;

    match response.map_err(|e| *e) {
        Ok(resp) => resp
            .into_json::<Value>()
            .ok()
            .and_then(|v| v["data"]["viewer"]["login"].as_str().map(str::to_string))
            .ok_or_else(|| "GitHub did not return an account for that token".into()),
        Err(ureq::Error::Status(401, _)) => Err("GitHub rejected the token".into()),
        Err(ureq::Error::Status(code, _)) => Err(format!("HTTP {code}")),
        Err(e) => Err(e.to_string()),
    }
}

/// Execute a GitHub GraphQL request against api.github.com/graphql.
///
/// Returns `{ ok, status, data?, error?, detail? }`. GraphQL-level errors are
/// reported inside `data.errors`, as GitHub does; `error` is reserved for
/// transport and auth failures. A 401 is normalised to `not_authenticated` so
/// the frontend can route to the sign-in screen instead of showing a raw body.
///
/// `async` matters: a synchronous command runs on the UI thread, so a fleet
/// sweep would freeze the window for the whole run.
#[tauri::command]
async fn github_graphql(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    query: String,
    variables: Option<Value>,
) -> Result<Value, String> {
    let token = match resolve_token(&app, &state) {
        Ok(Some(t)) => t,
        Ok(None) => return Ok(json!({ "ok": false, "error": "not_authenticated", "status": 0 })),
        Err(e) => {
            return Ok(json!({ "ok": false, "error": "keychain_unavailable", "detail": e, "status": 0 }))
        }
    };

    let agent = state.agent.clone();
    let payload = json!({ "query": query, "variables": variables.unwrap_or(json!({})) });
    let sent = token.clone();

    // Boxed: `ureq::Error` is ~272 bytes and would otherwise bloat every
    // Result this closure returns.
    let response = tauri::async_runtime::spawn_blocking(move || {
        agent
            .post("https://api.github.com/graphql")
            .set("Authorization", &format!("Bearer {token}"))
            .set("Accept", "application/vnd.github+json")
            .set("X-GitHub-Api-Version", "2022-11-28")
            .send_json(payload)
            .map_err(Box::new)
    })
    .await
    .map_err(|e| format!("request task failed: {e}"))?;

    Ok(match response.map_err(|e| *e) {
        Ok(resp) => {
            let status = resp.status();
            match resp.into_json::<Value>() {
                Ok(body) => json!({ "ok": true, "status": status, "data": body }),
                Err(e) => json!({ "ok": false, "error": e.to_string(), "status": status }),
            }
        }
        Err(ureq::Error::Status(401, resp)) => {
            // The stored token no longer works; stop re-sending it AND stop
            // re-reading it out of the keychain on the next query.
            *lock(&state.token) = None;
            *lock(&state.rejected) = Some(sent);
            let detail = resp.into_string().unwrap_or_default();
            json!({ "ok": false, "error": "not_authenticated", "detail": detail, "status": 401 })
        }
        Err(ureq::Error::Status(code, resp)) => {
            let body = resp.into_string().unwrap_or_default();
            json!({ "ok": false, "error": format!("HTTP {code}"), "detail": body, "status": code })
        }
        Err(e) => json!({ "ok": false, "error": e.to_string(), "status": 0 }),
    })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(AppState {
            token: Mutex::new(None),
            rejected: Mutex::new(None),
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
            set_token,
            clear_token,
            has_token,
            validate_token,
            github_graphql
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;

    fn state() -> AppState {
        AppState {
            token: Mutex::new(None),
            rejected: Mutex::new(None),
            agent: ureq::AgentBuilder::new().build(),
        }
    }

    #[test]
    fn lock_survives_a_poisoned_mutex() {
        let s = state();
        *lock(&s.token) = Some("gho_before".into());

        // Poison the mutex by panicking while the guard is held.
        let poisoned = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _guard = s.token.lock().unwrap();
            panic!("boom");
        }));
        assert!(poisoned.is_err());
        assert!(s.token.is_poisoned());

        // The token path must still be usable rather than panicking.
        assert_eq!(lock(&s.token).clone(), Some("gho_before".to_string()));
    }

    #[test]
    fn cache_round_trips_through_lock() {
        let s = state();
        assert_eq!(lock(&s.token).clone(), None);
        *lock(&s.token) = Some("gho_x".into());
        assert_eq!(lock(&s.token).clone(), Some("gho_x".to_string()));
        *lock(&s.token) = None;
        assert_eq!(lock(&s.token).clone(), None);
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
    fn pick_token_prefers_the_cache() {
        assert_eq!(
            pick_token(Some("gho_cached".into()), Some("gho_stored".into()), None),
            Some("gho_cached".to_string())
        );
    }

    #[test]
    fn pick_token_never_returns_a_rejected_token() {
        // The 401 loop this breaks: cache cleared, keychain still holds the
        // dead token, and without the filter it would be re-sent forever.
        assert_eq!(pick_token(None, Some("gho_dead".into()), Some("gho_dead")), None);
        // A different stored token IS eligible again.
        assert_eq!(
            pick_token(None, Some("gho_new".into()), Some("gho_dead")),
            Some("gho_new".to_string())
        );
    }

    #[test]
    fn pick_token_skips_blank_and_malformed_values() {
        assert_eq!(pick_token(Some("  ".into()), Some("\n".into()), None), None);
        // A control byte would corrupt the Authorization header.
        assert_eq!(pick_token(None, Some("gho_a\u{7f}b".into()), None), None);
        // Whitespace is trimmed, not fatal.
        assert_eq!(pick_token(None, Some("  gho_ok  ".into()), None), Some("gho_ok".to_string()));
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
