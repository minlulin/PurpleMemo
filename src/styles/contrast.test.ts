import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

// WCAG 2.1 AA text contrast, enforced (plan 15.13). Every pair below is a real
// foreground/background combination used in app.css — the point is to catch a
// future token edit that quietly pushes text below 4.5:1, which is exactly how
// the original palette failed: every "soft" status hue looked fine on its own
// and only fell short once composited over its real surface.

const stylesDir = dirname(fileURLToPath(import.meta.url));

interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

function parseColor(raw: string): Rgba | null {
  const value = raw.trim();
  const hex = value.match(/^#([0-9a-f]{3,8})$/i);
  if (hex) {
    let digits = hex[1] ?? "";
    if (digits.length === 3 || digits.length === 4) {
      digits = digits
        .split("")
        .map((c) => c + c)
        .join("");
    }
    if (digits.length !== 6 && digits.length !== 8) return null;
    return {
      r: parseInt(digits.slice(0, 2), 16),
      g: parseInt(digits.slice(2, 4), 16),
      b: parseInt(digits.slice(4, 6), 16),
      a: digits.length === 8 ? parseInt(digits.slice(6, 8), 16) / 255 : 1,
    };
  }
  const rgb = value.match(/^rgba?\(([^)]+)\)$/i);
  if (rgb) {
    const [r = 0, g = 0, b = 0, alpha = 1] = (rgb[1] ?? "")
      .split(/[\s,/]+/)
      .filter(Boolean)
      .map(Number);
    return { r, g, b, a: alpha };
  }
  return null;
}

/** Alpha compositing: `fg` at its own alpha over an opaque `bg`. */
function over(fg: Rgba, bg: Rgba): Rgba {
  return {
    r: fg.r * fg.a + bg.r * (1 - fg.a),
    g: fg.g * fg.a + bg.g * (1 - fg.a),
    b: fg.b * fg.a + bg.b * (1 - fg.a),
    a: 1,
  };
}

function relativeLuminance(c: Rgba): number {
  const channel = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(c.r) + 0.7152 * channel(c.g) + 0.0722 * channel(c.b);
}

function contrast(a: Rgba, b: Rgba): number {
  const one = relativeLuminance(a);
  const two = relativeLuminance(b);
  return (Math.max(one, two) + 0.05) / (Math.min(one, two) + 0.05);
}

/** The base `:root` block plus everything `[data-theme="light"]` redeclares. */
function readThemes(): Record<string, Map<string, Rgba>> {
  const css = readFileSync(join(stylesDir, "tokens.css"), "utf8");
  const base = new Map<string, Rgba>();
  const light = new Map<string, Rgba>();
  let target: Map<string, Rgba> | null = base;

  for (const rawLine of css.split("\n")) {
    const line = rawLine.trim();
    if (/^\[data-theme="light"\]\s*\{/.test(line)) {
      target = light;
      continue;
    }
    if (
      /^@media\s*\(/.test(line) ||
      /^\}/.test(line) ||
      /^:root\s*\{/.test(line)
    ) {
      continue;
    }
    const decl = line.match(/^(--[a-z0-9-]+)\s*:\s*(.+?);$/);
    const name = decl?.[1];
    const raw = decl?.[2];
    if (name && raw && target) {
      const color = parseColor(raw);
      if (color) target.set(name, color);
    }
  }
  // The light theme only redeclares what differs, so it inherits the rest.
  for (const [name, value] of base) {
    if (!light.has(name)) light.set(name, value);
  }
  return { dark: base, light };
}

/** Resolves `token`, compositing `*-soft` tints over the surface behind them. */
function surface(
  themes: Map<string, Rgba>,
  token: string,
  base?: string,
): Rgba {
  const value = themes.get(token);
  if (!value) throw new Error(`tokens.css is missing ${token}`);
  const opaque = base ? themes.get(base) : undefined;
  if (!opaque) return { ...value, a: 1 };
  return value.a < 1 ? over(value, opaque) : { ...value, a: 1 };
}

const AA = 4.5;

test("every text pair clears WCAG AA in both themes", () => {
  const themes = readThemes();
  const pairs: [string, string, string?][] = [
    ["--color-text", "--color-surface"],
    ["--color-text", "--color-surface-raised"],
    ["--color-text", "--color-surface-input"],
    ["--color-text", "--color-surface-hover"],
    ["--color-text-muted", "--color-surface"],
    ["--color-text-muted", "--color-surface-raised"],
    ["--color-text-muted", "--color-surface-input"],
    // Placeholders and metadata: still text, so still AA (15.9).
    ["--color-text-subtle", "--color-surface"],
    ["--color-text-subtle", "--color-surface-raised"],
    ["--color-text-subtle", "--color-surface-input"],
    ["--color-accent", "--color-surface"],
    ["--color-accent", "--color-surface-raised"],
    ["--color-danger", "--color-surface"],
    ["--color-danger", "--color-surface-raised"],
    ["--color-success", "--color-surface-raised"],
    ["--color-warn", "--color-surface-raised"],
    // Badges and alerts: tinted text on the matching soft tint.
    ["--color-accent", "--color-accent-soft", "--color-surface-raised"],
    ["--color-danger", "--color-danger-soft", "--color-surface"],
    ["--color-danger", "--color-danger-soft", "--color-surface-raised"],
    ["--color-success", "--color-success-soft", "--color-surface-raised"],
    ["--color-warn", "--color-warn-soft", "--color-surface-raised"],
    // Inverse text on the two solid surfaces that carry it.
    ["--color-text-inverse", "--color-brand"],
    ["--color-text-inverse", "--color-accent-gradient-start"],
    ["--color-text-inverse", "--color-accent-gradient-end"],
  ];

  const failures: string[] = [];
  for (const [name, map] of Object.entries(themes)) {
    for (const [fg, bg, base] of pairs) {
      const ratio = contrast(surface(map, fg), surface(map, bg, base));
      if (ratio < AA) {
        failures.push(
          `${name}: ${fg} on ${base ? `${bg} over ${base}` : bg} = ${ratio.toFixed(2)}:1`,
        );
      }
    }
  }
  assert.deepEqual(failures, []);
});

test("focus indicators reach 3:1 through the accent border", () => {
  // Every `*:focus-visible` rule swaps `border-color` to the accent and adds a
  // translucent ring. The ring alone is deliberately soft, so the border is
  // what has to carry the 3:1 (WCAG 2.2 SC 2.4.11).
  const themes = readThemes();
  for (const [name, map] of Object.entries(themes)) {
    for (const bg of [
      "--color-surface",
      "--color-surface-raised",
      "--color-surface-input",
    ]) {
      const ratio = contrast(surface(map, "--color-accent"), surface(map, bg));
      assert.ok(
        ratio >= 3,
        `${name}: accent border on ${bg} = ${ratio.toFixed(2)}:1, needs 3:1`,
      );
    }
  }
});
