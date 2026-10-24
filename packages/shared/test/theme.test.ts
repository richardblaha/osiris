import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { cssVar, THEME, type ThemeColors } from "../src/theme.ts";

const css = readFileSync(join(import.meta.dirname, "../../../apps/osiris-pwa/src/theme.css"), "utf8");
const dark = css.slice(css.indexOf("@media (prefers-color-scheme: dark)"));
const light = css.slice(0, css.indexOf("@media (prefers-color-scheme: dark)"));
const value = (block: string, token: keyof ThemeColors) => new RegExp(`${cssVar(token)}:\\s*(#[0-9a-f]{6})`, "i").exec(block)?.[1]?.toLowerCase();

describe("the palette", () => {
  it("is the PWA's theme.css, in light and dark", () => {
    for (const token of Object.keys(THEME.light) as (keyof ThemeColors)[]) {
      expect(value(light, token), `light ${token}`).toBe(THEME.light[token]);
      expect(value(dark, token), `dark ${token}`).toBe(THEME.dark[token]);
    }
  });
});
