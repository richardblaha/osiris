import { createHmac } from "node:crypto";
import { AIMessage } from "@langchain/core/messages";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.ts";
import type { Identity } from "../src/auth/oidc.ts";
import { createDevVerifier } from "../src/auth/oidc.ts";
import { WhatsAppChannel } from "../src/whatsapp/channel.ts";
import { WhatsAppClient, splitText } from "../src/whatsapp/cloud-api.ts";
import { phoneDirectory, phoneKey, type PhoneDirectory } from "../src/whatsapp/directory.ts";
import { PocketIdClient } from "../src/pocketid.ts";
import { accessFromClaims } from "../src/auth/tenants.ts";
import { memoryUsers, pocketIdUsers } from "../src/users.ts";
import { createTestDirectory, createTestTenants } from "./helpers.ts";

const APP_SECRET = "app-secret";
const BUSINESS = "1111";

/** A WhatsApp user with claims written like the dev token's (`tenant=acme&role=osiris-admin`; `role` defaults to osiris-user). */
const user = (name: string, phone: string, query: string): Identity => ({
  // Same sub as the dev verifier's, so the web API sees the user's WhatsApp threads.
  sub: `dev:${name}`,
  email: null,
  name,
  phone,
  picture: null,
  access: accessFromClaims((key) => new URLSearchParams(query.includes("role=") ? query : `${query}&role=osiris-user`).get(key) ?? undefined),
});

async function setup(script: AIMessage[] = [], users: Identity[] = []) {
  const { tenants, model } = createTestTenants(script);
  const sent: { to: string; text?: string; status?: string }[] = [];
  const graphFetch = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    sent.push({ to: body.to, text: body.text?.body, status: body.status });
    return new Response("{}");
  }) as typeof fetch;
  const { directory } = await createTestDirectory(tenants, [{ id: "acme" }, { id: "beta" }, { id: "gamma" }]);
  const phones: PhoneDirectory = {
    async lookup(phone) {
      return users.find((u) => phoneKey(u.phone!) === phoneKey(phone)) ?? null;
    },
  };
  const channel = new WhatsAppChannel({ tenants, directory, phones, client: new WhatsAppClient("token", graphFetch) });
  const app = createApp({
    verifier: createDevVerifier(),
    tenants,
    directory,
    corsOrigin: "*",
    whatsapp: { channel, verifyToken: "verify-me", appSecret: APP_SECRET },
  });

  let seq = 0;
  /** Delivers a text message from `from` as Meta would and waits until it is handled. */
  const send = async (from: string, text: string, id = `wamid.${++seq}`) => {
    const res = await post({
      object: "whatsapp_business_account",
      entry: [
        {
          changes: [
            {
              field: "messages",
              value: {
                messaging_product: "whatsapp",
                metadata: { display_phone_number: "420600000000", phone_number_id: BUSINESS },
                messages: [{ from, id, timestamp: "1760000000", type: "text", text: { body: text } }],
              },
            },
          ],
        },
      ],
    });
    expect(res.status).toBe(200);
    await channel.idle();
  };
  const post = (payload: object, signature?: string) => {
    const body = JSON.stringify(payload);
    return app.request("/webhooks/whatsapp", {
      method: "POST",
      body,
      headers: {
        "content-type": "application/json",
        "x-hub-signature-256": signature ?? `sha256=${createHmac("sha256", APP_SECRET).update(body).digest("hex")}`,
      },
    });
  };
  const replies = () => sent.filter((m) => m.text).map((m) => m.text);
  const web = (token: string, tenant: string) => app.request("/api/threads", { headers: { authorization: `Bearer ${token}`, "x-tenant-id": tenant } });
  return { app, model, send, post, sent, replies, web, tenants };
}

