import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { InternalVerifier, projectAudience } from "@osiris/platform/internal-auth.ts";
import { splitText } from "../src/whatsapp/cloud-api.ts";
import { userByPhone } from "../src/whatsapp/phones.ts";
import { WhatsAppRouter } from "../src/whatsapp/router.ts";
import { createTestControl, keys } from "./helpers.ts";

const BUSINESS = "1111";

async function setup(users: NonNullable<Parameters<typeof createTestControl>[0]>["users"] = []) {
  const control = await createTestControl({ users });
  for (const id of ["acme", "beta", "gamma"]) await control.directory.create(id, id.toUpperCase());
  const router = new WhatsAppRouter({
    db: control.db,
    inbox: control.inbox,
    users: control.users,
    projects: control.store,
    phones: control.phones,
    client: control.whatsappClient,
    runtimes: control.runtimes,
    signer: control.signer,
  });
  const verifier = new InternalVerifier(keys.publicKey);
  const runs: { project: string; path: string; user?: string; role?: string; text?: string }[] = [];
  control.setRuntime(async (project, path, init) => {
    const call = await verifier.verifyHeader((init.headers as Record<string, string>).authorization, projectAudience(project));
    const body = init.body ? JSON.parse(String(init.body)) : {};
    runs.push({ project, path, user: call.user?.sub, role: call.role, text: body.text });
    return path === "/internal/whatsapp/new-thread" ? new Response(null, { status: 204 }) : Response.json({ reply: `odpověď z ${project}` });
  });

  let seq = 0;
  const post = (payload: object, signature?: string) => {
    const body = JSON.stringify(payload);
    return control.app.request("/webhooks/whatsapp", {
      method: "POST",
      body,
      headers: { "content-type": "application/json", "x-hub-signature-256": signature ?? `sha256=${createHmac("sha256", "app-secret").update(body).digest("hex")}` },
    });
  };
  const payload = (from: string, text: string, id: string) => ({
    object: "whatsapp_business_account",
    entry: [{ changes: [{ field: "messages", value: { metadata: { phone_number_id: BUSINESS }, messages: [{ from, id, type: "text", text: { body: text } }] } }] }],
  });
  /** Delivers a message as Meta would and lets the worker handle everything queued. */
  const send = async (from: string, text: string, id = `wamid.${++seq}`) => {
    expect((await post(payload(from, text, id))).status).toBe(200);
    while (await router.step());
  };
  const replies = () => control.sent.filter((m) => m.text).map((m) => m.text);
  return { ...control, router, send, post, replies, runs };
}

describe("WhatsApp webhook", () => {
  it("answers Meta's verification only with the right token and checks signatures", async () => {
    const { app, post } = await setup();
    expect(await (await app.request("/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=verify-me&hub.challenge=42")).text()).toBe("42");
    expect((await app.request("/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=42")).status).toBe(403);
    expect((await post({ entry: [] }, "sha256=00")).status).toBe(401);
  });
});

