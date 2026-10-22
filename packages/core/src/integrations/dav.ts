import { randomUUID } from "node:crypto";
import { tool, type StructuredToolInterface } from "@langchain/core/tools";
import { createDAVClient } from "tsdav";
import { z } from "zod";
import { getRunContext } from "../agent/context.ts";
import { assertSafePublicUrl } from "../mcp/url.ts";
import type { StandardAccounts } from "./standard.ts";

/** Validate every discovery and object request, and never forward credentials across origins or redirects. */
export function davFetch(serverUrl: string, allowPrivate = false, fetchFn: typeof fetch = fetch): typeof fetch {
  return async (input, init) => {
    const raw = input instanceof Request ? input.url : String(input);
    const url = await assertSafePublicUrl(raw, { allowPrivate });
    if (url.origin !== new URL(serverUrl).origin) throw new Error("DAV server odkazuje na jiný origin; nastav přímo cílovou URL");
    const response = await fetchFn(input, { ...init, redirect: "error", signal: AbortSignal.timeout(30_000) });
    if (Number(response.headers.get("content-length")) > 10 * 1024 * 1024) {
      await response.body?.cancel();
      throw new Error("DAV odpověď přesahuje 10 MB");
    }
    if (!response.body) return response;
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.length;
        if (bytes > 10 * 1024 * 1024) throw new Error("DAV odpověď přesahuje 10 MB");
        chunks.push(value);
      }
    } finally { await reader.cancel(); }
    return new Response(Buffer.concat(chunks), { status: response.status, statusText: response.statusText, headers: response.headers });
  };
}

export function davTools(accounts: StandardAccounts, allowPrivate = false, createClient = createDAVClient): StructuredToolInterface[] {
  return (["caldav", "carddav"] as const).flatMap(kind => {
    const client = async (owner: string, name: string) => {
      const a = await accounts.get(owner, name);
      if (a.kind !== kind) throw new Error(`Účet není ${kind}`);
      return createClient({ serverUrl: a.url, credentials: { username: a.username, password: a.password },
        authMethod: "Basic", defaultAccountType: kind, fetch: davFetch(a.url, allowPrivate) });
    };
    return [
      tool(async ({ account, collection, start, end, query, limit }, config) => {
        const c = await client(getRunContext(config).user_id, account);
        const collections = kind === "caldav" ? await c.fetchCalendars() : await c.fetchAddressBooks();
        if (!collection) return JSON.stringify(collections.map(v => ({ url: v.url, name: v.displayName })));
        const found = collections.find(v => v.url === collection);
        if (!found) throw new Error("Kolekce nepatří k propojenému účtu");
        if (kind === "caldav" && (!start || !end || Date.parse(start) >= Date.parse(end))) throw new Error("Pro kalendář zadej platný interval start/end");
        const objects = kind === "caldav"
          ? await c.fetchCalendarObjects({ calendar: found, timeRange: { start: start!, end: end! } })
          : await c.fetchVCards({ addressBook: found });
        return JSON.stringify(objects.filter(o => !query || String(o.data).toLocaleLowerCase().includes(query.toLocaleLowerCase())).slice(0, limit).map(o => ({ url: o.url, etag: o.etag, data: o.data })));
      }, { name: `${kind}_read`, description: kind === "caldav" ? "Seznam CalDAV kalendářů, nebo události v intervalu start/end ve formátu iCalendar." : "Seznam CardDAV adresářů, nebo hledání kontaktů ve formátu vCard.", schema: z.object({ account: z.string(), collection: z.string().optional(), start: z.iso.datetime().optional(), end: z.iso.datetime().optional(), query: z.string().optional(), limit: z.number().int().min(1).max(100).default(30) }) }),
      tool(async ({ account, collection, data, url, etag }, config) => {
        const c = await client(getRunContext(config).user_id, account);
        const collections = kind === "caldav" ? await c.fetchCalendars() : await c.fetchAddressBooks();
        const found = collections.find(v => v.url === collection);
        if (!found) throw new Error("Kolekce nepatří k propojenému účtu");
        const marker = kind === "caldav" ? "VCALENDAR" : "VCARD";
        if (!data.startsWith(`BEGIN:${marker}\r\n`) || !data.trimEnd().endsWith(`END:${marker}`)) throw new Error(`Očekáván platný ${marker} s CRLF`);
        if (url) {
          const base = new URL(collection.endsWith("/") ? collection : `${collection}/`);
          const target = new URL(url);
          if (target.origin !== base.origin || !target.pathname.startsWith(base.pathname) || target.pathname.slice(base.pathname.length).includes("/") || target.search || target.hash || /%2f|%5c/i.test(target.pathname)) throw new Error("Objekt nepatří do kolekce");
          if (!etag) throw new Error("Pro aktualizaci je nutný aktuální etag z čtení");
        }
        const filename = `${randomUUID()}.${kind === "caldav" ? "ics" : "vcf"}`;
        const response = kind === "caldav"
          ? url ? await c.updateCalendarObject({ calendarObject: { url, etag, data } }) : await c.createCalendarObject({ calendar: found, filename, iCalString: data })
          : url ? await c.updateVCard({ vCard: { url, etag, data } }) : await c.createVCard({ addressBook: found, filename, vCardString: data });
        if (!response.ok) throw new Error(`DAV zápis selhal: HTTP ${response.status}`);
        return JSON.stringify({ url: url ?? new URL(filename, collection.endsWith("/") ? collection : `${collection}/`).href, etag: response.headers.get("etag") });
      }, { name: `${kind}_save`, description: `Vytvoří nebo aktualizuje ${kind === "caldav" ? "událost iCalendar (.ics)" : "kontakt vCard (.vcf)"}. Při změně zachovej UID a ostatní vlastnosti; použij url a etag z čtení. Zapisuj jen na žádost uživatele.`, schema: z.object({ account: z.string(), collection: z.string(), data: z.string().max(500_000), url: z.url().optional(), etag: z.string().optional() }) }),
    ];
  });
}
