// P5 in-app updater: the app checks the configured release endpoint,
// downloads, installs — always after the updater verifies the release
// signature, which the Tauri plugin does in Rust against the public key in
// `tauri.conf.json`. No CI is involved anywhere: releases are built, signed
// and published by hand (see docs/RELEASE.md).
//
// The plugin itself is imported dynamically: the pure parts below stay
// testable under `node --test`, and the Tauri runtime only loads when a
// check actually runs.

/** The narrow slice of the plugin's `Update` this module needs. */
export interface UpdateHandle {
  version: string;
  currentVersion: string;
  date?: string;
  body?: string;
  downloadAndInstall(
    onEvent: (event: UpdateDownloadEvent) => void,
  ): Promise<void>;
}

/** Mirrors the plugin's `DownloadEvent` without importing it. */
export type UpdateDownloadEvent =
  | { event: "Started"; data: { contentLength?: number } }
  | { event: "Progress"; data: { chunkLength: number } }
  | { event: "Finished" };

/** Cap on shown release notes — a manifest body is not a changelog reader. */
export const NOTES_MAX_CHARS = 1_200;

/** One-line description of an available update. */
export function describeUpdate(update: {
  currentVersion: string;
  version: string;
}): string {
  return `Purple Memo ${update.version} is available — you have ${update.currentVersion}.`;
}

/** Release notes as shown in Settings: trimmed, and capped when enormous. */
export function notesExcerpt(body: string | undefined): string {
  const text = (body ?? "").trim();
  if (text.length <= NOTES_MAX_CHARS) return text;
  return `${text.slice(0, NOTES_MAX_CHARS - 1).trimEnd()}…`;
}

/**
 * Download completion as a whole percent, or `null` while the total is
 * unknown (no `Content-Length` — report progress without inventing a figure).
 */
export function progressPercent(
  downloaded: number,
  total: number | undefined | null,
): number | null {
  if (total === undefined || total === null || total <= 0) return null;
  const ratio = downloaded / total;
  if (!Number.isFinite(ratio)) return null;
  return Math.min(100, Math.max(0, Math.round(ratio * 100)));
}

/**
 * Ask the configured endpoint whether a newer release exists. Returns null
 * when the running build is current; throws (surfaced verbatim in Settings)
 * when the endpoint is unreachable — which is the normal answer until the
 * first release is published
 */
export async function checkForUpdate(): Promise<UpdateHandle | null> {
  const { check } = await import("@tauri-apps/plugin-updater");
  const update = await check();
  if (update === null) return null;
  return {
    version: update.version,
    currentVersion: update.currentVersion,
    date: update.date,
    body: update.body,
    downloadAndInstall: (onEvent) => update.downloadAndInstall(onEvent),
  };
}

/**
 * Download and install, reporting progress as it goes. On Windows the
 * installer exits the app; on other platforms the app must be restarted to
 * run the new build. Failures propagate — a silent failed update would leave
 * the user on an old version with no idea why.
 */
export async function installUpdate(
  update: UpdateHandle,
  onProgress: (percent: number | null) => void,
): Promise<void> {
  let total: number | undefined;
  let downloaded = 0;
  await update.downloadAndInstall((event) => {
    switch (event.event) {
      case "Started":
        total = event.data.contentLength;
        onProgress(progressPercent(downloaded, total));
        break;
      case "Progress":
        downloaded += event.data.chunkLength;
        onProgress(progressPercent(downloaded, total));
        break;
      default:
        onProgress(100);
        break;
    }
  });
}
