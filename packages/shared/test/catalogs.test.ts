import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { LOCALES } from "../src/i18n.ts";

/**
 * Checks every message catalog against the English source: the same keys in every language, the plural forms each
 * language needs, the same placeholders and markup, no duplicate keys, and no key the code never uses.
 */

const ROOT = join(import.meta.dirname, "../../..");
const SOURCE = "en";
const PLURAL = /_(zero|one|two|few|many|other)$/;

type Catalog = { name: string; files: (lang: string) => Record<string, string>; languages: string[]; sources: string[]; used: (key: string, code: string) => boolean };
type Messages = Record<string, string>;

/** `{ "a": { "b": "x" } }` → `{ "a.b": "x" }`; every leaf must be a non-empty string. */
function flatten(value: unknown, prefix: string, out: Messages, where: string) {
  if (typeof value === "string") {
    if (!value.trim()) throw new Error(`${where}: "${prefix}" is empty`);
    out[prefix] = value;
    return;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${where}: "${prefix}" is not a string or an object`);
  for (const [k, v] of Object.entries(value)) flatten(v, prefix ? `${prefix}.${k}` : k, out, where);
}

/** Keys that occur twice in one JSON object (JSON.parse keeps the last silently). */
function duplicateKeys(text: string): string[] {
  const found: string[] = [];
  const stack: Set<string>[] = [];
  const token = /"(?:[^"\\]|\\.)*"\s*:|[{}]/g;
  for (const m of text.matchAll(token)) {
    if (m[0] === "{") stack.push(new Set());
    else if (m[0] === "}") stack.pop();
    else {
      const key = JSON.parse(m[0].replace(/\s*:$/, "")) as string;
      const keys = stack.at(-1)!;
      if (keys.has(key)) found.push(key);
      keys.add(key);
    }
  }
  return found;
}

function read(path: string): Messages {
  const text = readFileSync(path, "utf8");
  const dup = duplicateKeys(text);
  if (dup.length) throw new Error(`${path}: duplicate keys ${dup.join(", ")}`);
  const out: Messages = {};
  flatten(JSON.parse(text), "", out, path);
  return out;
}

const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (name === "node_modules" || name === "locales" || name === "dist") return [];
    return statSync(path).isDirectory() ? walk(path) : /\.(ts|tsx)$/.test(name) ? [path] : [];
  });

/** The categories a language uses for whole numbers (what a count can be). */
const integerCategories = (lang: string) => new Set(Array.from({ length: 1001 }, (_, n) => new Intl.PluralRules(lang).select(n)));
const allCategories = (lang: string) => new Set(new Intl.PluralRules(lang).resolvedOptions().pluralCategories);
const placeholders = (text: string) => new Set([...text.matchAll(/\{\{\s*([\w.]+)\s*(?:,[^}]*)?\}\}/g)].map((m) => m[1]!));
/** Markup for <Trans> components: tags that are closed (a lone "<slug>" is literal text). */
const tags = (text: string) => new Set([...text.matchAll(/<\/([a-zA-Z]\w*)>/g)].map((m) => m[1]!));
const same = (a: Set<string>, b: Set<string>) => a.size === b.size && [...a].every((x) => b.has(x));
const union = (sets: Set<string>[]) => new Set(sets.flatMap((s) => [...s]));

/** Messages grouped by key, plural forms under their base key. */
function groups(messages: Messages): Map<string, { plural: boolean; forms: Map<string, string> }> {
  const out = new Map<string, { plural: boolean; forms: Map<string, string> }>();
  for (const [key, text] of Object.entries(messages)) {
    const m = PLURAL.exec(key);
    const base = m ? key.slice(0, -m[0].length) : key;
    const g = out.get(base) ?? out.set(base, { plural: !!m, forms: new Map() }).get(base)!;
    g.forms.set(m ? m[1]! : "", text);
  }
  return out;
}

/** Literal strings and template-literal prefixes in the code, which is how keys are referenced. */
function references(sources: string[]) {
  const literals = new Set<string>();
  const prefixes: string[] = [];
  const files = new Map<string, string>();
  for (const dir of sources) {
    for (const file of walk(join(ROOT, dir))) {
      const code = readFileSync(file, "utf8");
      files.set(file, code);
      for (const m of code.matchAll(/["']([\w:.-]+)["']/g)) literals.add(m[1]!);
      for (const m of code.matchAll(/`([\w:.-]+)\$\{/g)) prefixes.push(m[1]!);
    }
  }
  return { literals, prefixes, files };
}

