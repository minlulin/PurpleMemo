#!/usr/bin/env node
/**
 * JNI keep-rule check: every bridge class the Rust side reaches by name must
 * have a ProGuard `-keep`, or release builds lose it.
 *
 * The Rust commands call their Kotlin bridges through JNI with the class name in
 * a string literal, so no bytecode references those classes. R8 cannot see what
 * does not exist as a reference: in the release variant it strips or renames
 * them, and the command then fails at runtime — silently, since a failed
 * reminder sync is best-effort and a stripped biometric bridge just answers
 * "unavailable". Debug builds do not run R8, so no debug-build device test can
 * catch it, and the hand-written keeps rotted once already: `BiometricBridge`
 * shipped without one. This step fails when a class named by a bridge constant
 * under `src-tauri/src` has no rule in `proguard-rules.pro`.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const RUST_ROOT = join("src-tauri", "src");
const RULES = join("src-tauri", "gen", "android", "app", "proguard-rules.pro");

/** `pub const BRIDGE: &str = "com.minlulin.purplememo.BiometricBridge";` */
const BRIDGE_CONST =
  /const\s+[A-Z][A-Z0-9_]*\s*:\s*&(?:'static\s+)?str\s*=\s*"(com\.minlulin\.purplememo\.[A-Za-z0-9_$]+)"/g;

/** `-keep class com.example.Thing { … }` */
const KEEP_CLASS = /^\s*-keep\s+class\s+([\w.$]+)/gm;

const bridges = [];
for (const name of readdirSync(RUST_ROOT, {
  recursive: true,
  encoding: "utf8",
})) {
  if (!name.endsWith(".rs")) continue;
  const file = join(RUST_ROOT, name);
  readFileSync(file, "utf8")
    .split("\n")
    .forEach((line, index) => {
      for (const match of line.matchAll(BRIDGE_CONST)) {
        bridges.push({ file, line: index + 1, name: match[1] });
      }
    });
}

if (bridges.length === 0) {
  console.error(
    `check-jni-keeps: FAILED — no bridge class constant under ${RUST_ROOT} matched ` +
      "'com.minlulin.purplememo.<Class>'; a rename must update this check too, " +
      "or the keeps stop being verified.",
  );
  process.exit(1);
}

const kept = new Set(
  [...readFileSync(RULES, "utf8").matchAll(KEEP_CLASS)].map(
    (match) => match[1],
  ),
);
const missing = bridges.filter((bridge) => !kept.has(bridge.name));
if (missing.length > 0) {
  console.error(
    "check-jni-keeps: FAILED — a JNI bridge class has no -keep rule, so R8 strips " +
      `or renames it in release builds. Add this to ${RULES}:`,
  );
  for (const bridge of missing) {
    console.error(
      `  ${bridge.file}:${bridge.line}  ${bridge.name}\n` +
        `    -keep class ${bridge.name} { public static *; }`,
    );
  }
  process.exit(1);
}

const names = [...new Set(bridges.map((bridge) => bridge.name))];
console.log(
  `check-jni-keeps: OK — ${names.length} JNI bridge class(es) named in ${RUST_ROOT} ` +
    `each have a -keep rule in ${RULES}: ${names.join(", ")}`,
);
