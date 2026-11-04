import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { DataDriver } from "../data/driver.ts";
import { isMobileSearchType, mobileSearch } from "./mobileSearch.ts";

/** A driver that records every statement and answers "no rows". */
function recordingDriver(): DataDriver & { statements: string[] } {
  const statements: string[] = [];
  const driver: DataDriver & { statements: string[] } = {
    statements,
    async query<T>(sql: string) {
      statements.push(sql);
      return [] as T[];
    },
    async execute(sql: string) {
      statements.push(sql);
      return { rowsAffected: 0, lastInsertRowid: 0 };
    },
    async batch(batch) {
      for (const statement of batch) statements.push(statement.sql);
    },
    async begin() {},
    async commit() {},
    async rollback() {},
    async resetTxn() {},
    async savePhoto() {
      return "";
    },
    async readPhoto() {
      return new Uint8Array();
    },
    async readPhotoThumb() {
      return new Uint8Array();
    },
    async savePhotoThumb() {
      return "";
    },
    async deletePhoto() {},
    async saveDbKeyFile() {},
    async saveBackupFile() {},
    async saveExportFile() {},
    async safetyBackupCopy() {
      return "";
    },
    async shareStart() {
      return {
        running: false,
        url: null,
        key: null,
        port: null,
        publishedAt: null,
        note: null,
      };
    },
    async shareStop() {
      return {
        running: false,
        url: null,
        key: null,
        port: null,
        publishedAt: null,
        note: null,
      };
    },
    async shareStatus() {
      return {
        running: false,
        url: null,
        key: null,
        port: null,
        publishedAt: null,
        note: null,
      };
    },
    async sharePublish() {
      return {
        running: false,
        url: null,
        key: null,
        port: null,
        publishedAt: null,
        note: null,
      };
    },
    async shareArm() {
      return "";
    },
  };
  return driver;
}

test("mobileSearch: queries notes and tasks only, never an excluded module", async () => {
  const driver = recordingDriver();
  const groups = await mobileSearch(driver, "market");

  for (const group of groups) {
    assert.ok(isMobileSearchType(group.type), `${group.type} is not mobile`);
  }
  const sql = driver.statements.join("\n");
  // Both allowlisted entities were queried, so the assertion below is not
  // passing merely because nothing ran.
  assert.ok(sql.includes("FROM notes"), "notes are searched");
  assert.ok(sql.includes("FROM tasks"), "tasks are searched");
  for (const excluded of [
    "journal_entries",
    "contacts",
    "memories",
    "photos",
    "loans",
    "jobs",
    "payables",
    "shopping_items",
  ]) {
    assert.ok(
      !sql.includes(excluded),
      `${excluded} must not be queried on the phone — a filter after the query would still have shipped the rows`,
    );
  }
});

test("mobileSearch: the caller cannot widen the allowlist", async () => {
  const driver = recordingDriver();
  // @ts-expect-error — `types` is deliberately not part of the caller's options.
  await mobileSearch(driver, "market", { types: ["journal", "contact"] });
  const sql = driver.statements.join("\n");
  assert.ok(!sql.includes("journal_entries"));
  assert.ok(!sql.includes("contacts"));
});

test("isMobileSearchType: only the allowlisted entities pass", () => {
  assert.equal(isMobileSearchType("note"), true);
  assert.equal(isMobileSearchType("task"), true);
  for (const type of [
    "journal",
    "contact",
    "memory",
    "job",
    "loan",
    "payable",
    "shopping_item",
  ]) {
    assert.equal(isMobileSearchType(type), false, `${type} is desktop-only`);
  }
});
