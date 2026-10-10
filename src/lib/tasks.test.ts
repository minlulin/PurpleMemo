// Tasks repository: partial updates write only the provided fields.

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { createMockDriver } from "../data/mock-driver.ts";
import { createTasksRepo } from "./tasks.ts";

test("updateTask writes only the provided fields (no NULL wipe)", async () => {
	const driver = createMockDriver();
	const tasks = createTasksRepo(driver);
	await tasks.updateTask(3, { title: "Call shop" });
	const call = driver.lastCall();
	assert.ok(call);
	const [sql, params] = call.args as [string, unknown[]];
	assert.match(sql, /UPDATE tasks SET title = \? WHERE id = \?/);
	assert.deepEqual(params, ["Call shop", 3]);
});

test("updateTask with explicit null clears a nullable field", async () => {
	const driver = createMockDriver();
	const tasks = createTasksRepo(driver);
	await tasks.updateTask(3, { dueDate: null });
	const call = driver.lastCall();
	assert.ok(call);
	const [sql, params] = call.args as [string, unknown[]];
	assert.match(sql, /UPDATE tasks SET due_date = \? WHERE id = \?/);
	assert.deepEqual(params, [null, 3]);
});
