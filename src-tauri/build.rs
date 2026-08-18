use std::path::Path;

/// The only keys forwarded into the compile. One list, so a value can never be
/// read from the file without also being tracked as an environment override.
const KEYS: [&str; 3] = [
    "REPO_CREW_GH_CLIENT_ID",
    "REPO_CREW_GH_CLIENT_SECRET",
    "REPO_CREW_GH_APP_SLUG",
];

/// Forward `REPO_CREW_*` values from the repo-root `.env` into the compile so
/// `option_env!` sees them. Real environment variables win over the file, so
/// CI and makepkg can override without touching it. The file is gitignored;
/// this is how a dev build gets OAuth credentials without exporting them in
/// every shell.
///
/// Every way a value can fail to arrive warns, because the symptom otherwise is
/// a binary that merely reports itself unconfigured with nothing in the log
/// connecting that to the file.
fn load_dotenv() {
    let path = Path::new("../.env");
    println!("cargo:rerun-if-changed=../.env");
    for key in KEYS {
        println!("cargo:rerun-if-env-changed={key}");
    }
    let Ok(contents) = std::fs::read_to_string(path) else {
        return;
    };
    for line in contents.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        // `export KEY=value` is the common shape of a source-able .env, and
        // dropping it silently produced a binary that merely reported itself
        // unconfigured — with nothing in the build log pointing at the file.
        let key = key.trim();
        let key = key.strip_prefix("export ").unwrap_or(key).trim();
        // Both quote styles: a single-quoted secret used to be compiled in with
        // the quotes attached, failing at the token endpoint with an opaque
        // error and no build warning.
        let value = value.trim();
        let value = value
            .strip_prefix('\'')
            .and_then(|v| v.strip_suffix('\''))
            .or_else(|| value.strip_prefix('"').and_then(|v| v.strip_suffix('"')))
            .unwrap_or(value);

        if !key.starts_with("REPO_CREW_") {
            continue;
        }
        if !KEYS.contains(&key) {
            println!("cargo:warning=ignoring unrecognised .env key {key}");
            continue;
        }
        // A control character would let a value inject further `cargo:`
        // directives. `lines()` already rules out `\n`, so `\r` (a CRLF file)
        // and the rest of the C0 range are what actually need rejecting.
        if value.chars().any(char::is_control) {
            println!("cargo:warning=ignoring .env key {key}: value contains a control character");
            continue;
        }
        if value.is_empty() {
            println!("cargo:warning=ignoring .env key {key}: value is empty");
            continue;
        }
        if std::env::var_os(key).is_none() {
            println!("cargo:rustc-env={key}={value}");
        }
    }
}

fn main() {
    load_dotenv();
    tauri_build::build()
}
