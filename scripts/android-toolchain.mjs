#!/usr/bin/env node
/**
 * Prepares the Windows pieces the SQLCipher/OpenSSL cross-compile needs — the
 * `make` shim and the perl module tree — in ONE durable, repo-local directory.
 *
 * Why this exists: both pieces used to live in `%TEMP%`
 * (`docs/ANDROID_TOOLCHAIN.md`, "Building the debug APK on Windows"), which
 * Windows clears. When it did, `npm run check:android` started *skipping*
 * instead of compiling, so `cfg(target_os = "android")` code silently went
 * unverified — exactly what the 0.4.0 pre-release audit found (finding R2).
 * A directory under the repo is wiped only by a deliberate `rm`, and the gate
 * discovers it without any shell setup.
 *
 * The perl half is the awkward one and stays a copy, not a pointer: pointing
 * `PERL5LIB` at Strawberry's own tree fails on the first XS module with
 * "loadable library and perl binaries are mismatched", because Strawberry's
 * perl is MSWin32 and Git-Bash's is Cygwin. So the four module directories
 * `Configure` needs are copied and every `*.so`/`*.dll`/`*.xs`/`*.bs` is
 * pruned from the copy — the recipe the toolchain doc records, run by a script
 * rather than by hand.
 *
 * Usage: node scripts/android-toolchain.mjs
 * Output: .android-toolchain/shim/ and .android-toolchain/perl/lib/
 */
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..");
const OUT = join(REPO, ".android-toolchain");
const SHIM = join(OUT, "shim");
const PERL_LIB = join(OUT, "perl", "lib");

/** The module trees OpenSSL's `Configure` and `MakeMaker` actually load. */
const MODULES = ["ExtUtils", "Pod", "Locale", "I18N"];
/** Loadable libraries cannot cross a perl ABI: the copy keeps sources only. */
const BINARY_ARTEFACT = /\.(so|dll|xs|bs)$/i;

function fail(reason, remedy) {
  console.error(
    `android-toolchain: FAILED — ${reason}${remedy ? `\n${remedy}` : ""}`,
  );
  process.exit(1);
}

/** `C:\Users\x` -> `/c/Users/x`: the form Git-Bash's perl resolves. */
function posixPath(path) {
  return path
    .replace(/^([A-Za-z]):/, (_, drive) => `/${drive.toLowerCase()}`)
    .replace(/\\/g, "/");
}

if (process.platform !== "win32") {
  fail(
    "this prepares the Windows-only workaround.",
    "  On another host the cross-compile needs none of it (docs/ANDROID_TOOLCHAIN.md).",
  );
}

// --- 1. The make shim ---------------------------------------------------------

try {
  execFileSync(
    process.execPath,
    [join(HERE, "android-make-shim", "setup.mjs"), "--out", SHIM],
    { stdio: "inherit" },
  );
} catch {
  fail(
    "the make shim could not be built.",
    "  The reason is printed above; docs/ANDROID_TOOLCHAIN.md item 2 has the fallback.",
  );
}

// --- 2. The perl module tree -------------------------------------------------

const strawberry = process.env.PM_STRAWBERRY ?? "C:/Strawberry";
const roots = [
  join(strawberry, "perl", "lib"),
  join(strawberry, "perl", "site", "lib"),
  join(strawberry, "perl", "vendor", "lib"),
].filter((root) => existsSync(root));
if (roots.length === 0) {
  fail(
    `no Strawberry Perl library tree under ${strawberry}.`,
    "  Install Strawberry Perl, or set PM_STRAWBERRY to its install directory.",
  );
}

mkdirSync(PERL_LIB, { recursive: true });
const copied = [];
for (const module of MODULES) {
  for (const root of roots) {
    const source = join(root, module);
    if (!existsSync(source)) continue;
    cpSync(source, join(PERL_LIB, module), {
      recursive: true,
      filter: (path) => !BINARY_ARTEFACT.test(path),
    });
    copied.push(`${module} <- ${root}`);
  }
}
if (copied.length === 0) {
  fail(
    `none of ${MODULES.join(", ")} were found under ${strawberry}.`,
    "  Check PM_STRAWBERRY; the toolchain doc names the exact directories.",
  );
}

// --- 3. Prove the tree loads under Git-Bash's perl ---------------------------

const probe = spawnSync(
  "perl",
  [
    "-MExtUtils::MakeMaker",
    "-MPod::Usage",
    "-MLocale::Maketext::Simple",
    "-e",
    "print 'ok'",
  ],
  {
    encoding: "utf8",
    env: {
      ...process.env,
      PERL5LIB: posixPath(PERL_LIB),
      // MSYS rewrites a POSIX value into a Windows path, and perl then splits
      // it on the drive colon (docs/ANDROID_TOOLCHAIN.md, `PERL5LIB`).
      MSYS2_ENV_CONV_EXCL: "PERL5LIB",
    },
  },
);
if (probe.status !== 0 || probe.stdout.trim() !== "ok") {
  fail(
    `the copied modules do not load (${(probe.stderr || probe.stdout || "no output").trim().split("\n")[0]}).`,
    "  A loadable-library mismatch means a binary artefact reached the copy; delete\n" +
      `  ${PERL_LIB} and run this again.`,
  );
}

console.log(
  [
    `android-toolchain: OK — ${OUT}`,
    `  make shim  ${SHIM}`,
    `  perl lib   ${PERL_LIB} (${copied.length} module tree(s), binaries pruned)`,
    "",
    "  `npm run verify` finds both here, so the Android target compiles with no",
    "  shell setup. A release build still needs the exports below",
    '  (docs/ANDROID_TOOLCHAIN.md, "Session 5"):',
    "",
    `    export MSYS2_ENV_CONV_EXCL="PERL5LIB;MAKEFLAGS"`,
    `    export PERL5LIB='${posixPath(PERL_LIB)}'`,
    `    export PATH="${posixPath(SHIM)}:$PATH"`,
  ].join("\n"),
);
