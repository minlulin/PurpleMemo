// The local gate's arming check: `npm run verify` starts with
// `scripts/check-hooks.mjs`, and because no hosted CI exists the pre-push hook
// is the only enforcement. The script used to warn and exit 0, so a clone with
// the hook unarmed still produced a green gate. These tests run the real script
// in throwaway repositories and pin its exit status, because the status is the
// contract `verify` relies on.

import { strict as assert } from "node:assert";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(
  new URL("../../scripts/check-hooks.mjs", import.meta.url),
);

function gitAvailable(): boolean {
  try {
    execFileSync("git", ["--version"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * A temp directory plus the environment that keeps the host's own git config
 * out of the result: a global `core.hooksPath` would otherwise make the
 * "unarmed" case look armed.
 */
function sandbox(): {
  dir: string;
  env: NodeJS.ProcessEnv;
  cleanup: () => void;
} {
  const dir = mkdtempSync(join(tmpdir(), "purple-memo-gate-"));
  const emptyConfig = join(dir, "empty.gitconfig");
  writeFileSync(emptyConfig, "");
  const env = {
    ...process.env,
    GIT_CONFIG_GLOBAL: emptyConfig,
    GIT_CONFIG_SYSTEM: emptyConfig,
    GIT_CONFIG_NOSYSTEM: "1",
  };
  return {
    dir,
    env,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

function initRepo(dir: string, env: NodeJS.ProcessEnv): void {
  execFileSync("git", ["init", "-q"], { cwd: dir, env, stdio: "ignore" });
}

function run(dir: string, env: NodeJS.ProcessEnv) {
  return spawnSync(process.execPath, [SCRIPT], {
    cwd: dir,
    env,
    encoding: "utf8",
  });
}

const haveGit = gitAvailable();

test("check-hooks FAILS on a clone whose hook is unarmed", {
  skip: !haveGit,
}, () => {
  const box = sandbox();
  try {
    initRepo(box.dir, box.env);
    const result = run(box.dir, box.env);
    assert.equal(result.status, 1, "an unarmed gate must not report success");
    assert.match(result.stderr, /local gate not armed/);
    assert.match(result.stderr, /core\.hooksPath is "<unset>"/);
    assert.match(result.stderr, /git config core\.hooksPath \.githooks/);
  } finally {
    box.cleanup();
  }
});

test("check-hooks FAILS and names a wrong hooksPath", {
  skip: !haveGit,
}, () => {
  const box = sandbox();
  try {
    initRepo(box.dir, box.env);
    execFileSync("git", ["config", "core.hooksPath", "hooks"], {
      cwd: box.dir,
      env: box.env,
      stdio: "ignore",
    });
    const result = run(box.dir, box.env);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /core\.hooksPath is "hooks"/);
  } finally {
    box.cleanup();
  }
});

test("check-hooks passes silently once the hook is armed", {
  skip: !haveGit,
}, () => {
  const box = sandbox();
  try {
    initRepo(box.dir, box.env);
    execFileSync("git", ["config", "core.hooksPath", ".githooks"], {
      cwd: box.dir,
      env: box.env,
      stdio: "ignore",
    });
    const result = run(box.dir, box.env);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "");
  } finally {
    box.cleanup();
  }
});

test("check-hooks does not block a copy that is not a checkout", {
  skip: !haveGit,
}, () => {
  // A source tarball or a packaged copy has no hook to arm; failing there would
  // make the gate unrunnable outside git for no gain.
  const box = sandbox();
  try {
    const result = run(box.dir, box.env);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /not a git checkout/);
  } finally {
    box.cleanup();
  }
});
