#!/usr/bin/env node
/**
 * Android Rust-target compile check (F9).
 *
 * `cfg(target_os = "android")` code compiles only for the Android target, so the
 * desktop build, clippy and the Rust tests never see it. Before this step the
 * first thing that touched it was an APK build on release day, which is the one
 * place a compile error costs a rebuilt artefact and a re-run of the APK gate.
 *
 * A desktop checkout cannot always run the check: it needs the target's std, the
 * NDK, a `make`, and a perl carrying the modules OpenSSL's `Configure` requires
 * (the recipe is docs/ANDROID_TOOLCHAIN.md, "Building the debug APK on Windows").
 * So this step runs when the machine can cross-compile, and skips naming the
 * missing piece when it cannot — the same rule check-android-apk.mjs applies to
 * a checkout with no APK in it.
 *
 * Two of those pieces are installed by `npm run setup:android-toolchain`: the
 * `make` shim and the perl module tree copied from Strawberry. They live in a
 * repo-local `.android-toolchain/` directory rather than `%TEMP%`, because
 * Windows clears `%TEMP%` and the step then skipped instead of compiling — the
 * silent loss of Android coverage the 0.4.0 pre-release audit found (R2). The
 * old `%TEMP%` locations stay discovered so a machine already set up either way
 * still compiles; nothing here is required as an export, so a plain
 * `npm run verify` covers the Android target.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const TARGET = "aarch64-linux-android";
const TOOLCHAIN = "aarch64-linux-android24-clang";
const DOC = "docs/ANDROID_TOOLCHAIN.md";
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Where the two installed pieces are looked for, newest first: the repo-local
 * directory `npm run setup:android-toolchain` writes, then the `%TEMP%` paths
 * the toolchain doc used before that (kept so an existing setup keeps working).
 */
const SHIM_DIRS = [
  join(REPO, ".android-toolchain", "shim"),
  join(tmpdir(), "android-shim"),
];
const PERL_LIB_DIRS = [
  join(REPO, ".android-toolchain", "perl", "lib"),
  join(tmpdir(), "android-perl", "lib"),
];

const REMEDY =
  "  Run `npm run setup:android-toolchain` once — it installs the make shim and\n" +
  "  the perl module tree under .android-toolchain/, where this step finds them,\n" +
  `  so \`npm run verify\` covers the Android target with no shell setup.\n` +
  `  The recipe is "Building the debug APK on Windows" in ${DOC}.`;

function fail(reason, remedy) {
  console.error(
    `check-android: FAILED — ${reason}${remedy ? `\n${remedy}` : ""}`,
  );
  process.exit(1);
}

/** Skipped is a verdict, not an error: a desktop checkout has nothing to compile. */
function skip(reasons) {
  const missing = reasons.map((reason) => `  - ${reason}`).join("\n");
  console.log(
    `check-android: skipped — this machine cannot compile the ${TARGET} target:\n${missing}\n${REMEDY}`,
  );
  process.exit(0);
}

function run(command, args, env = process.env) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    env,
  });
  if (result.error) {
    return { status: null, output: String(result.error.message) };
  }
  return {
    status: result.status,
    output: `${result.stdout ?? ""}${result.stderr ?? ""}`,
  };
}

/** An executable on `env`'s PATH, or false. */
function onPath(name, env) {
  const suffixes =
    process.platform === "win32" ? [".exe", ".cmd", ".bat", ""] : [""];
  for (const directory of (env.PATH ?? "").split(delimiter)) {
    if (!directory) continue;
    for (const suffix of suffixes) {
      if (existsSync(join(directory, `${name}${suffix}`))) return true;
    }
  }
  return false;
}

/** Whether rustup has the target's std installed — false without rustup too. */
function hasTargetStd() {
  const result = run("rustup", ["target", "list", "--installed"]);
  if (result.status !== 0) return false;
  return result.output.split(/\r?\n/).some((line) => line.trim() === TARGET);
}

/**
 * The NDK's host bin directory — where `aarch64-linux-android24-clang` lives —
 * from the pinned env var, else the newest NDK under the SDK.
 *
 * The compiler must be reachable by name, not by path: OpenSSL's generated
 * Makefile is run by `/usr/bin/sh`, which eats the backslashes of a Windows path
 * (docs/ANDROID_TOOLCHAIN.md, item 3) — the same reason the build puts this
 * directory on `PATH` instead of passing `CC` a full path.
 */
