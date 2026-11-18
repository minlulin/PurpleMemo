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

#[repr(C)]
struct StartupInfo {
    cb: u32,
    lp_reserved: *mut u16,
    lp_desktop: *mut u16,
    lp_title: *mut u16,
    dw_x: u32,
    dw_y: u32,
    dw_x_size: u32,
    dw_y_size: u32,
    dw_x_count_chars: u32,
    dw_y_count_chars: u32,
    dw_fill_attribute: u32,
    dw_flags: u32,
    w_show_window: u16,
    cb_reserved2: u16,
    lp_reserved2: *mut u8,
    h_std_input: *mut u8,
    h_std_output: *mut u8,
    h_std_error: *mut u8,
}

#[repr(C)]
struct ProcessInformation {
    h_process: *mut u8,
    h_thread: *mut u8,
    dw_process_id: u32,
    dw_thread_id: u32,
}

extern "system" {
    fn CreateProcessW(
        app: *const u16,
        cmd: *mut u16,
        pa: *mut u8,
        ta: *mut u8,
        inherit: i32,
        flags: u32,
        envp: *mut u8,
        cwd: *const u16,
        si: *mut StartupInfo,
        pi: *mut ProcessInformation,
    ) -> i32;
    fn WaitForSingleObject(h: *mut u8, ms: u32) -> u32;
    fn GetExitCodeProcess(h: *mut u8, code: *mut u32) -> i32;
    fn CloseHandle(h: *mut u8) -> i32;
}

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
        std::process::exit(127);
    };

    let quote = '"';
    let mut command_line = String::new();
    command_line.push(quote);
    command_line.push_str(&shell);
    command_line.push(quote);
    command_line.push(' ');
    command_line.push(quote);
    command_line.push_str(&wrapper);
    command_line.push(quote);
    for argument in env::args_os().skip(1) {
        command_line.push(' ');
        command_line.push(quote);
        command_line.push_str(&argument.to_string_lossy());
        command_line.push(quote);
    }

    let mut wide: Vec<u16> = command_line.encode_utf16().collect();
    wide.push(0);
    let mut startup: StartupInfo = unsafe { std::mem::zeroed() };
    startup.cb = std::mem::size_of::<StartupInfo>() as u32;
    let mut process: ProcessInformation = unsafe { std::mem::zeroed() };
    let started = unsafe {
        CreateProcessW(
            std::ptr::null(),
            wide.as_mut_ptr(),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            1,
            0,
            std::ptr::null_mut(),
            std::ptr::null(),
            &mut startup,
            &mut process,
        )
    };
    if started == 0 {
        eprintln!("make shim: could not run {shell} on {wrapper}");
        std::process::exit(127);
    }
    unsafe {
        WaitForSingleObject(process.h_process, 0xFFFF_FFFF);
        let mut code: u32 = 0;
        GetExitCodeProcess(process.h_process, &mut code);
        CloseHandle(process.h_process);
        CloseHandle(process.h_thread);
        std::process::exit(code as i32);
    }
}
