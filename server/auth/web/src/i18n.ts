import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import { DEFAULT_LOCALE, LOCALES, matchLocale, type Locale } from "@osiris/shared";
import type en_activity from "./locales/en/activity.json";
import type en_admin from "./locales/en/admin.json";
import type en_common from "./locales/en/common.json";
import type en_security from "./locales/en/security.json";
import type en_signin from "./locales/en/signin.json";

/** The pages' language: the browser's, else English (`locales/en`, the source; others fall back to it key by key). */
const catalogs = import.meta.glob<Record<string, unknown>>("./locales/*/*.json", { eager: true, import: "default" });
const resources: Record<string, Record<string, Record<string, unknown>>> = {};
for (const [path, data] of Object.entries(catalogs)) {
  const [, lang, ns] = /\/locales\/([^/]+)\/([^/]+)\.json$/.exec(path)!;
  (resources[lang!] ??= {})[ns!] = data;
}
const browser = () => (typeof navigator === "undefined" ? [] : navigator.languages);

void i18n.use(initReactI18next).init({
  resources,
  lng: matchLocale([...browser()]),
  fallbackLng: DEFAULT_LOCALE,
  supportedLngs: LOCALES,
  ns: Object.keys(resources[DEFAULT_LOCALE] ?? {}),
  defaultNS: "common",
  initAsync: false,
  returnEmptyString: false,
  interpolation: { escapeValue: false },
});
if (typeof document !== "undefined") document.documentElement.lang = i18n.language;

export const currentLocale = () => i18n.language as Locale;
const formatLocale = () => browser().find((tag) => URL.canParse(`x:${tag}`) && tag.split("-")[0] === currentLocale()) ?? currentLocale();
export const formatDateTime = (value: string | number | Date, options: Intl.DateTimeFormatOptions = { dateStyle: "medium", timeStyle: "short" }) =>
  new Intl.DateTimeFormat(formatLocale(), options).format(new Date(value));
export const formatDate = (value: string | number | Date) => formatDateTime(value, { dateStyle: "medium" });
export const compareText = (a: string, b: string) => a.localeCompare(b, currentLocale());

export default i18n;

declare module "i18next" {
  interface CustomTypeOptions {
    defaultNS: "common";
    resources: { activity: typeof en_activity; admin: typeof en_admin; common: typeof en_common; security: typeof en_security; signin: typeof en_signin };
  }
}
