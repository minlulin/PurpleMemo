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
 * a checkout with no APK in it. On the release machine, where the toolchain is
 * set up for the build anyway, the check runs and a break fails the gate there.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { delimiter, join } from "node:path";

const TARGET = "aarch64-linux-android";
const CARGO_TARGET = "aarch64-linux-android";
const TOOLCHAIN = "aarch64-linux-android24-clang";
const DOC = "docs/ANDROID_TOOLCHAIN.md";

const REMEDY =
  `  The setup is "Building the debug APK on Windows" in ${DOC}; the check runs as\n` +
  "  soon as the pieces below are on this machine, so `npm run verify` covers the\n" +
  "  Android target too.";

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

function run(command, args) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error)
    return { status: null, output: String(result.error.message) };
  return {
    status: result.status,
    output: `${result.stdout ?? ""}${result.stderr ?? ""}`,
  };
}

/** An executable on `PATH`, or null. */
function onPath(name) {
  const suffixes =
    process.platform === "win32" ? [".exe", ".cmd", ".bat", ""] : [""];
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    if (!directory) continue;
    for (const suffix of suffixes) {
      if (existsSync(join(directory, `${name}${suffix}`))) return true;
    }
  }
  return false;
}

/** rustup's installed targets, or null when rustup itself is unavailable. */
function installedTargets() {
  const result = run("rustup", ["target", "list", "--installed"]);
  if (result.status !== 0) return null;
  return result.output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

/** The NDK this machine would build with: the pinned env var, else the newest. */
function findNdk() {
  const roots = [];
  if (process.env.ANDROID_NDK_HOME) roots.push(process.env.ANDROID_NDK_HOME);
  for (const root of [process.env.ANDROID_HOME, process.env.ANDROID_SDK_ROOT]) {
    if (!root) continue;
    const parent = join(root, "ndk");
    if (!existsSync(parent)) continue;
    roots.push(
      ...readdirSync(parent)
        .sort()
        .reverse()
        .map((version) => join(parent, version)),
    );
  }
  return roots.find((root) => existsSync(root)) ?? null;
}

/**
 * The cross-compiler must be reachable by name, not by path: OpenSSL's generated
 * Makefile is run by `/usr/bin/sh`, which eats the backslashes of a Windows
 * path (docs/ANDROID_TOOLCHAIN.md, item 3) — the same reason the build puts the
 * NDK's bin on `PATH` instead of passing `CC` a full path.
 */
function hasCrossCompiler() {
  return onPath(TOOLCHAIN);
}

/** OpenSSL's `Configure` is a perl script with three module requirements. */
function perlCanConfigure() {
  const result = run("perl", [
    "-MExtUtils::MakeMaker",
    "-MPod::Usage",
    "-MLocale::Maketext::Simple",
    "-e",
    "1",
  ]);
  return result.status === 0;
}

const reasons = [];
const targets = installedTargets();
if (targets === null) {
  reasons.push(
    "rustup is not available, so the target's std cannot be installed",
  );
} else if (!targets.includes(TARGET)) {
  reasons.push(
    `the ${TARGET} target is not installed (rustup target add ${TARGET})`,
  );
}
const ndk = findNdk();
if (!ndk) {
  reasons.push("no Android NDK (set ANDROID_NDK_HOME)");
}
if (!hasCrossCompiler()) {
  reasons.push(`the NDK's ${TOOLCHAIN} is not on PATH`);
}
if (!onPath("make")) {
  reasons.push(
    "no make on PATH (the shim from npm run setup:android-make-shim)",
  );
}
if (!perlCanConfigure()) {
  reasons.push(
    "perl cannot load ExtUtils::MakeMaker/Pod::Usage/Locale::Maketext::Simple (set PERL5LIB)",
  );
}
if (reasons.length > 0) skip(reasons);

const checked = run("cargo", [
  "check",
  "--target",
  CARGO_TARGET,
  "--manifest-path",
  join("src-tauri", "Cargo.toml"),
]);
if (checked.status === null) {
  fail(`cargo could not be started — ${checked.output}`);
}
if (checked.status !== 0) {
  console.error(checked.output.trimEnd());
  fail(
    `cargo check --target ${CARGO_TARGET} failed: code that compiles only for ` +
      "Android is broken (the desktop build and clippy never compile it).",
  );
}
console.log(
  `check-android: OK — cargo check --target ${CARGO_TARGET} compiles the Android target`,
);
