#!/usr/bin/env node
/**
 * Android manifest permission pin (F9, docs/ANDROID_DISTRIBUTION.md §3).
 *
 * The manifest is committed source, and a wrong permission list fails quietly.
 * On 2026-11-11 `android.permission.CAMERA` went missing: the build was green,
 * the APK installed, and pairing's QR scan simply reported "This build cannot
 * reach a camera here", because Android only exposes `getUserMedia`'s camera to
 * an app that declares the permission in the manifest. In the other direction,
 * a permission nobody needs is granted to the WebView's origin and appears on
 * the installer's access list — a promise about privacy the app does not make.
 *
 * Neither mistake breaks a build, so a build cannot catch either. The set is
 * read from the file and compared with the list the code actually uses, so
 * adding one is a deliberate edit here as well.
 */
import { readFileSync } from "node:fs";

const MANIFEST = "src-tauri/gen/android/app/src/main/AndroidManifest.xml";

/** What the app's code uses, in the order the manifest declares it. */
const PINNED = [
  ["android.permission.INTERNET", "sync and the local server"],
  ["android.permission.CAMERA", "pairing's QR scan (§11.1)"],
  ["android.permission.POST_NOTIFICATIONS", "reminder notifications"],
  ["android.permission.SCHEDULE_EXACT_ALARM", "exact reminder alarms"],
  [
    "android.permission.RECEIVE_BOOT_COMPLETED",
    "re-arming alarms after a reboot",
  ],
];

function fail(reason, remedy) {
  console.error(
    `check-android-manifest: FAILED — ${reason}${remedy ? `\n${remedy}` : ""}`,
  );
  process.exit(1);
}

/**
 * The `android:name` of every `<uses-permission>` element. The attribute may be
 * on another line than the tag, so the match runs to the tag's `>` rather than
 * within a line — the same reason a line-based read would miss a hand-reformatted
 * file.
 */
function permissionsIn(text) {
  const names = new Set();
  for (const match of text.matchAll(
    /<uses-permission\b[^>]*?\bandroid:name\s*=\s*"([^"]+)"/g,
  )) {
    names.add(match[1]);
  }
  return names;
}

let text;
try {
  text = readFileSync(MANIFEST, "utf8");
} catch {
  fail(
    `${MANIFEST} is missing, so its permissions cannot be checked.`,
    "  The generated Android project is committed (decision 2026-11-02); restore\n" +
      `  it with: git checkout -- ${MANIFEST}`,
  );
}
if (!/<manifest\b/.test(text)) {
  fail(`${MANIFEST} carries no <manifest> element.`);
}

const declared = permissionsIn(text);
if (declared.size === 0) {
  fail(
    `${MANIFEST} declares no <uses-permission> at all — the app cannot reach the\n` +
      "  network or a camera, and no reader of this file would notice.",
  );
}

const pinned = new Set(PINNED.map(([name]) => name));
const missing = [...pinned].filter((name) => !declared.has(name));
const extra = [...declared].filter((name) => !pinned.has(name));

if (missing.length > 0 || extra.length > 0) {
  const reasons = new Map(PINNED);
  const lines = [];
  for (const name of missing) {
    lines.push(`  missing: ${name} — ${reasons.get(name)}`);
  }
  for (const name of extra) {
    lines.push(`  unexpected: ${name} — no code here needs it`);
  }
  fail(
    `${MANIFEST} and the pinned permission list disagree:\n${lines.join("\n")}`,
    "  If the app now needs a permission, add it to PINNED in\n" +
      "  scripts/check-android-manifest.mjs with the code that uses it, and say why\n" +
      "  in AndroidManifest.xml's comment; if nothing needs it, drop it from the\n" +
      "  manifest. docs/ANDROID_DISTRIBUTION.md §3 has the release rule.",
  );
}

console.log(
  `check-android-manifest: OK — ${declared.size} permission(s) pinned: ` +
    [...pinned]
      .map((name) => name.replace(/^android\.permission\./, ""))
      .join(", "),
);
