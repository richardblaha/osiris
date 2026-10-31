import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { UnsafeUrlError } from "@osiris/core/mcp/url.ts";
import { SecretUseError } from "@osiris/core/vault/template.ts";
import { fetchWithSecrets } from "@osiris/core/vault/fetch.ts";
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
      try {
        const res = await fetchWithSecrets(vault, { method, url, headers, body }, { userId: user_id, allowPrivate, fetch: f, timeoutMs: TIMEOUT_MS, maxChars: MAX_RESPONSE_CHARS });
        const location = res.headers.location;
        const head = [`HTTP ${res.status}`, res.headers["content-type"], location && `Location: ${location}`].filter(Boolean).join("\n");
        return `${head}\n\n${res.text}${res.truncated ? "\n… (zkráceno)" : ""}`;
      } catch (err) {
        if (err instanceof SecretUseError || err instanceof UnsafeUrlError) return `Požadavek zamítnut: ${err.message}`;
        return `Požadavek selhal: ${err instanceof Error ? err.message : String(err)}`;
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
