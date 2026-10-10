// Gallery repository (§2.7): saving identical bytes twice returns the
// existing row instead of violating the rel_path UNIQUE constraint.

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { createMockDriver } from "../data/mock-driver.ts";
import { createGalleryRepo } from "./gallery.ts";

test("savePhoto: duplicate bytes return the existing row, no second INSERT", async () => {
	const driver = createMockDriver({
		results: [
			[], // first save: no existing row for rel_path
			[{ id: 7 }], // second save: row already exists
		],
	});
	const gallery = createGalleryRepo(driver);
	const bytes = [10, 20, 30, 40];
	const first = await gallery.savePhoto({ bytes, ext: "jpg" });
	assert.equal(first, 1);
	const second = await gallery.savePhoto({ bytes, ext: "jpg" });
	assert.equal(second, 7);
	const inserts = driver
		.callsTo("execute")
		.filter((c) => /INSERT INTO photos/.test(c.args[0] as string));
	assert.equal(inserts.length, 1);
});
