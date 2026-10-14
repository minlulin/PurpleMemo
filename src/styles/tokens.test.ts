import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const stylesDir = dirname(fileURLToPath(import.meta.url));

test("tokens.css anchors the brand purple sampled from the logo", () => {
  const css = readFileSync(join(stylesDir, "tokens.css"), "utf8");
  assert.match(css, /--color-brand:\s*#310096\b/i);
  // The accent is a text colour as well as a fill (contrast.test.ts), so it is
  // tuned lighter than the logo-adjacent #794dff to clear 4.5:1 on dark.
  assert.match(css, /--color-accent:\s*#a182ff\b/i);
});

test("tokens.css defines the figure class for tabular numerals", () => {
  const css = readFileSync(join(stylesDir, "tokens.css"), "utf8");
  assert.match(css, /\.figure\s*\{[^}]*font-variant-numeric:\s*tabular-nums/);
});
