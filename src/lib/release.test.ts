import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  assertVersion,
  buildLatestJson,
  RELEASE_PLATFORM,
  releaseAssetUrl,
} from "./release.ts";

test("buildLatestJson produces the manifest the updater plugin validates", () => {
  const manifest = buildLatestJson({
    version: "0.2.0",
    notes: "First release.",
    pubDate: "2026-10-12T10:00:00.000Z",
    platform: RELEASE_PLATFORM,
    signature: "dW50cnVzdGVkIGNvbnRlbnQ=",
    url: "https://github.com/minlulin/PurpleMemo/releases/download/v0.2.0/purple-memo_0.2.0_x64-setup.exe",
  });
  assert.deepEqual(Object.keys(manifest).sort(), [
    "notes",
    "platforms",
    "pub_date",
    "version",
  ]);
  assert.equal(manifest.version, "0.2.0");
  assert.equal(manifest.pub_date, "2026-10-12T10:00:00.000Z");
  assert.deepEqual(manifest.platforms[RELEASE_PLATFORM], {
    signature: "dW50cnVzdGVkIGNvbnRlbnQ=",
    url: "https://github.com/minlulin/PurpleMemo/releases/download/v0.2.0/purple-memo_0.2.0_x64-setup.exe",
  });
});

test("buildLatestJson refuses a manifest the updater would reject", () => {
  const base = {
    version: "0.2.0",
    notes: "",
    pubDate: "2026-10-12T10:00:00.000Z",
    platform: RELEASE_PLATFORM,
    signature: "sig",
    url: "https://example.com/app.exe",
  };
  assert.throws(() => buildLatestJson({ ...base, signature: "" }), /signature/);
  assert.throws(() => buildLatestJson({ ...base, url: "" }), /url/);
  assert.throws(
    () => buildLatestJson({ ...base, version: "v0.2.0" }),
    /semver/i,
  );
  assert.throws(
    () => buildLatestJson({ ...base, pubDate: "12 Oct 2026" }),
    /RFC 3339/,
  );
});

test("assertVersion accepts X.Y.Z and rejects everything the updater can't compare", () => {
  assert.doesNotThrow(() => assertVersion("0.2.0"));
  assert.doesNotThrow(() => assertVersion("1.0.0-beta.1"));
  for (const bad of ["", "0.2", "v0.2.0", "0.2.0.1", "latest"]) {
    assert.throws(() => assertVersion(bad), /semver/i, `must reject ${bad}`);
  }
});

test("releaseAssetUrl points at the uploaded asset for that tag", () => {
  assert.equal(
    releaseAssetUrl("minlulin/PurpleMemo", "v0.2.0", "purple-memo.exe"),
    "https://github.com/minlulin/PurpleMemo/releases/download/v0.2.0/purple-memo.exe",
  );
  // GitHub stores a space as a dot and cannot be renamed back, so the URL
  // must use the stored name — not the `%20` form, which 404s.
  assert.equal(
    releaseAssetUrl("minlulin/PurpleMemo", "v0.2.0", "purple memo.exe"),
    "https://github.com/minlulin/PurpleMemo/releases/download/v0.2.0/purple.memo.exe",
  );
  assert.equal(
    releaseAssetUrl(
      "minlulin/PurpleMemo",
      "v0.2.0",
      "Purple Memo_0.2.0_x64-setup.exe",
    ),
    "https://github.com/minlulin/PurpleMemo/releases/download/v0.2.0/Purple.Memo_0.2.0_x64-setup.exe",
  );
  assert.throws(
    () => releaseAssetUrl("minlulin/PurpleMemo", "v0.2.0", ""),
    /filename/,
  );
});
