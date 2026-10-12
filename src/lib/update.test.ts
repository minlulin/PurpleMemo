import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  describeUpdate,
  installUpdate,
  notesExcerpt,
  progressPercent,
  type UpdateHandle,
} from "./update.ts";

/** A fake update handle: records the event callback it was handed. */
function fakeHandle(events: unknown[]) {
  let installed = false;
  const handle: UpdateHandle = {
    version: "0.2.0",
    currentVersion: "0.1.0",
    date: "2026-10-12T10:00:00Z",
    body: "Fixed things.",
    async downloadAndInstall(onEvent) {
      for (const event of events) {
        onEvent(event as Parameters<NonNullable<typeof onEvent>>[0]);
      }
      installed = true;
    },
  };
  return { handle, wasInstalled: () => installed };
}

test("describeUpdate names both versions (§9)", () => {
  assert.equal(
    describeUpdate({ currentVersion: "0.1.0", version: "0.2.0" }),
    "Purple Memo 0.2.0 is available — you have 0.1.0.",
  );
});

test("notesExcerpt trims release notes and caps absurd lengths", () => {
  assert.equal(notesExcerpt(undefined), "");
  assert.equal(notesExcerpt("  Fixed things.\n"), "Fixed things.");
  const long = "x".repeat(5_000);
  const excerpt = notesExcerpt(long);
  assert.ok(excerpt.length <= 1_200, `excerpt was ${excerpt.length} chars`);
  assert.ok(excerpt.endsWith("…"), "a truncated body must say so");
});

test("progressPercent is null without a total and clamped otherwise (§9)", () => {
  assert.equal(progressPercent(0, null), null);
  assert.equal(progressPercent(0, undefined), null);
  assert.equal(progressPercent(0, 0), null);
  assert.equal(progressPercent(50, 100), 50);
  assert.equal(progressPercent(1, 3), 33);
  assert.equal(progressPercent(150, 100), 100);
  assert.equal(progressPercent(-5, 100), 0);
});

test("installUpdate reports download progress from the plugin's events", async () => {
  const { handle, wasInstalled } = fakeHandle([
    { event: "Started", data: { contentLength: 200 } },
    { event: "Progress", data: { chunkLength: 100 } },
    { event: "Progress", data: { chunkLength: 100 } },
    { event: "Finished" },
  ]);
  const seen: (number | null)[] = [];
  await installUpdate(handle, (percent) => seen.push(percent));
  assert.deepEqual(seen, [0, 50, 100, 100]);
  assert.equal(wasInstalled(), true);
});

test("installUpdate reports unknown progress when the server sends no length", async () => {
  const { handle } = fakeHandle([
    { event: "Started", data: {} },
    { event: "Progress", data: { chunkLength: 10 } },
    { event: "Finished" },
  ]);
  const seen: (number | null)[] = [];
  await installUpdate(handle, (percent) => seen.push(percent));
  assert.deepEqual(seen, [null, null, 100]);
});

test("installUpdate surfaces a failed install instead of swallowing it (§9)", async () => {
  const handle: UpdateHandle = {
    version: "0.2.0",
    currentVersion: "0.1.0",
    async downloadAndInstall() {
      throw new Error("signature verification failed");
    },
  };
  await assert.rejects(
    () => installUpdate(handle, () => {}),
    /signature verification failed/,
  );
});