function ndkBinDirectory() {
  const ndks = [];
  if (process.env.ANDROID_NDK_HOME) ndks.push(process.env.ANDROID_NDK_HOME);
  for (const root of [process.env.ANDROID_HOME, process.env.ANDROID_SDK_ROOT]) {
    if (!root) continue;
    const parent = join(root, "ndk");
    if (!existsSync(parent)) continue;
    ndks.push(
      ...readdirSync(parent)
        .sort()
        .reverse()
        .map((version) => join(parent, version)),
    );
  }
  for (const ndk of ndks) {
    const prebuilt = join(ndk, "toolchains", "llvm", "prebuilt");
    if (!existsSync(prebuilt)) continue;
    for (const host of readdirSync(prebuilt)) {
      const bin = join(prebuilt, host, "bin");
      if (existsSync(bin)) return bin;
    }
  }
  return null;
}

/** `C:\Users\x\AppData\Local\Temp` -> `/c/Users/x/AppData/Local/Temp` for perl. */
function posixPath(path) {
  return path
    .replace(/^([A-Za-z]):/, (_, drive) => `/${drive.toLowerCase()}`)
    .replace(/\\/g, "/");
}

/** Prepend a directory to `env`'s PATH once, case-insensitively on Windows. */
function addToPath(env, directory) {
  const entries = (env.PATH ?? "").split(delimiter).filter(Boolean);
  const normalise = (value) =>
    process.platform === "win32" ? value.toLowerCase() : value;
  if (entries.some((entry) => normalise(entry) === normalise(directory))) {
    return;
  }
  env.PATH = [directory, ...entries].join(delimiter);
}

/** OpenSSL's `Configure` is a perl script with three module requirements. */
function perlCanConfigure(env) {
  return (
    run(
      "perl",
      [
        "-MExtUtils::MakeMaker",
        "-MPod::Usage",
        "-MLocale::Maketext::Simple",
        "-e",
        "1",
      ],
      env,
    ).status === 0
  );
}

/**
 * The environment this step runs in: the caller's, plus the NDK's bin and the
 * `make` shim on PATH, plus the perl module tree when the shell has none. Each
 * addition only happens where the toolchain doc says the piece lives, and only
 * when the caller has not set it already.
 */
function buildEnvironment(bin) {
  const env = { ...process.env };
  if (bin) addToPath(env, bin);
  const shim = SHIM_DIRS.find((directory) => existsSync(directory));
  if (shim) addToPath(env, shim);
  if (!perlCanConfigure(env)) {
    const perlLib = PERL_LIB_DIRS.find(
      (directory) =>
        existsSync(directory) &&
        perlCanConfigure({ ...env, PERL5LIB: posixPath(directory) }),
    );
    if (perlLib) {
      env.PERL5LIB = posixPath(perlLib);
      // MSYS turns a POSIX value into a Windows path when it launches gmake,
      // and perl then splits "C:\\Users\u2026" on the colon into "C" and
      // "\\Users\u2026" — the failure docs/ANDROID_TOOLCHAIN.md §2 records.
      const excluded = (env.MSYS2_ENV_CONV_EXCL ?? "")
        .split(";")
        .filter(Boolean);
      if (!excluded.includes("PERL5LIB")) {
        env.MSYS2_ENV_CONV_EXCL = [...excluded, "PERL5LIB"].join(";");
      }
    }
  }
  // The build's own recipe, so openssl-src's Configure sees the NDK compiler.
  for (const [variable, value] of [
    [`CC_${TARGET}`, TOOLCHAIN],
    [`AR_${TARGET}`, "llvm-ar"],
    [`RANLIB_${TARGET}`, "llvm-ranlib"],
  ]) {
    env[variable] ??= value;
  }
  return env;
}

const bin = ndkBinDirectory();
const env = buildEnvironment(bin);

const reasons = [];
if (!hasTargetStd()) {
  reasons.push(
    `the ${TARGET} target's std is not installed (rustup target add ${TARGET})`,
  );
}
if (!bin) {
  reasons.push("no Android NDK toolchain (set ANDROID_NDK_HOME)");
}
if (!onPath("make", env)) {
  reasons.push(
    "no make on PATH and no installed shim (npm run setup:android-toolchain)",
  );
}
if (!perlCanConfigure(env)) {
  reasons.push(
    "perl cannot load ExtUtils::MakeMaker/Pod::Usage/Locale::Maketext::Simple " +
      "(no installed module tree — npm run setup:android-toolchain)",
  );
}
if (reasons.length > 0) skip(reasons);

const checked = run(
  "cargo",
  [
    "check",
    "--target",
    TARGET,
    "--manifest-path",
    join("src-tauri", "Cargo.toml"),
  ],
  env,
);
if (checked.status === null) {
  fail(`cargo could not be started — ${checked.output}`);
}
if (checked.status !== 0) {
  console.error(checked.output.trimEnd());
  fail(
    `cargo check --target ${TARGET} failed: code that compiles only for Android ` +
      "is broken (the desktop build and clippy never compile it).",
  );
}
console.log(
  `check-android: OK — cargo check --target ${TARGET} compiles the Android target`,
);
