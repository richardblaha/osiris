import { LocalizedError } from "@osiris/platform/i18n.ts";
/** `{{secret:NAME}}` placeholders, usable in MCP server URLs and headers and in http_request arguments. */
export const SECRET_REF = /\{\{\s*secret:([A-Z][A-Z0-9_]{0,63})\s*\}\}/g;
export const SECRET_NAME = /^[A-Z][A-Z0-9_]{0,63}$/;

export class SecretUseError extends LocalizedError {}

/**
 * The host a templated URL points to. Placeholders must not decide the host (or the scheme),
 * otherwise a secret could pick where it is sent.
 */
export function templateHost(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url.replace(SECRET_REF, "SECRETREF"));
  } catch {
    throw new SecretUseError("errors.url.invalid");
  }
  if (/secretref/i.test(parsed.protocol + parsed.host)) throw new SecretUseError("errors.secret.inHost");
  return parsed.hostname.toLowerCase();
}

/** `example.com` matches exactly; `*.example.com` matches any subdomain (not the apex). */
export function hostAllowed(host: string, allowed: readonly string[]): boolean {
  host = host.toLowerCase();
  return allowed.some((a) => (a.startsWith("*.") ? host.endsWith(a.slice(1)) : host === a));
}

export const HOST_PATTERN = /^(\*\.)?([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,62}$|^localhost$/;

/** Replaces every occurrence of the given secret values, so tool output never shows them. */
export function redact(text: string, values: Iterable<string>): string {
  let out = text;
  for (const v of values) if (v.length >= 4) out = out.split(v).join("[skryto]");
  return out;
}
