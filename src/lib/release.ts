// P5 release manifest: the hand-made `latest.json` the updater plugin
// polls. `tauri build` emits the signed installer and its `.sig`, but NOT the
// manifest — the Tauri docs generate it only in the (unused, banned) GitHub
// Action. Writing it by hand is the easiest way to ship a release that the
// app silently refuses, so the shape is built and checked here instead.
//
// The signature field carries the CONTENTS of the `.sig` file — the plugin
// rejects a path or URL.

/** The platform key Tauri uses for a Windows x64 build. */
export const RELEASE_PLATFORM = "windows-x86_64";

export interface LatestJsonPlatform {
  signature: string;
  url: string;
}

export interface LatestJson {
  version: string;
  notes: string;
  pub_date: string;
  platforms: Record<string, LatestJsonPlatform>;
}

export interface ReleaseInput {
  /** Release version, semver WITHOUT the `v` (the tag keeps the `v`). */
  version: string;
  notes: string;
  /** RFC 3339 timestamp. */
  pubDate: string;
  platform: string;
  /** Contents of the installer's `.sig` file. */
  signature: string;
  /** Direct download URL of the signed installer asset. */
  url: string;
}

/** Throw unless `version` is valid semver (no leading `v`). */
export function assertVersion(version: string): void {
  // Semver core + optional pre-release/build metadata; deliberately strict —
  // the updater compares versions, and "v0.2.0" would never match app 0.2.0.
  const semver =
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-.]+)?(?:\+[0-9A-Za-z-.]+)?$/;
  if (!semver.test(version)) {
    throw new Error(
      `not a semver release version (expected X.Y.Z): ${version}`,
    );
  }
}

/**
 * The name GitHub actually stores an upload under. Both `gh release create`
 * and the API replace spaces with dots and refuse to rename them back, so the
 * on-disk name `Purple Memo_0.1.1_x64-setup.exe` is published as
 * `Purple.Memo_0.1.1_x64-setup.exe`. A URL built from the on-disk name 404s,
 * and the updater then has nothing to download — v0.1.0 and v0.1.1 both
 * shipped that bug. The rewrite happens before encoding, so the `%20` form is
 * never produced.
 */
export function githubAssetName(filename: string): string {
  return filename.replace(/ /g, ".");
}

/** Direct GitHub asset URL for a tag — the URL the manifest's platforms use. */
export function releaseAssetUrl(
  repo: string,
  tag: string,
  filename: string,
): string {
  if (filename.length === 0) {
    throw new Error("an asset filename is required");
  }
  const asset = githubAssetName(filename);
  return `https://github.com/${repo}/releases/download/${tag}/${encodeURIComponent(asset)}`;
}

/**
 * Build the manifest `latest.json`. Everything the plugin treats as required
 * is validated here, so a malformed release fails while the release is being
 * cut rather than on every user's machine.
 */
export function buildLatestJson(input: ReleaseInput): LatestJson {
  assertVersion(input.version);
  if (input.signature.trim().length === 0) {
    throw new Error(
      "the signature is required — it is the CONTENTS of the .sig file, not a path",
    );
  }
  if (input.url.trim().length === 0) {
    throw new Error("the platform url is required");
  }
  // Strict shape, not just `Date.parse`: V8 happily parses "12 Oct 2026",
  // which is not RFC 3339 and not what the updater documents.
  const rfc3339 =
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
  if (!rfc3339.test(input.pubDate) || Number.isNaN(Date.parse(input.pubDate))) {
    throw new Error(`pub_date must be an RFC 3339 timestamp: ${input.pubDate}`);
  }
  return {
    version: input.version,
    notes: input.notes,
    pub_date: input.pubDate,
    platforms: {
      [input.platform]: { signature: input.signature, url: input.url },
    },
  };
}
