#!/usr/bin/env node
/**
 * Capability pin: the two Tauri capability files, exactly as reviewed.
 *
 * A capability is the renderer's permission grant, split by platform:
 * `default.json` serves the desktop window (updater and opener included),
 * `mobile.json` serves the phone (neither — the phone sideloads its APK
 * and opens links through the app's own command). Nothing fails a build
 * when these drift: a permission added to the mobile file would ride
 * into the phone build quietly, and one dropped from the desktop file
 * would surface only as a feature refusing at runtime. So the platform
 * lists and permission sets are pinned here, the same way
 * `check-android-manifest.mjs` pins the manifest's permissions — adding
 * one is a deliberate edit in both places (Arena review 2026-11-23, P3).
 */
import { readFileSync } from "node:fs";

const PINNED = [
  {
    file: "src-tauri/capabilities/default.json",
    identifier: "default",
    platforms: ["linux", "windows", "macOS"],
    permissions: [
      "core:default",
      "updater:default",
      "notification:default",
      "dialog:default",
      "opener:allow-open-url",
      "opener:allow-default-urls",
    ],
  },
  {
    file: "src-tauri/capabilities/mobile.json",
    identifier: "mobile",
    platforms: ["android", "iOS"],
    permissions: ["core:default", "notification:default", "dialog:default"],
  },
];

function fail(reason, remedy) {
  console.error(
    `check-capabilities: FAILED — ${reason}${remedy ? `\n${remedy}` : ""}`,
  );
  process.exit(1);
}

function sameSet(actual, expected) {
  return (
    Array.isArray(actual) &&
    actual.length === expected.length &&
    expected.every((item) => actual.includes(item))
  );
}

for (const pin of PINNED) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(pin.file, "utf8"));
  } catch (e) {
    fail(`${pin.file} does not parse: ${e.message}`);
  }
  if (parsed.identifier !== pin.identifier) {
    fail(
      `${pin.file} names itself "${parsed.identifier}", not "${pin.identifier}"`,
      "The capability identifier is how Tauri matches the file to its window; a rename silently ungrants everything in it.",
    );
  }
  if (!sameSet(parsed.platforms, pin.platforms)) {
    fail(
      `${pin.file} platforms are ${JSON.stringify(parsed.platforms)}, pinned to ${JSON.stringify(pin.platforms)}`,
      "A platform added here extends this grant to another OS. If that is intended, update the pin in scripts/check-capabilities.mjs in the same change.",
    );
  }
  if (!sameSet(parsed.permissions, pin.permissions)) {
    fail(
      `${pin.file} permissions are ${JSON.stringify(parsed.permissions)}, pinned to ${JSON.stringify(pin.permissions)}`,
      "A permission added here is granted to the renderer on every platform in this file's list. If that is intended, update the pin in scripts/check-capabilities.mjs in the same change.",
    );
  }
  console.log(
    `check-capabilities: ${pin.identifier} OK — ${pin.platforms.length} platform(s), ${pin.permissions.length} permission(s) pinned`,
  );
}
