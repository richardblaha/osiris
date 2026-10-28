import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import { DEFAULT_LOCALE, LOCALES, matchLocale, type Locale } from "@osiris/shared";
import type en_common from "./locales/en/common.json";
import type en_telemetry from "./locales/en/telemetry.json";
import type en_twin from "./locales/en/twin.json";

/**
 * The app's language. English (`locales/en`) is the source; another language falls back to it key by key. Choice:
 * the browser's languages (kept in this browser overrides it), then English.
 */

/** One JSON file per namespace and language: `locales/<lang>/<namespace>.json`. */
const catalogs = import.meta.glob<Record<string, unknown>>("./locales/*/*.json", { eager: true, import: "default" });
const resources: Record<string, Record<string, Record<string, unknown>>> = {};
for (const [path, data] of Object.entries(catalogs)) {
  const [, lang, ns] = /\/locales\/([^/]+)\/([^/]+)\.json$/.exec(path)!;
  (resources[lang!] ??= {})[ns!] = data;
}

const PREFERENCE = "osiris.digital-twin.language";
const preference = (): string | null => {
  try {
    return localStorage.getItem(PREFERENCE);
  } catch {
    return null;
  }
};
const browser = () => (typeof navigator === "undefined" ? [] : navigator.languages);

void i18n.use(initReactI18next).init({
  resources,
  lng: matchLocale([preference(), ...browser()]),
  fallbackLng: DEFAULT_LOCALE,
  supportedLngs: LOCALES,
  ns: Object.keys(resources[DEFAULT_LOCALE] ?? {}),
  defaultNS: "common",
  initAsync: false,
  returnEmptyString: false,
  // React escapes what it renders; texts are never inserted as HTML.
  interpolation: { escapeValue: false },
  saveMissing: import.meta.env.DEV,
  missingKeyHandler: (lngs, ns, key) => console.warn(`i18n: missing "${ns}:${key}" (${lngs.join(", ")})`),
});

const applyToDocument = (lng: string) => {
  if (typeof document === "undefined") return;
  document.documentElement.lang = lng;
  document.documentElement.dir = i18n.dir(lng);
};
applyToDocument(i18n.language);
i18n.on("languageChanged", applyToDocument);

/** Follows the browser's language (`auto`), or the one kept in this browser. */
export function applyLanguageSetting(setting: Locale | "auto") {
  try {
    if (setting === "auto") localStorage.removeItem(PREFERENCE);
    else localStorage.setItem(PREFERENCE, setting);
  } catch {
    // Without storage the setting still applies now; the next start follows the browser again.
  }
  const next = matchLocale([setting === "auto" ? null : setting, ...browser()]);
  if (next !== i18n.language) void i18n.changeLanguage(next);
}

export const currentLocale = () => i18n.language as Locale;

/**
 * The locale to format numbers and dates in: the browser's own tag when it is in the UI's language (keeping its
 * region, e.g. en-GB dates), else the UI language itself.
 */
export function formatLocale(): string {
  const lang = currentLocale();
  return browser().find((tag) => {
    try {
      return new Intl.Locale(tag).language === lang;
    } catch {
      return false;
    }
  }) ?? lang;
}

export const formatDateTime = (value: string | number | Date, options: Intl.DateTimeFormatOptions = { dateStyle: "medium", timeStyle: "short" }) =>
  new Intl.DateTimeFormat(formatLocale(), options).format(new Date(value));
export const formatNumber = (value: number, options?: Intl.NumberFormatOptions) => new Intl.NumberFormat(formatLocale(), options).format(value);

export default i18n;

declare module "i18next" {
  interface CustomTypeOptions {
    defaultNS: "common";
    resources: { common: typeof en_common, telemetry: typeof en_telemetry, twin: typeof en_twin };
  }
}
