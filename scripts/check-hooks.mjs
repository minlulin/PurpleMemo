#!/usr/bin/env node
/**
 * Local-gate arming check.
 *
 * There is no hosted CI: the pre-push hook running `npm run verify` IS the
 * enforcement, so a clone where `core.hooksPath` is unset has no gate at all.
 * This check therefore FAILS rather than warns — a green
 * `npm run verify` next to an unarmed hook was the one combination the README
 * claimed could not happen.
 *
 * Two cases stay non-failing, because neither has a hook to arm:
 *  - not inside a git checkout (a source tarball, a packaged copy), and
 *  - no `git` executable on PATH.
 * Both say so on stderr and exit 0 instead of blocking an install.
 */
import { execFileSync } from "node:child_process";

const EXPECTED = ".githooks";
const REMEDY = "Run: git config core.hooksPath .githooks";

function fail(reason) {
  console.error(
    `check-hooks: FAILED — local gate not armed (${reason}).\n  ${REMEDY}`,
  );
  process.exit(1);
}

// A missing git binary surfaces as ENOENT here; anything else means we are
// simply not standing in a checkout. Neither has a hook to arm.
try {
  execFileSync("git", ["rev-parse", "--is-inside-work-tree"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
} catch (error) {
  if (error?.code === "ENOENT") {
    console.warn(
      "check-hooks: WARNING — git is not installed; nothing to arm.",
    );
    process.exit(0);
  }
  console.warn(
    "check-hooks: WARNING — not a git checkout; the local gate does not apply.",
  );
  process.exit(0);
}

// Exit status 1 from `git config --get` means "set nowhere", which is exactly
// the unarmed case — not a broken command.
try {
  const current = execFileSync("git", ["config", "--get", "core.hooksPath"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
  if (current !== EXPECTED) {
    fail(`core.hooksPath is "${current || "<unset>"}"`);
  }
} catch (error) {
  if (error?.status === 1) {
    fail('core.hooksPath is "<unset>"');
  }
  fail(error instanceof Error ? error.message : String(error));
}
