import { afterEach, describe, expect, it, vi } from "vitest";
import type * as I18n from "../src/i18n.ts";

/** The module as a browser with these languages (and no saved choice) would load it; independent of the host's locale. */
async function load(languages: string[]): Promise<typeof I18n> {
  vi.resetModules();
  vi.stubGlobal("navigator", { languages, language: languages[0] });
  vi.stubGlobal("localStorage", undefined);
  return import("../src/i18n.ts");
}

afterEach(() => vi.unstubAllGlobals());

describe("web app language", () => {
  it("starts in the browser's language when it has a catalog, otherwise in English", async () => {
    expect((await load(["cs-CZ", "en"])).currentLocale()).toBe("cs");
    expect((await load(["sk"])).currentLocale()).toBe("cs");
    expect((await load(["de-DE", "fr"])).currentLocale()).toBe("en");
  });

  it("follows the user's language setting, and the browser again on auto", async () => {
    const { default: i18n, applyLanguageSetting, currentLocale } = await load(["de-DE"]);
    applyLanguageSetting("cs");
    expect(currentLocale()).toBe("cs");
    expect(i18n.t("save")).toBe("Uložit");
    applyLanguageSetting("sk");
    expect(currentLocale()).toBe("cs");
    applyLanguageSetting("auto");
    expect(currentLocale()).toBe("en");
    expect(i18n.t("save")).toBe("Save");
  });

  it("uses each language's plural forms and named parameters", async () => {
    const { default: i18n, applyLanguageSetting } = await load(["en"]);
    expect(i18n.t("files:overwriteMany", { count: 1 })).toBe("1 file already exists. Overwrite it?");
    expect(i18n.t("files:overwriteMany", { count: 3 })).toBe("3 files already exist. Overwrite them?");
    applyLanguageSetting("cs");
    expect(i18n.t("files:overwriteMany", { count: 3 })).toBe("3 soubory už existují. Přepsat je?");
    expect(i18n.t("files:overwriteMany", { count: 7 })).toBe("7 souborů už existuje. Přepsat je?");
    expect(i18n.t("knowledge:confirmDelete", { title: "<b>x</b>" })).toBe("Smazat dokument <b>x</b>?");
  });

  it("falls back to English for a message another language lacks, and to the key for an unknown one", async () => {
    const { default: i18n, applyLanguageSetting } = await load(["cs"]);
    i18n.addResource("en", "common", "onlyInEnglish", "Only in English");
    applyLanguageSetting("cs");
    expect(i18n.t("common:onlyInEnglish" as never)).toBe("Only in English");
    expect(i18n.t("common:noSuchKey" as never)).toBe("noSuchKey");
  });

  it("formats numbers, sizes and dates for the reader, in the browser's region when it speaks the UI language", async () => {
    const m = await load(["en-GB"]);
    const date = Date.UTC(2026, 9, 22, 14, 5);
    expect(m.formatNumber(1234.5)).toBe("1,234.5");
    expect(m.formatDateTime(date, { dateStyle: "short", timeZone: "UTC" })).toBe("22/10/2026");
    m.applyLanguageSetting("cs");
    expect(m.formatLocale()).toBe("cs");
    // Czech groups digits with a no-break space.
    expect(m.formatNumber(1234.5)).toBe("1\u00a0234,5");
    expect(m.formatDateTime(date, { dateStyle: "short", timeZone: "UTC" })).toBe("22.10.26");
    // No one-letter conjunction at a line end: a no-break space after "a".
    expect(m.formatList(["a", "b", "c"])).toBe("a, b a\u00a0c");
  });

  it("takes initials by grapheme and sorts names the reader's way", async () => {
    const m = await load(["cs"]);
    expect(m.initial("Žaneta")).toBe("Ž");
    expect(m.initial("žaneta")).toBe("Ž");
    expect(m.initial("👩‍🔧 Jana")).toBe("👩‍🔧");
    // Czech sorts "ch" after "h".
    expect(["Chata", "Hora", "Cibule"].sort(m.compareText)).toEqual(["Cibule", "Hora", "Chata"]);
  });
});
