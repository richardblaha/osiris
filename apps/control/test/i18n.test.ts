import { afterEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { z } from "zod";
import { configuredLocale, detail, errorBody, errorResponse, HttpError, LocalizedError, requestLocale, translate, ValidationError } from "@osiris/platform/i18n.ts";

describe("service messages", () => {
  afterEach(() => {
    delete process.env.DEFAULT_LOCALE;
  });

  it("renders a key in English or Czech with named parameters", () => {
    expect(translate("en", "errors.files.fileMissing", { path: "a.txt" })).toBe("File a.txt doesn't exist.");
    expect(translate("cs", "errors.files.fileMissing", { path: "a.txt" })).toBe("Soubor a.txt neexistuje");
  });

  it("chooses Czech plural forms by count (1, 2–4, 5+)", () => {
    const limit = (count: number) => translate("cs", "errors.schedule.userLimit", { count });
    expect(limit(1)).toBe("Můžeš mít nejvýš 1 plánovanou úlohu");
    expect(limit(3)).toBe("Můžeš mít nejvýš 3 plánované úlohy");
    expect(limit(20)).toBe("Můžeš mít nejvýš 20 plánovaných úloh");
    expect(translate("en", "errors.schedule.userLimit", { count: 1 })).toBe("You can have at most 1 scheduled task.");
  });

  it("never fails on an unknown key: it shows the key", () => {
    expect(translate("cs", "errors.nope")).toBe("errors.nope");
  });

  it("takes the request's language, then DEFAULT_LOCALE, then English", () => {
    expect(requestLocale("sk-SK,sk;q=0.9")).toBe("cs");
    expect(requestLocale("de")).toBe("en");
    expect(requestLocale(undefined)).toBe("en");
    process.env.DEFAULT_LOCALE = "cs";
    expect(configuredLocale()).toBe("cs");
    expect(requestLocale("de")).toBe("cs");
    expect(requestLocale("en-US")).toBe("en");
    process.env.DEFAULT_LOCALE = "klingon";
    expect(configuredLocale()).toBe("en");
  });

  it("keeps English in an error's message and renders it per reader, with the key as a stable code", () => {
    const err = new HttpError(404, "errors.domain.notFound");
    expect(err.message).toBe("Domain not found.");
    expect(errorBody(err, "cs")).toEqual({ error: "Doména nenalezena", code: "errors.domain.notFound" });
    // Any other LocalizedError is a 400, also when wrapped as a cause.
    const wrapped = new Error("wrapper", { cause: new LocalizedError("errors.url.private") });
    expect(errorResponse(wrapped, "cs")).toEqual({ status: 400, body: { error: "URL míří do privátní sítě", code: "errors.url.private" } });
    expect(errorResponse(new Error("plain"), "cs")).toBeNull();
  });

  it("renders a wrapped cause in the reader's language too", () => {
    const err = new HttpError(502, "errors.sftp.connectFailed", { detail: detail(new LocalizedError("errors.sftp.credentials")) });
    expect(err.in("en")).toBe("Connecting failed: Enter a password or a private key.");
    expect(err.in("cs")).toBe("Připojení selhalo: Zadej heslo nebo privátní klíč");
    expect(detail(new Error("ECONNREFUSED"))).toBe("ECONNREFUSED");
  });

  it("renders validation errors with zod's messages in the reader's language and our own as catalog keys", () => {
    const schema = z.object({ id: z.string().regex(/^[a-z]+$/, "errors.validation.slug"), name: z.string().min(3) });
    const r = schema.safeParse({ id: "Bad!", name: "x" }, { reportInput: true });
    const err = new ValidationError(r.error!);
    expect(err.status).toBe(400);
    expect(err.message).toContain("Slug: lowercase letters, digits and hyphens.");
    expect(err.message).toMatch(/Too small/i);
    const cs = err.in("cs");
    expect(cs).toContain("Zkratka: malá písmena, číslice a pomlčky");
    expect(cs).not.toMatch(/Too small/i);
    expect(cs).toContain("→ at name");
  });

  it("answers concurrent requests each in its own language", async () => {
    const app = new Hono()
      .get("/", async () => {
        await new Promise((r) => setTimeout(r, 5));
        throw new HttpError(404, "errors.tenant.notFound");
      })
      .onError((err, c) => c.json(errorBody(err, requestLocale(c.req.header("accept-language"))), 404));
    const ask = async (lang: string) => (await (await app.request("/", { headers: { "accept-language": lang } })).json()) as { error: string };
    const answers = await Promise.all(["cs", "en", "cs-CZ", "en-GB", "sk"].map(ask));
    expect(answers.map((a) => a.error)).toEqual(["Tenant nenalezen", "Tenant not found.", "Tenant nenalezen", "Tenant not found.", "Tenant nenalezen"]);
  });
});
