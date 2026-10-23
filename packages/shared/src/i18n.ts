/**
 * Locale handling shared by the web app and the services. English is the canonical source language: every catalog
 * key exists in `en`, and anything missing in another language falls back to it.
 */

/** Languages with a complete catalog, as BCP 47 language subtags. */
export const LOCALES = ["en", "cs"] as const;
export type Locale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: Locale = "en";

/** Languages without a catalog of their own that read a related one better than English (Slovak readers get Czech). */
const RELATED: Readonly<Record<string, Locale>> = { sk: "cs" };

export const isLocale = (value: unknown): value is Locale => (LOCALES as readonly unknown[]).includes(value);

/**
 * The first supported locale among BCP 47 tags in order of preference (`cs-CZ` → `cs`, `sk` → `cs`); `fallback`
 * when none matches. Invalid tags are skipped.
 */
export function matchLocale(tags: Iterable<string | null | undefined>, fallback: Locale = DEFAULT_LOCALE): Locale {
  for (const tag of tags) {
    if (!tag || tag === "*") continue;
    let language: string;
    try {
      language = new Intl.Locale(tag).language;
    } catch {
      continue;
    }
    if (isLocale(language)) return language;
    const related = RELATED[language];
    if (related) return related;
  }
  return fallback;
}

/** An `Accept-Language` header's tags, most preferred first (RFC 9110 quality values; `q=0` means "not this one"). */
export function parseAcceptLanguage(header: string | null | undefined): string[] {
  if (!header) return [];
  return header
    .split(",")
    .map((part, index) => {
      const [tag = "", ...params] = part.trim().split(";");
      const q = params.map((p) => p.trim()).find((p) => p.startsWith("q="));
      const quality = q ? Number(q.slice(2)) : 1;
      return { tag: tag.trim(), quality: Number.isFinite(quality) ? quality : 0, index };
    })
    .filter((e) => e.tag && e.quality > 0)
    .sort((a, b) => b.quality - a.quality || a.index - b.index)
    .map((e) => e.tag);
}

/** A translatable message: a catalog key and its named parameters, rendered in the reader's locale. */
export interface Message {
  key: string;
  params?: Record<string, string | number>;
}
