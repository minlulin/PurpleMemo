// Keyed mutex (§4): same-key critical sections serialize, different keys
// don't block each other, and a throwing section releases the lock.

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { createKeyedMutex } from "./mutex.ts";

const tick = () => new Promise((res) => setTimeout(res, 5));

test("withLock: same key runs critical sections one after another", async () => {
	const mutex = createKeyedMutex();
	const order: string[] = [];
	const job = async (name: string) =>
		mutex.withLock("job:1", async () => {
			order.push(`${name}-start`);
			await tick();
			order.push(`${name}-end`);
			return name;
		});
	const [r1, r2] = await Promise.all([job("a"), job("b")]);
	assert.deepEqual([r1, r2], ["a", "b"]);
	assert.deepEqual(order, ["a-start", "a-end", "b-start", "b-end"]);
});

test("withLock: different keys run concurrently", async () => {
	const mutex = createKeyedMutex();
	const order: string[] = [];
	const job = async (key: string) =>
		mutex.withLock(key, async () => {
			order.push(`${key}-start`);
			await tick();
			order.push(`${key}-end`);
		});
	await Promise.all([job("a"), job("b")]);
	assert.deepEqual(order, ["a-start", "b-start", "a-end", "b-end"]);
});

test("withLock: a throwing section still releases the lock", async () => {
	const mutex = createKeyedMutex();
	await assert.rejects(
		mutex.withLock("k", async () => {
			throw new Error("boom");
		}),
		/boom/,
	);
	const result = await mutex.withLock("k", async () => "recovered");
	assert.equal(result, "recovered");
});