describe("WhatsApp webhook", () => {
  it("answers Meta's verification only with the right token", async () => {
    const { app } = await setup();
    const ok = await app.request("/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=verify-me&hub.challenge=42");
    expect(ok.status).toBe(200);
    expect(await ok.text()).toBe("42");
    expect((await app.request("/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=nope&hub.challenge=42")).status).toBe(403);
  });

  it("answers 404 when WhatsApp is not configured", async () => {
    const { tenants } = createTestTenants();
    const app = createApp({ verifier: createDevVerifier(), tenants, directory: (await createTestDirectory(tenants)).directory, corsOrigin: "*", web: { dir: "/nonexistent" } });
    expect((await app.request("/webhooks/whatsapp?hub.mode=subscribe")).status).toBe(404);
  });

  it("rejects requests without a valid signature", async () => {
    const { post, sent } = await setup();
    expect((await post({ entry: [] }, "sha256=00")).status).toBe(401);
    expect(sent).toEqual([]);
  });

  it("runs the agent for the sender's user and tenant and replies", async () => {
    const { send, sent, replies, model, web } = await setup([new AIMessage("Dobrý den, Bobe.")], [user("bob", "+420 777 123 456", "tenant=acme")]);
    await send("420777123456", "Ahoj");

    expect(sent[0]).toMatchObject({ status: "read" });
    expect(replies()).toEqual(["Dobrý den, Bobe."]);
    expect(model.calls[0]?.[0]?.text).toContain("WhatsAppu");
    const threads = await (await web("bob:tenant=acme", "acme")).json();
    expect(threads).toMatchObject([{ title: "Ahoj", channel: "whatsapp" }]);
  });

  it("keeps one conversation until /nova", async () => {
    const { send, model } = await setup([new AIMessage("1"), new AIMessage("2"), new AIMessage("3")], [user("bob", "420777123456", "tenant=acme")]);
    await send("420777123456", "první");
    await send("420777123456", "druhá");
    expect(model.calls[1]?.map((m) => m.text)).toContain("první");
    await send("420777123456", "/nova");
    await send("420777123456", "třetí");
    expect(model.calls[2]?.map((m) => m.text)).not.toContain("první");
  });

  it("lets a user in several tenants switch with /tenant", async () => {
    const { send, replies, model } = await setup(
      [new AIMessage("z beta"), new AIMessage("z acme")],
      [user("alice", "420600111222", "tenant=acme&tenant-admin=beta")],
    );
    await send("420600111222", "Ahoj");
    expect(replies().at(-1)).toContain("Tvoji tenanti: acme, beta");
    expect(model.calls).toHaveLength(0);

    await send("420600111222", "/tenant gamma");
    expect(replies().at(-1)).toContain("Tenanta „gamma“ nemáš");
    await send("420600111222", "/tenant beta");
    expect(replies().at(-1)).toBe("Přepnuto na tenanta *beta*.");
    await send("420600111222", "Ahoj");
    expect(replies().at(-1)).toBe("z beta");

    await send("420600111222", "/tenant acme");
    await send("420600111222", "/tenant");
    expect(replies().at(-1)).toContain("Aktivní tenant: *acme*.");
    await send("420600111222", "Ahoj znovu");
    expect(replies().at(-1)).toBe("z acme");
    // A new tenant means a new conversation: acme's thread doesn't contain beta's history.
    expect(model.calls[1]?.filter((m) => m.text === "Ahoj")).toHaveLength(0);
  });

  it("refuses unknown numbers and users without a tenant", async () => {
    const { send, replies, model } = await setup([], [user("carol", "420700000000", "")]);
    await send("420999999999", "Ahoj");
    await send("420700000000", "Ahoj");
    expect(replies()).toEqual([
      "Tohle číslo nemá v Osirisu účet. Požádej správce, ať ti ho nastaví v profilu.",
      "Nejsi přiřazený k žádnému tenantovi. Obrať se na správce.",
    ]);
    expect(model.calls).toHaveLength(0);
  });

  it("gives a system admin every tenant and respects the tenant's WhatsApp switch", async () => {
    const { send, replies, model, tenants } = await setup([new AIMessage("z gamma")], [user("root", "420700111222", "role=osiris-admin")]);
    await send("420700111222", "Ahoj");
    expect(replies().at(-1)).toContain("Tvoji tenanti: acme, beta, gamma");
    await (await tenants.get("beta")).features.set({ whatsapp: false });
    await send("420700111222", "/tenant beta");
    await send("420700111222", "Ahoj");
    expect(replies().at(-1)).toBe("WhatsApp není pro tenanta *beta* povolený.");
    await send("420700111222", "/tenant gamma");
    await send("420700111222", "Ahoj");
    expect(replies().at(-1)).toBe("z gamma");
    expect(model.calls).toHaveLength(1);
  });

  it("handles a redelivered message once", async () => {
    const { send, replies } = await setup([new AIMessage("jednou"), new AIMessage("dvakrát")], [user("bob", "420777123456", "tenant=acme")]);
    await send("420777123456", "Ahoj", "wamid.same");
    await send("420777123456", "Ahoj", "wamid.same");
    expect(replies()).toEqual(["jednou"]);
  });
});

