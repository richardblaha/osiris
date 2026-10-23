import i18next from "i18next";
import { z } from "zod";
import { DEFAULT_LOCALE, matchLocale, parseAcceptLanguage, type Locale } from "@osiris/shared";
import cs from "./locales/cs.json" with { type: "json" };
import en from "./locales/en.json" with { type: "json" };

/**
 * The services' messages for people: API errors, WhatsApp replies, e-mails, sign-in pages. One i18next instance per
 * process, read only through `getFixedT`, so concurrent requests in different languages never share locale state.
 */
const i18n = i18next.createInstance();
void i18n.init({
  resources: { en: { translation: en }, cs: { translation: cs } },
  lng: DEFAULT_LOCALE,
  fallbackLng: DEFAULT_LOCALE,
  initAsync: false,
  returnEmptyString: false,
  // Messages go into JSON, plain text and WhatsApp; HTML callers escape what they insert.
  interpolation: { escapeValue: false },
  saveMissing: process.env.NODE_ENV !== "production",
  missingKeyHandler: (lngs, _ns, key) => console.warn(`i18n: missing message "${key}" (${lngs.join(", ")})`),
});

/** Named message parameters; a `LocalizedError` (a wrapped cause) is rendered in the same language. */
export type Params = Record<string, string | number | LocalizedError>;

/** The locale for messages nobody asked for in a language (WhatsApp, scheduled results, notifications): `DEFAULT_LOCALE`, else English. */
export const configuredLocale = (): Locale => matchLocale([process.env.DEFAULT_LOCALE]);

/** The locale of a request from its `Accept-Language` header, else the configured one. */
export const requestLocale = (acceptLanguage: string | null | undefined): Locale =>
  matchLocale(parseAcceptLanguage(acceptLanguage), configuredLocale());

export const translate = (locale: Locale, key: string, params?: Params): string =>
  i18n.getFixedT(locale)(key, params && Object.fromEntries(Object.entries(params).map(([k, v]) => [k, v instanceof LocalizedError ? v.in(locale) : v])));

/** An error's message for a `detail` parameter: rendered in the reader's language when it is a `LocalizedError`. */
export const detail = (err: unknown): string | LocalizedError => (err instanceof LocalizedError ? err : err instanceof Error ? err.message : String(err));

/**
 * An error whose message is a catalog entry. `message` is the English text (logs, the agent's tool results), and the
 * HTTP layer renders `key` in the caller's language and returns it as the stable `code`.
 */
export class LocalizedError extends Error {
  constructor(
    readonly key: string,
    readonly params?: Params,
  ) {
    super(translate(DEFAULT_LOCALE, key, params));
  }

  /** The message in `locale`. */
  in(locale: Locale): string {
    return translate(locale, this.key, this.params);
  }
}

/** A `LocalizedError` answered with an HTTP status. */
export class HttpError extends LocalizedError {
  constructor(
    readonly status: 400 | 401 | 403 | 404 | 409 | 413 | 415 | 422 | 429 | 500 | 502 | 503 | 507,
    key: string,
    params?: Params,
  ) {
    super(key, params);
  }

  /** Hono's default error handler answers with this (in English) where no `onError` renders the error in the caller's language. */
  getResponse(): Response {
    return Response.json({ error: this.message, code: this.key }, { status: this.status });
  }
}

/** The `LocalizedError` an error is or was caused by. */
export function localizedCause(err: unknown): LocalizedError | undefined {
  for (let e = err, depth = 0; e instanceof Error && depth < 5; e = e.cause, depth++) {
    if (e instanceof LocalizedError) return e;
  }
  return undefined;
}

/** The JSON body of an error answer: the message in `locale`, plus the catalog key as `code` when there is one. */
export function errorBody(err: Error, locale: Locale): { error: string; code?: string } {
  const localized = localizedCause(err);
  return localized ? { error: localized.in(locale), code: localized.key } : { error: err.message };
}

/** The answer to an error that may carry a status (`HttpError`) or a catalog message (any other `LocalizedError`: 400). */
export function errorResponse(err: Error, locale: Locale): { status: HttpError["status"]; body: { error: string; code?: string } } | null {
  const localized = localizedCause(err);
  if (!localized) return null;
  return { status: localized instanceof HttpError ? localized.status : 400, body: errorBody(localized, locale) };
}

const ZOD_LOCALES = { en: z.locales.en, cs: z.locales.cs } satisfies Record<Locale, unknown>;
const isCatalogKey = (message: string) => /^errors\.[\w.]+$/.test(message) && i18n.exists(message);

/**
 * A request that failed a zod schema (400). A schema's own messages are catalog keys (`errors.validation.*`); the
 * rest are zod's built-in messages in the reader's language. Parse with `reportInput: true`, so "expected X, got Y"
 * can name what arrived; the input is only read here and never sent back.
 */
export class ValidationError extends HttpError {
  constructor(readonly error: z.ZodError) {
    super(400, "errors.validation.invalid");
    this.message = this.in(DEFAULT_LOCALE);
  }

  override in(locale: Locale): string {
    const map = ZOD_LOCALES[locale]().localeError;
    const issues = this.error.issues.map((issue) => {
      const message = isCatalogKey(issue.message) ? translate(locale, issue.message) : (map(issue as never) as string | { message: string } | undefined);
      return { ...issue, input: undefined, message: (typeof message === "string" ? message : message?.message) ?? issue.message };
    });
    return z.prettifyError({ issues } as unknown as z.ZodError);
  }
}