function serverCatalog(): Catalog {
  const dir = join(ROOT, "packages/platform/src/locales");
  const languages = readdirSync(dir).map((f) => f.replace(/\.json$/, ""));
  const sources = ["apps/control/src", "apps/gateway/src", "apps/runtime/src", "packages/core/src", "packages/platform/src"];
  const refs = references(sources);
  return {
    name: "services (packages/platform/src/locales)",
    languages,
    sources,
    files: (lang) => read(join(dir, `${lang}.json`)),
    used: (key) => refs.literals.has(key) || refs.prefixes.some((p) => key.startsWith(p)),
  };
}

function webCatalog(): Catalog {
  const dir = join(ROOT, "apps/web/src/locales");
  const languages = readdirSync(dir);
  const refs = references(["apps/web/src"]);
  // <Trans ns="x" i18nKey="y">: the key alone, with its namespace beside it.
  const trans = new Set([...refs.files.values()].flatMap((code) => [...code.matchAll(/ns="(\w+)"\s+i18nKey=(?:"([\w.]+)"|\{[^}]*?"([\w.]+)"\s*:\s*"([\w.]+)"\})/g)].flatMap((m) => [m[2], m[3], m[4]].filter(Boolean).map((k) => `${m[1]}:${k}`))));
  return {
    name: "web app (apps/web/src/locales)",
    languages,
    sources: ["apps/web/src"],
    files: (lang) => {
      const out: Messages = {};
      for (const file of readdirSync(join(dir, lang))) {
        for (const [k, v] of Object.entries(read(join(dir, lang, file)))) out[`${file.replace(/\.json$/, "")}:${k}`] = v;
      }
      return out;
    },
    used: (key) => {
      const [ns, k] = key.split(":") as [string, string];
      return refs.literals.has(key) || trans.has(key) || (ns === "common" && refs.literals.has(k)) || refs.prefixes.some((p) => key.startsWith(p) || (ns === "common" && k.startsWith(p)));
    },
  };
}

describe.each([serverCatalog(), webCatalog()])("$name", (catalog) => {
  const source = groups(catalog.files(SOURCE));

  it("has a catalog for every supported language, named by its BCP 47 tag", () => {
    expect([...catalog.languages].sort()).toEqual([...LOCALES].sort());
    for (const lang of catalog.languages) expect(Intl.getCanonicalLocales(lang)[0]).toBe(lang);
  });

  it.each([...LOCALES])("%s has every message, with the plural forms the language needs", (lang) => {
    const messages = groups(catalog.files(lang));
    const problems: string[] = [];
    const needed = integerCategories(lang);
    const allowed = allCategories(lang);
    for (const [key, g] of source) {
      const own = messages.get(key);
      if (!own) {
        problems.push(`${key}: missing`);
        continue;
      }
      if (g.plural !== own.plural) problems.push(`${key}: plural in one language only`);
      if (own.plural) {
        for (const c of needed) if (!own.forms.has(c)) problems.push(`${key}: no "${c}" form`);
        for (const c of own.forms.keys()) if (!allowed.has(c as Intl.LDMLPluralRule)) problems.push(`${key}: "${c}" is not a ${lang} plural form`);
      }
      const want = union([...g.forms.values()].map(placeholders));
      const have = union([...own.forms.values()].map(placeholders));
      if (!same(want, have)) problems.push(`${key}: placeholders {${[...have]}} instead of {${[...want]}}`);
      const wantTags = union([...g.forms.values()].map(tags));
      const haveTags = union([...own.forms.values()].map(tags));
      if (!same(wantTags, haveTags)) problems.push(`${key}: markup <${[...haveTags]}> instead of <${[...wantTags]}>`);
    }
    for (const key of messages.keys()) if (!source.has(key)) problems.push(`${key}: not in the English catalog`);
    expect(problems).toEqual([]);
  });

  it("has no message the code doesn't use", () => {
    const unused = [...source.keys()].filter((key) => !catalog.used(key, ""));
    expect(unused, `unused in ${catalog.sources.map((s) => relative(ROOT, join(ROOT, s))).join(", ")}`).toEqual([]);
  });
});
