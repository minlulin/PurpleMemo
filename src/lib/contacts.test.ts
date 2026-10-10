import { strict as assert } from "node:assert";
import { test } from "node:test";

import { upcomingBirthday } from "./contacts.ts";

test("upcomingBirthday: within the window, same year", () => {
  assert.equal(upcomingBirthday("1990-10-20", "2026-10-10", 14), true);
  assert.equal(
    upcomingBirthday("1990-10-24", "2026-10-10", 14),
    true,
    "exactly 14 days",
  );
  assert.equal(
    upcomingBirthday("1990-10-25", "2026-10-10", 14),
    false,
    "15 days out",
  );
});

test("upcomingBirthday: today counts", () => {
  assert.equal(upcomingBirthday("1990-10-10", "2026-10-10", 14), true);
});

test("upcomingBirthday: already passed this year does not count", () => {
  assert.equal(upcomingBirthday("1990-10-01", "2026-10-10", 14), false);
});

test("upcomingBirthday: month-day birthdays (no year) match by MM-DD", () => {
  assert.equal(upcomingBirthday("10-20", "2026-10-10", 14), true);
  assert.equal(upcomingBirthday("10-01", "2026-10-10", 14), false);
});
