//! `make.exe` for the Windows Android release build.
//!
//! Recipe and evidence: docs/ANDROID_TOOLCHAIN.md, "Session 5 (2026-11-18)".
//!
//! The Tauri CLI spawns `make` through `std::process::Command`, which on Windows
//! only resolves `.exe` — a `make.cmd` shim answers "program not found" — and a
//! shell-script `make` dies with OS error 216. So the shim is a real executable
//! whose whole job is to run Git-Bash's `sh.exe` on `make-wrap.sh`, forwarding
//! make's arguments and its exit code. The wrapper rewrites OpenSSL's overlong
//! archive recipes into response files and then execs gmake.
//!
//! `setup.mjs` builds this with `--edition 2021`, baking the two paths in as
//! defaults. Runtime environment variables win over them, so the shim directory
//! can be moved without a rebuild.
use std::env;
use std::process::{Command, exit};

/// Runtime environment first, then the value `setup.mjs` baked in at build time.
fn setting(key: &str, baked: Option<&'static str>) -> Option<String> {
    env::var(key)
        .ok()
        .filter(|value| !value.is_empty())
        .or_else(|| baked.map(str::to_string))
}

fn main() {
    let shell = setting("PM_SHIM_SHELL", option_env!("PM_SHIM_SHELL"));
    let wrapper = setting("PM_SHIM_WRAPPER", option_env!("PM_SHIM_WRAPPER"));
    let (Some(shell), Some(wrapper)) = (shell, wrapper) else {
        eprintln!(
            "make shim: not configured — set PM_SHIM_SHELL and PM_SHIM_WRAPPER, or rebuild it\n\
             with `node scripts/android-make-shim/setup.mjs`."
        );
        exit(127);
    };

    // stdio is inherited, so the recipe output reaches the build log and gmake
    // still sees the terminal. The status code is what the CLI reads to decide
    // whether the OpenSSL step failed.
    match Command::new(&shell)
        .arg(&wrapper)
        .args(env::args_os().skip(1))
        .status()
    {
        Ok(status) => exit(status.code().unwrap_or(127)),
        Err(error) => {
            eprintln!("make shim: could not run {shell} on {wrapper}: {error}");
            exit(127);
        }
    }
}
