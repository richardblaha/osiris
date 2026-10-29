import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { assertSafePublicUrl, UnsafeUrlError } from "@osiris/core/mcp/url.ts";
import { redact, SecretUseError, templateHost } from "@osiris/core/vault/template.ts";
import type { SecretVault } from "@osiris/core/vault/vault.ts";
import { getRunContext } from "@osiris/core/agent/context.ts";

const TIMEOUT_MS = 20_000;
const MAX_RESPONSE_CHARS = 20_000;

export interface HttpToolOptions {
  /** Development only: allow http and private addresses. */
  allowPrivate?: boolean;
  fetch?: typeof fetch;
}

/**
 * Generic HTTPS request for skills that call a web API. `{{secret:NAME}}` in the URL, headers or body is
 * filled on the server: the model never sees the value, a secret is only sent to its allowed hosts,
 * redirects are not followed (so tokens can't be bounced elsewhere), and secret values are masked in the output.
 */
export function httpRequestTool(vault: SecretVault, { allowPrivate = false, fetch: f = fetch }: HttpToolOptions = {}) {
  return tool(
    async ({ method, url, headers = {}, body }, config) => {
      const { user_id } = getRunContext(config);
      let used: string[] = [];
      try {
        const host = templateHost(url);
        const texts: Record<string, string> = { url, body: body ?? "" };
        for (const [k, v] of Object.entries(headers)) texts[`h:${k}`] = v;
        const result = await vault.fill(texts, { userId: user_id, host });
        used = result.used;
        const target = await assertSafePublicUrl(result.filled.url!, { allowPrivate });

        const res = await f(target, {
          method,
          headers: Object.fromEntries(Object.keys(headers).map((k) => [k, result.filled[`h:${k}`]!])),
          body: body === undefined || method === "GET" ? undefined : result.filled.body,
          redirect: "manual",
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        let text = await res.text();
        if (text.length > MAX_RESPONSE_CHARS) text = `${text.slice(0, MAX_RESPONSE_CHARS)}\n… (zkráceno)`;
        const location = res.headers.get("location");
        const head = [`HTTP ${res.status}`, res.headers.get("content-type"), location && `Location: ${location}`]
          .filter(Boolean)
          .join("\n");
        return redact(`${head}\n\n${text}`, used);
      } catch (err) {
        if (err instanceof SecretUseError || err instanceof UnsafeUrlError) return `Požadavek zamítnut: ${err.message}`;
        return redact(`Požadavek selhal: ${err instanceof Error ? err.message : String(err)}`, used);
      }
    },
    {
      name: "http_request",
      description:
        "Zavolá webové API přes https (typicky podle postupu z dovednosti). Přístupové klíče vkládej jako {{secret:NÁZEV}} " +
        "(seznam v sekci SECRETS), nikdy je nepiš přímo. Přesměrování se nesleduje. Požadavky, které něco mění, dělej jen na pokyn uživatele.",
      schema: z.object({
        method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]).default("GET"),
        url: z.string().describe("Úplná https URL"),
        headers: z.record(z.string(), z.string()).optional().describe("Např. {\"Authorization\": \"Bearer {{secret:CRM_TOKEN}}\"}"),
        body: z.string().optional().describe("Tělo požadavku, typicky JSON"),
      }),
    },
  );
}
