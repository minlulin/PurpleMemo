#!/usr/bin/env node
/**
 * Builds the Windows `make` shim the Android release build needs.
 *
 * Recipe, evidence and the rest of the toolchain: docs/ANDROID_TOOLCHAIN.md,
 * "Session 5 (2026-11-18)". The two failures this exists for:
 *
 *  - `npx tauri android build` spawns `make` through `std::process::Command`,
 *    which on Windows resolves only `.exe` — a `make.cmd` answers "program not
 *    found" — and a shell script named `make` dies with OS error 216. So the
 *    shim is a real executable: `make-launcher.rs` runs Git-Bash's `sh.exe` on
 *    `make-wrap.sh`, forwarding make's arguments and exit code.
 *  - `make-wrap.sh` then rewrites OpenSSL's ~18 kB `ar` command lines into
 *    `@response-file` form, because the recipe shell truncates them
 *    (`llvm-ar.exe: error: cry: No such file or directory`) before gmake runs.
 *
 * The shim lives outside the repo, in `%TEMP%\android-shim` by default, because
 * a `.exe` is a build artefact and `%TEMP%` is what the toolchain doc already
 * points PATH at. Nothing here is needed to *read* or *test* the repo — only to
 * cross-compile SQLCipher for Android on Windows.
 *
 * Usage: node scripts/android-make-shim/setup.mjs [--out <directory>]
 */
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const LAUNCHER = join(HERE, "make-launcher.rs");
const WRAPPER = join(HERE, "make-wrap.sh");
const DEFAULT_OUT = join(tmpdir(), "android-shim");
const DEFAULT_GMAKE = "C:/Strawberry/c/bin/gmake.exe";

function fail(reason, remedy) {
  console.error(
    `setup-android-make-shim: FAILED — ${reason}${remedy ? `\n${remedy}` : ""}`,
  );
  process.exit(1);
}

/** Windows paths with forward slashes: CreateProcess and sh both accept them. */
function windowsPath(path) {
  return path.split(sep).join("/");
}

/** The MSYS form Git Bash understands, for the PATH line printed at the end. */
function msysPath(path) {
  const parts = windowsPath(path).split("/");
  const drive = parts[0];
  if (!/^[A-Za-z]:$/.test(drive)) return windowsPath(path);
  return `/${drive[0].toLowerCase()}/${parts.slice(1).join("/")}`;
}

function where(name) {
  try {
    const found = execFileSync("where.exe", [name], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return (
      found
        .split("\n")
        .map((line) => line.trim())
        .find(Boolean) ?? null
    );
  } catch {
    return null;
  }
}

/** `git --exec-path` is `<Git>/mingw64/libexec/git-core`; sh sits beside usr. */
function gitBashShell() {
  try {
    const execPath = execFileSync("git", ["--exec-path"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return join(resolve(execPath, "../../.."), "usr", "bin", "sh.exe");
  } catch {
    return null;
  }
}

function findShell() {
  const candidates = [
    process.env.PM_SHIM_SHELL,
    where("sh.exe"),
    gitBashShell(),
    join(
      process.env.ProgramFiles ?? "C:/Program Files",
      "Git",
      "usr",
      "bin",
      "sh.exe",
    ),
    join(
      process.env.LOCALAPPDATA ?? "",
      "Programs",
      "Git",
      "usr",
      "bin",
      "sh.exe",
    ),
  ];
  const found = candidates.find((path) => path && existsSync(path));
  if (!found) {
    fail(
      "no sh.exe found to run the wrapper with.",
      "  Set PM_SHIM_SHELL to Git-Bash's sh.exe and run this again.",
    );
  }
  return found;
}

function findGmake() {
  const candidates = [process.env.PM_GMAKE, where("gmake"), DEFAULT_GMAKE];
  const found = candidates.find((path) => path && existsSync(path));
  if (!found) {
    fail(
      "no gmake found; OpenSSL's build needs GNU make, which Git Bash does not ship.",
      `  Strawberry Perl provides it at ${DEFAULT_GMAKE}; set PM_GMAKE to another copy.`,
    );
  }
  return found;
}

if (process.platform !== "win32") {
  fail(
    "the make shim is a Windows-only workaround.",
    "  On another host this build needs none of it: docs/ANDROID_TOOLCHAIN.md.",
  );
}

const argument = process.argv.indexOf("--out");
const out = resolve(argument > 0 ? process.argv[argument + 1] : DEFAULT_OUT);
const shell = windowsPath(findShell());
const gmake = windowsPath(findGmake());

mkdirSync(out, { recursive: true });
const wrapper = join(out, "make-wrap.sh");
const exe = join(out, "make.exe");
copyFileSync(WRAPPER, wrapper);

try {
  execFileSync("rustc", ["--edition", "2021", "-O", "-o", exe, LAUNCHER], {
    env: {
      ...process.env,
      PM_SHIM_SHELL: shell,
      PM_SHIM_WRAPPER: windowsPath(wrapper),
    },
    stdio: ["ignore", "inherit", "inherit"],
  });
} catch (error) {
  fail(
    `rustc could not build the launcher (${error.message}).`,
    "  Install a Rust toolchain, or read the compiler error above.",
  );
}

// A launcher that cannot start sh, or a wrapper that cannot find gmake, would
// otherwise fail much later inside a ten-minute Android build.
let version;
try {
  version = execFileSync(exe, ["--version"], {
    encoding: "utf8",
    env: { ...process.env, PM_GMAKE: gmake },
    stdio: ["ignore", "pipe", "inherit"],
  });
} catch (error) {
  fail(`the built shim does not run (${error.message}).`);
}
if (!/GNU Make/.test(version)) {
  fail(
    `the built shim ran but gmake did not answer (${version.trim().split("\n")[0] || "no output"}).`,
  );
}

console.log(
  [
    `setup-android-make-shim: OK — ${windowsPath(exe)}`,
    `  sh.exe   ${shell}`,
    `  gmake    ${gmake}`,
    "",
    "  Put the shim first on PATH before an android build:",
    `    export PATH="${msysPath(out)}:$PATH"`,
    gmake === DEFAULT_GMAKE
      ? ""
      : `  The wrapper looks for gmake at ${DEFAULT_GMAKE}; export PM_GMAKE="${msysPath(gmake)}".`,
    "",
    "  The rest of the recipe (toolchain variables, perl modules, MAKEFLAGS):",
    '  docs/ANDROID_TOOLCHAIN.md, "Session 5 (2026-11-18)".',
  ]
    .filter((line) => line !== "")
    .join("\n"),
);
