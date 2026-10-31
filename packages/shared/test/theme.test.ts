import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BEGIN, END, THEME_CSS_FILES, tokensCss, tokensTs, tokenVariables, type Tokens } from "../src/theme-gen.ts";
import { cssVar, THEME, type ThemeColors } from "../src/theme.ts";

const read = (rel: string) => readFileSync(join(import.meta.dirname, "../../../", rel), "utf8");
const release = read("packages/shared/theme/RELEASE").trim();
const tokens = JSON.parse(read("packages/shared/theme/tokens.json")) as Tokens;
const block = tokensCss(tokens, release);
const fix = "run `pnpm --filter @osiris/shared theme`";

describe("the osiris-theme tokens", () => {
  it("are a release's", () => {
    expect(release).toMatch(/^v\d+\.\d+\.\d+$/);
  });

  it("are theme-tokens.ts as generated", () => {
    expect(read("packages/shared/src/theme-tokens.ts"), fix).toBe(tokensTs(tokens, release));
  });

  for (const file of THEME_CSS_FILES) {
    it(`are ${file}'s block as generated, and the app sets none of them again`, () => {
      const css = read(file);
      const from = css.indexOf(BEGIN);
      const to = css.indexOf(END);
      expect(from, `${file} has the markers`).toBeGreaterThanOrEqual(0);
      expect(css.slice(from, to + END.length), fix).toBe(block);
      const rest = css.slice(0, from) + css.slice(to + END.length);
      for (const v of tokenVariables(block)) expect(rest, `${file} sets ${v} outside the block`).not.toMatch(new RegExp(`${v}\\s*:`));
    });
  }

  it("give THEME the block's colours", () => {
    const at = block.indexOf("@media (prefers-color-scheme: dark)");
    const blocks = { light: block.slice(0, at), dark: block.slice(at) };
    for (const scheme of ["light", "dark"] as const)
      for (const token of Object.keys(THEME[scheme]) as (keyof ThemeColors)[])
        expect(new RegExp(`${cssVar(token)}:\\s*(#[0-9a-f]{6})`, "i").exec(blocks[scheme])?.[1], `${scheme} ${token}`).toBe(THEME[scheme][token]);
  });

  it("keep the status bar in the background colour, never in the accent (VS Code 2026)", () => {
    for (const scheme of ["light", "dark"] as const) {
      expect(THEME[scheme].bgStatusbar).toBe(THEME[scheme].bgSidebar);
      expect(THEME[scheme].bgStatusbarText).toBe(THEME[scheme].textPrimary);
    }
  });
});
