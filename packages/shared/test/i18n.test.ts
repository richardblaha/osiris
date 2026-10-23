import { describe, expect, it } from "vitest";
import { DEFAULT_LOCALE, isLocale, matchLocale, parseAcceptLanguage } from "../src/i18n.ts";

describe("locale matching", () => {
  it("takes the first supported language of BCP 47 tags, ignoring the region", () => {
    expect(matchLocale(["cs-CZ"])).toBe("cs");
    expect(matchLocale(["de-AT", "en-GB", "cs"])).toBe("en");
    expect(matchLocale(["EN-us"])).toBe("en");
  });

  it("gives Slovak readers Czech, and falls back to English or the given default", () => {
    expect(matchLocale(["sk-SK"])).toBe("cs");
    expect(matchLocale(["de", "fr"])).toBe(DEFAULT_LOCALE);
    expect(matchLocale([], "cs")).toBe("cs");
    expect(matchLocale(["*"], "cs")).toBe("cs");
  });

  it("skips invalid tags and empty values", () => {
    expect(matchLocale(["not a tag!", null, undefined, "", "cs"])).toBe("cs");
  });

  it("knows its locales", () => {
    expect(isLocale("en")).toBe(true);
    expect(isLocale("cs-CZ")).toBe(false);
    expect(isLocale(undefined)).toBe(false);
  });
});

describe("Accept-Language", () => {
  it("orders by quality, keeping the header's order on ties, and drops q=0", () => {
    expect(parseAcceptLanguage("da, en-GB;q=0.8, en;q=0.7, cs;q=0.8, de;q=0")).toEqual(["da", "en-GB", "cs", "en"]);
  });

  it("reads missing or malformed headers as no preference", () => {
    expect(parseAcceptLanguage(undefined)).toEqual([]);
    expect(parseAcceptLanguage("")).toEqual([]);
    expect(parseAcceptLanguage("cs;q=abc, en")).toEqual(["en"]);
  });

  it("feeds matchLocale", () => {
    expect(matchLocale(parseAcceptLanguage("fr-CH, fr;q=0.9, sk;q=0.8, en;q=0.7"))).toBe("cs");
  });
});
