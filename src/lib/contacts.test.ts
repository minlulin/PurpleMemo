import { strict as assert } from "node:assert";
import { test } from "node:test";

import { createMockDriver } from "../data/mock-driver.ts";
import { createContactsRepo, upcomingBirthday } from "./contacts.ts";

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

test("upcomingBirthday: wraps the year boundary (Dec -> Jan)", () => {
	assert.equal(upcomingBirthday("1990-01-05", "2026-12-30", 14), true);
	assert.equal(upcomingBirthday("01-05", "2026-12-30", 14), true);
	assert.equal(upcomingBirthday("1990-02-01", "2026-12-30", 14), false);
});

test("upcomingBirthday: today counts as upcoming", () => {
	assert.equal(upcomingBirthday("1990-10-10", "2026-10-10", 14), true);
});

test("setPrimaryChannel rejects a channel from another contact", async () => {
	const driver = createMockDriver({
		results: [
			[
				/* no rows: wrong contact */
			],
		],
	});
	const contacts = createContactsRepo(driver);
	await assert.rejects(
		contacts.setPrimaryChannel(1, 99),
		/does not belong to contact/,
	);
	assert.equal(driver.callsTo("batch").length, 0);
});

test("setPrimaryChannel scopes both updates to the contact", async () => {
	const driver = createMockDriver({ results: [[{ id: 7 }]] });
	const contacts = createContactsRepo(driver);
	await contacts.setPrimaryChannel(1, 7);
	const batch = driver.callsTo("batch")[0]?.args[0] as {
		sql: string;
		params: unknown[];
	}[];
	assert.equal(batch.length, 2);
	assert.match(batch[0]?.sql ?? "", /WHERE contact_id = \?/);
	assert.match(batch[1]?.sql ?? "", /WHERE id = \? AND contact_id = \?/);
});
