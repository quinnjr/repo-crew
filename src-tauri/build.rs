use std::path::Path;

/// Forward `REPO_CREW_*` values from the repo-root `.env` into the compile so
/// `option_env!` sees them. Real environment variables win over the file, so
/// CI and makepkg can override without touching it. The file is gitignored;
/// this is how a dev build gets OAuth credentials without exporting them in
/// every shell.
fn load_dotenv() {
    let path = Path::new("../.env");
    println!("cargo:rerun-if-changed=../.env");
    for key in ["REPO_CREW_GH_CLIENT_ID", "REPO_CREW_GH_CLIENT_SECRET", "REPO_CREW_GH_APP_SLUG"] {
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
        let (key, value) = (key.trim(), value.trim().trim_matches('"'));
        if key.starts_with("REPO_CREW_") && std::env::var_os(key).is_none() && !value.is_empty() {
            println!("cargo:rustc-env={key}={value}");
        }
    }
}

fn main() {
    load_dotenv();
    tauri_build::build()
}
