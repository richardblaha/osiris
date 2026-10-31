import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { cssVar, THEME, type ThemeColors } from "../src/theme.ts";

const read = (rel: string) => readFileSync(join(import.meta.dirname, "../../../", rel), "utf8");
const split = (css: string) => {
  const at = css.indexOf("@media (prefers-color-scheme: dark)");
  return { light: css.slice(0, at), dark: css.slice(at) };
};
const value = (block: string, token: keyof ThemeColors) =>
  new RegExp(`${cssVar(token)}:\\s*(#[0-9a-f]{6})`, "i").exec(block)?.[1]?.toLowerCase();

const pwa = split(read("apps/osiris-pwa/src/theme.css"));
const twin = split(read("server/digital-twin/web/src/theme.css"));

// Tokens the two web apps must share verbatim. The digital twin deliberately darkens the light-scheme accents
// (#00838f / #c2007a) so its cyan/magenta read on white, so accents and state colours are only pinned for the PWA.
const SHARED: (keyof ThemeColors)[] = (Object.keys(THEME.light) as (keyof ThemeColors)[]).filter(
  (t) => !t.startsWith("accent") && !t.startsWith("state"),
);

describe("the palette", () => {
  it("is the PWA's theme.css, in light and dark", () => {
    for (const token of Object.keys(THEME.light) as (keyof ThemeColors)[]) {
      expect(value(pwa.light, token), `pwa light ${token}`).toBe(THEME.light[token]);
      expect(value(pwa.dark, token), `pwa dark ${token}`).toBe(THEME.dark[token]);
    }
  });

  it("is the digital twin's theme.css for the shared surface/text tokens, in light and dark", () => {
    for (const token of SHARED) {
      expect(value(twin.light, token), `twin light ${token}`).toBe(THEME.light[token]);
      expect(value(twin.dark, token), `twin dark ${token}`).toBe(THEME.dark[token]);
    }
  });

  it("keeps the status bar in the background colour, never in the accent (VS Code 2026)", () => {
    for (const [name, blocks] of [["pwa", pwa], ["twin", twin]] as const) {
      for (const scheme of ["light", "dark"] as const) {
        const v = value(blocks[scheme], "bgStatusbar")!;
        expect(v, `${name} ${scheme} statusbar`).toBe(THEME[scheme].bgSidebar);
        expect(value(blocks[scheme], "bgStatusbarText"), `${name} ${scheme} statusbar text`).toBe(
          THEME[scheme].textPrimary,
        );
      }
    }
  });
});
