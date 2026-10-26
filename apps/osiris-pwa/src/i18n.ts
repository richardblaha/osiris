import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import { DEFAULT_LOCALE, LOCALES, matchLocale, type Locale, type UserSettings } from "@osiris/shared";
import type en_activity from "./locales/en/activity.json";
import type en_analytics from "./locales/en/analytics.json";
import type en_app from "./locales/en/app.json";
import type en_assistant from "./locales/en/assistant.json";
import type en_chat from "./locales/en/chat.json";
import type en_common from "./locales/en/common.json";
import type en_dashboards from "./locales/en/dashboards.json";
import type en_database from "./locales/en/database.json";
import type en_files from "./locales/en/files.json";
import type en_guards from "./locales/en/guards.json";
import type en_integrations from "./locales/en/integrations.json";
import type en_invite from "./locales/en/invite.json";
import type en_knowledge from "./locales/en/knowledge.json";
import type en_mcp from "./locales/en/mcp.json";
import type en_memory from "./locales/en/memory.json";
import type en_profile from "./locales/en/profile.json";
import type en_public from "./locales/en/public.json";
import type en_quotas from "./locales/en/quotas.json";
import type en_schedules from "./locales/en/schedules.json";
import type en_secrets from "./locales/en/secrets.json";
import type en_settings from "./locales/en/settings.json";
import type en_sites from "./locales/en/sites.json";
import type en_skills from "./locales/en/skills.json";
import type en_telemetry from "./locales/en/telemetry.json";
import type en_projectInfo from "./locales/en/projectInfo.json";
import type en_projects from "./locales/en/projects.json";
import type en_tools from "./locales/en/tools.json";
import type en_users from "./locales/en/users.json";

/**
 * The web app's language. English (`locales/en`) is the source; another language falls back to it key by key.
 * Choice: the user's language setting (kept in this browser, so the sign-in screen and the next start use it), then
 * the browser's languages, then English.
 */

/** One JSON file per namespace and language: `locales/<lang>/<namespace>.json`. */
const catalogs = import.meta.glob<Record<string, unknown>>("./locales/*/*.json", { eager: true, import: "default" });
const resources: Record<string, Record<string, Record<string, unknown>>> = {};
for (const [path, data] of Object.entries(catalogs)) {
  const [, lang, ns] = /\/locales\/([^/]+)\/([^/]+)\.json$/.exec(path)!;
  (resources[lang!] ??= {})[ns!] = data;
}

const PREFERENCE = "osiris.language";
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

/** Follows the user's language setting; `auto` goes back to the browser's languages. */
export function applyLanguageSetting(setting: UserSettings["language"]) {
  try {
    if (setting === "auto") localStorage.removeItem(PREFERENCE);
    else localStorage.setItem(PREFERENCE, setting);
  } catch {
    // Without storage the setting still applies now; the next start follows the browser until settings load.
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
export const formatDate = (value: string | number | Date) => formatDateTime(value, { dateStyle: "medium" });
export const formatNumber = (value: number, options?: Intl.NumberFormatOptions) => new Intl.NumberFormat(formatLocale(), options).format(value);
export const formatList = (items: string[], type: Intl.ListFormatType = "conjunction") => new Intl.ListFormat(currentLocale(), { type }).format(items);
/** The first character a reader sees (a grapheme, so "Ž" written as Z plus a caron stays whole), upper-cased. */
export const initial = (text: string) => ([...new Intl.Segmenter(currentLocale()).segment(text.trim())][0]?.segment ?? "?").toLocaleUpperCase(currentLocale());
/** Human-readable names in the reader's order. */
export const compareText = (a: string, b: string) => a.localeCompare(b, currentLocale());

export default i18n;

declare module "i18next" {
  interface CustomTypeOptions {
    defaultNS: "common";
    resources: { activity: typeof en_activity, analytics: typeof en_analytics, app: typeof en_app, assistant: typeof en_assistant, chat: typeof en_chat, common: typeof en_common, dashboards: typeof en_dashboards, database: typeof en_database, files: typeof en_files, guards: typeof en_guards, integrations: typeof en_integrations, invite: typeof en_invite, knowledge: typeof en_knowledge, mcp: typeof en_mcp, memory: typeof en_memory, profile: typeof en_profile, public: typeof en_public, quotas: typeof en_quotas, schedules: typeof en_schedules, secrets: typeof en_secrets, settings: typeof en_settings, sites: typeof en_sites, skills: typeof en_skills, telemetry: typeof en_telemetry, projectInfo: typeof en_projectInfo, projects: typeof en_projects, tools: typeof en_tools, users: typeof en_users };
  }
}