describe("phone directory", () => {
  it("matches numbers by digits, skipping disabled and shared ones, with the user's claims", async () => {
    const users = memoryUsers([
      { id: "u1", name: "Bob Novák", email: null, disabled: false, claims: { phone_number: "+420 777 123 456", tenant: "acme", role: "osiris-user" } },
      { id: "u2", name: null, email: null, disabled: true, claims: { phone_number: "+420600000001" } },
      { id: "u3", name: null, email: null, disabled: false, claims: { phone_number: "+420600000002" } },
      { id: "u4", name: null, email: null, disabled: false, claims: { phone_number: "+420600000002" } },
    ]);
    const directory = phoneDirectory(users);
    expect(await directory.lookup("420777123456")).toEqual({
      sub: "u1",
      email: null,
      name: "Bob Novák",
      phone: "+420 777 123 456",
      picture: null,
      access: { roles: ["osiris-user"], tenants: ["acme"], adminTenants: [] },
    });
    expect(await directory.lookup("420600000001")).toBeNull();
    expect(await directory.lookup("420600000002")).toBeNull();
  });
});

describe("PocketID users", () => {
  it("pages through users with their claims, caches them and writes claims without losing others", async () => {
    const pages: Record<string, object> = {
      "1": { data: [{ id: "u1", firstName: "Bob", lastName: "Novák", customClaims: [{ key: "phone_number", value: "+420777123456" }] }], pagination: { totalPages: 2 } },
      "2": { data: [{ id: "u5", displayName: "Eva", disabled: true }], pagination: { totalPages: 2 } },
    };
    const requests: string[] = [];
    let claims = [{ key: "phone_number", value: "+420777123456" }, { key: "tenant", value: "acme" }];
    const fetchFn = (async (url: URL, init: RequestInit = {}) => {
      expect((init.headers as Record<string, string>)["x-api-key"]).toBe("key");
      requests.push(`${init.method ?? "GET"} ${url.pathname}`);
      if (url.pathname === "/api/users") return Response.json(pages[url.searchParams.get("pagination[page]")!]);
      if (url.pathname === "/api/users/u1") return Response.json({ id: "u1", customClaims: claims });
      if (url.pathname === "/api/custom-claims/user/u1" && init.method === "PUT") {
        claims = JSON.parse(String(init.body));
        return Response.json(claims);
      }
      return new Response(null, { status: 404 });
    }) as unknown as typeof fetch;
    const users = pocketIdUsers(new PocketIdClient("https://auth.example.cz", "key", fetchFn));

    expect(await users.list()).toEqual([
      { id: "u1", name: "Bob Novák", email: null, disabled: false, claims: { phone_number: "+420777123456" } },
      { id: "u5", name: "Eva", email: null, disabled: true, claims: {} },
    ]);
    await users.list();
    expect(requests.filter((r) => r === "GET /api/users")).toHaveLength(2);

    // Starts from the user's current claims (not the cached list), so the tenant claim set elsewhere is kept.
    await users.setClaims("u1", { "tenant-admin": "beta", phone_number: null });
    expect(claims).toEqual([{ key: "tenant", value: "acme" }, { key: "tenant-admin", value: "beta" }]);
    await expect(users.setClaims("nobody", { tenant: "x" })).rejects.toThrow("not found");
  });
});

describe("splitText", () => {
  it("splits long replies at line breaks", () => {
    const text = `${"a".repeat(30)}\n${"b".repeat(30)}`;
    expect(splitText(text, 40)).toEqual(["a".repeat(30), "b".repeat(30)]);
    expect(splitText("x".repeat(90), 40)).toEqual(["x".repeat(40), "x".repeat(40), "x".repeat(10)]);
  });
});
