#!/usr/bin/env node
/**
 * Local-gate arming check (plan §7): warns — never fails — when
 * core.hooksPath is not .githooks, so a fresh clone notices the
 * pre-push gate is not armed.
 */
import { execFileSync } from "node:child_process";

const EXPECTED = ".githooks";

function warn(reason) {
  console.warn(
    `check-hooks: WARNING — local gate not armed (${reason}).\n` +
      "  Run: git config core.hooksPath .githooks",
  );
}

try {
  const current = execFileSync("git", ["config", "--get", "core.hooksPath"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
  if (current !== EXPECTED) {
    warn(`core.hooksPath is "${current || "<unset>"}"`);
  }
} catch {
  warn("git config core.hooksPath exited non-zero");
}
