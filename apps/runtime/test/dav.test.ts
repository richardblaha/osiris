import { describe, expect, it, vi } from "vitest";
import { davTools } from "@osiris/core/integrations/dav.ts";
import { StandardAccounts } from "@osiris/core/integrations/standard.ts";
import { SecretBox } from "@osiris/core/secrets.ts";
import { createTestDb } from "./helpers.ts";

const config = { configurable: { tenant_id: "acme", user_id: "bob", role: "member", channel: "web", thread_id: "t1" } };

describe("DAV tools", () => {
  for (const kind of ["caldav", "carddav"] as const) {
    it(`${kind} discovers collections, reads and updates with ETag preconditions`, async () => {
      const db = await createTestDb();
      const accounts = new StandardAccounts(db, SecretBox.insecureDev());
      await accounts.put("bob", "work", { kind, url: "https://cloud.example.cz/dav/", username: "bob", password: "secret" });
      const collection = "https://cloud.example.cz/dav/work/";
      const objectUrl = `${collection}entry.${kind === "caldav" ? "ics" : "vcf"}`;
      const marker = kind === "caldav" ? "VCALENDAR" : "VCARD";
      const data = `BEGIN:${marker}\r\nVERSION:${kind === "caldav" ? "2.0" : "3.0"}\r\nEND:${marker}\r\n`;
      const readObjects = vi.fn().mockResolvedValue([{ url: objectUrl, etag: '"v1"', data }]);
      const update = vi.fn().mockResolvedValue(new Response(null, { status: 204, headers: { etag: '"v2"' } }));
      const create = vi.fn().mockResolvedValue(new Response(null, { status: 201 }));
      const c = {
        fetchCalendars: vi.fn().mockResolvedValue([{ url: collection, displayName: "Práce" }]),
        fetchAddressBooks: vi.fn().mockResolvedValue([{ url: collection, displayName: "Práce" }]),
        fetchCalendarObjects: readObjects, fetchVCards: readObjects,
        updateCalendarObject: update, updateVCard: update,
        createCalendarObject: create, createVCard: create,
      };
      const factory = vi.fn().mockResolvedValue(c);
      const tools = davTools(accounts, false, factory as never);
      const read = tools.find(t => t.name === `${kind}_read`)!;
      const save = tools.find(t => t.name === `${kind}_save`)!;
      expect(JSON.parse(await read.invoke({ account: "work" }, config))).toEqual([{ url: collection, name: "Práce" }]);
      const result = JSON.parse(await read.invoke({ account: "work", collection, start: "2026-10-01T00:00:00Z", end: "2026-11-01T00:00:00Z" }, config));
      expect(result[0].etag).toBe('"v1"');
      await save.invoke({ account: "work", collection, data }, config);
      expect(create).toHaveBeenCalledOnce();
      await expect(save.invoke({ account: "work", collection, data, url: objectUrl }, config)).rejects.toThrow("etag");
      await save.invoke({ account: "work", collection, data, url: objectUrl, etag: '"v1"' }, config);
      expect(update).toHaveBeenCalledWith({ [kind === "caldav" ? "calendarObject" : "vCard"]: { url: objectUrl, etag: '"v1"', data } });
      await expect(save.invoke({ account: "work", collection, data, url: "https://evil.cz/entry", etag: '"v1"' }, config)).rejects.toThrow("kolekce");
      await expect(read.invoke({ account: "work", collection: "https://evil.cz/" }, config)).rejects.toThrow("Kolekce");
      update.mockResolvedValueOnce(new Response(null, { status: 412 }));
      await expect(save.invoke({ account: "work", collection, data, url: objectUrl, etag: '"v1"' }, config)).rejects.toThrow("412");
      db.close();
    });
  }
});
