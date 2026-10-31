// Writes the clients' theme from osiris-theme's tokens: `node scripts/theme.ts` from the copy in theme/, or
// `node scripts/theme.ts v0.5.0` to fetch that release's assets/tokens.json first.
import { readFileSync, writeFileSync } from "node:fs";
import { THEME_CSS_FILES, tokensCss, tokensTs, withTokens, type Tokens } from "../src/theme-gen.ts";

const root = new URL("../../../", import.meta.url);
const here = (rel: string) => new URL(rel, root);
const tag = process.argv[2];

if (tag) {
  if (!/^v\d+\.\d+\.\d+$/.test(tag)) throw new Error(`${tag} is not a release tag like v0.4.0`);
  const res = await fetch(`https://raw.githubusercontent.com/richardblaha/osiris-theme/${tag}/assets/tokens.json`);
  if (!res.ok) throw new Error(`osiris-theme ${tag}: ${res.status}`);
  const text = await res.text();
  JSON.parse(text);
  writeFileSync(here("packages/shared/theme/tokens.json"), text);
  writeFileSync(here("packages/shared/theme/RELEASE"), `${tag}\n`);
}

const release = readFileSync(here("packages/shared/theme/RELEASE"), "utf8").trim();
const tokens = JSON.parse(readFileSync(here("packages/shared/theme/tokens.json"), "utf8")) as Tokens;
writeFileSync(here("packages/shared/src/theme-tokens.ts"), tokensTs(tokens, release));
const block = tokensCss(tokens, release);
for (const file of THEME_CSS_FILES) writeFileSync(here(file), withTokens(readFileSync(here(file), "utf8"), block));
console.log(`osiris-theme ${release}: src/theme-tokens.ts, ${THEME_CSS_FILES.join(", ")}`);