describe("WhatsApp router", () => {
  const bob = { id: "bob", name: "Bob", claims: { phone_number: "+420 777 123 456", project: "acme", role: "osiris-user" } };

  it("runs the agent in the sender's project as the sender and replies, once per message", async () => {
    const { send, replies, runs } = await setup([bob]);
    await send("420777123456", "Kolik mám zakázek?", "m1");
    await send("420777123456", "Kolik mám zakázek?", "m1");
    expect(runs).toEqual([{ project: "acme", path: "/internal/whatsapp/message", user: "bob", role: "member", text: "Kolik mám zakázek?" }]);
    expect(replies()).toEqual(["odpověď z acme"]);
  });

  it("handles a sender's messages in order, one at a time", async () => {
    const { inbox, db } = await setup([bob]);
    await inbox.enqueue([
      { id: "a", from: "1", phoneNumberId: BUSINESS, type: "text", text: "first" },
      { id: "b", from: "1", phoneNumberId: BUSINESS, type: "text", text: "second" },
      { id: "c", from: "2", phoneNumberId: BUSINESS, type: "text", text: "other" },
    ]);
    const first = await inbox.claim();
    const other = await inbox.claim();
    // The sender's second message waits for the first.
    expect([first?.id, other?.id]).toEqual(["a", "c"]);
    // Nothing to claim means no write: rqlite can't snapshot away writes that change nothing.
    const execute = vi.spyOn(db, "execute");
    expect(await inbox.claim()).toBeNull();
    expect(execute).not.toHaveBeenCalled();
    execute.mockRestore();
    await inbox.finish("a", "done");
    expect((await inbox.claim())?.id).toBe("b");
  });

  it("lets a user in several projects switch with /project and start over with /nova", async () => {
    const { send, replies, runs } = await setup([{ ...bob, claims: { ...bob.claims, project: "acme,beta" } }]);
    await send("420777123456", "ahoj");
    expect(replies().at(-1)).toContain("Send /project <slug>");
    await send("420777123456", "/project gamma");
    expect(replies().at(-1)).toContain("You don't have a project “gamma”");
    await send("420777123456", "/project beta");
    await send("420777123456", "ahoj");
    expect(runs.at(-1)).toMatchObject({ project: "beta", text: "ahoj" });
    await send("420777123456", "/nova");
    expect(runs.at(-1)).toMatchObject({ project: "beta", path: "/internal/whatsapp/new-thread" });
    expect(replies().at(-1)).toBe("OK, starting a new conversation.");
  });

  it("refuses unknown numbers, users without a project and projects with WhatsApp off", async () => {
    const { send, replies, store, runs } = await setup([bob, { id: "eve", claims: { phone_number: "+420600000001", role: "osiris-user" } }]);
    await send("420111111111", "ahoj");
    await send("420600000001", "ahoj");
    await store.update("acme", { features: { whatsapp: false } });
    await send("420777123456", "ahoj");
    expect(replies()).toEqual([
      expect.stringContaining("has no Osiris account"),
      expect.stringContaining("aren't assigned"),
      "WhatsApp is not enabled for project *acme*.",
    ]);
    expect(runs).toEqual([]);
  });

  it("replies in the configured language (DEFAULT_LOCALE)", async () => {
    const { send, replies } = await setup([bob]);
    process.env.DEFAULT_LOCALE = "cs";
    try {
      await send("420111111111", "ahoj");
    } finally {
      delete process.env.DEFAULT_LOCALE;
    }
    expect(replies()).toEqual([expect.stringContaining("nemá v Osirisu účet")]);
  });

  it("verifies a phone number by a code sent from it and takes the number from anyone else", async () => {
    const { send, replies, phones, users, asUser } = await setup([
      { id: "alice", claims: { project: "acme", role: "osiris-user" } },
      { id: "old", claims: { phone_number: "+420777999888" } },
    ]);
    const res = await asUser("alice", [{ projectId: "acme", role: "member" }])("/me/phone", { method: "POST", body: JSON.stringify({ phone: "+420 777 999 888" }) });
    const { phoneChallenge } = await res.json();
    expect(phoneChallenge).toMatchObject({ phone: "+420 777 999 888", whatsappNumber: "+420 600 000 000", code: expect.stringMatching(/^\d{6}$/) });

    // From another phone, the code doesn't count.
    await send("420111222333", `OVERENI ${phoneChallenge.code}`);
    await send("420777999888", `ověření ${phoneChallenge.code}`);
    expect(replies()).toEqual([expect.stringContaining("doesn't match"), "Your number is verified. You can write to me now."]);
    expect((await users.get("alice")).claims.phone_number).toBe("+420777999888");
    expect((await users.get("old")).claims.phone_number).toBeUndefined();
    expect(await phones.confirm("420777999888", phoneChallenge.code)).toBeNull();
  });

  it("matches numbers by digits, skipping disabled and shared ones", async () => {
    const { users } = await setup([
      bob,
      { id: "u2", disabled: true, claims: { phone_number: "+420600000001" } },
      { id: "u3", claims: { phone_number: "+420600000002" } },
      { id: "u4", claims: { phone_number: "+420600000002" } },
    ]);
    expect(await userByPhone(users, "420777123456")).toMatchObject({ sub: "bob", access: { roles: ["osiris-user"], projects: ["acme"] } });
    expect(await userByPhone(users, "420600000001")).toBeNull();
    expect(await userByPhone(users, "420600000002")).toBeNull();
  });

  it("splits long replies at line breaks", () => {
    expect(splitText(`${"a".repeat(30)}\n${"b".repeat(30)}`, 40)).toEqual(["a".repeat(30), "b".repeat(30)]);
    expect(splitText("x".repeat(90), 40)).toEqual(["x".repeat(40), "x".repeat(40), "x".repeat(10)]);
  });
});
