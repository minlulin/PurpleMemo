import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const stylesDir = dirname(fileURLToPath(import.meta.url));

test("tokens.css anchors the brand purple sampled from the logo", () => {
  const css = readFileSync(join(stylesDir, "tokens.css"), "utf8");
  assert.match(css, /--color-brand:\s*#310096\b/i);
  assert.match(css, /--color-accent:\s*#794dff\b/i);
});

test("tokens.css defines the figure class for tabular numerals", () => {
  const css = readFileSync(join(stylesDir, "tokens.css"), "utf8");
  assert.match(css, /\.figure\s*\{[^}]*font-variant-numeric:\s*tabular-nums/);
});
