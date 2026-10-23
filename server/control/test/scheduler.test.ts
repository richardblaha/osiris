import { describe, expect, it, vi } from "vitest";
import { projectAudience, InternalVerifier } from "@osiris/platform/internal-auth.ts";
import { checkCron, nextCron, SchedulerWorker } from "../src/scheduler.ts";
import { createTestControl, keys } from "./helpers.ts";

const T0 = Date.parse("2026-10-19T05:00:00Z"); // Monday 7:00 in Prague

async function setup() {
  const control = await createTestControl({
    users: [{ id: "bob", name: "Bob", claims: { project: "acme", role: "osiris-user", phone_number: "+420777123456" } }],
  });
  await control.directory.create("acme", "ACME");
  const worker = new SchedulerWorker({
    schedules: control.schedules,
    projects: control.store,
    users: control.users,
    runtimes: control.runtimes,
    signer: control.signer,
    whatsapp: { client: control.whatsappClient, inbox: control.inbox },
  });
  return { ...control, worker };
}

describe("cron", () => {
  it("computes the next run in the schedule's time zone and refuses too frequent tasks", () => {
    expect(new Date(nextCron("0 7 * * 1-5", "Europe/Prague", T0)).toISOString()).toBe("2026-10-20T05:00:00.000Z");
    expect(() => checkCron("*/5 * * * *", "Europe/Prague", T0)).toThrow("15 minutes");
    expect(() => checkCron("0 7 * *", "Europe/Prague", T0)).toThrow("5 fields");
    expect(() => checkCron("0 25 * * *", "Europe/Prague", T0)).toThrow("Invalid cron");
    expect(() => checkCron("*/15 * * * *", "Europe/Prague", T0)).not.toThrow();
  });
});

describe("scheduler", () => {
  it("lets only one worker claim a due task", async () => {
    const { schedules, db } = await setup();
    await schedules.create("acme", { id: "bob", name: "Bob" }, { title: "A", prompt: "p", runAt: new Date(T0).toISOString() }, T0 - 60_000);
    const first = await schedules.claim(T0);
    expect(first?.title).toBe("A");
    // Nothing to claim means no write (see Inbox.claim).
    const execute = vi.spyOn(db, "execute");
    expect(await schedules.claim(T0)).toBeNull();
    expect(execute).not.toHaveBeenCalled();
    execute.mockRestore();
    // Once the lease runs out (the worker died), another worker takes it.
    expect((await schedules.claim(T0 + 16 * 60_000))?.id).toBe(first!.id);
  });

  it("runs a due task as its owner, records it and moves to the next occurrence", async () => {
    const { schedules, worker, setRuntime, runtimeCalls, sent, inbox } = await setup();
    const verifier = new InternalVerifier(keys.publicKey);
    let call: Awaited<ReturnType<typeof verifier.verify>> | undefined;
    setRuntime(async (_t, _p, init) => {
      call = await verifier.verifyHeader((init.headers as Record<string, string>).authorization, projectAudience("acme"));
      return Response.json({ threadId: "th1", reply: "3 nové zakázky" });
    });
    // The user wrote to us recently, so WhatsApp may deliver.
    await inbox.enqueue([{ id: "w1", from: "420777123456", phoneNumberId: "BIZ", type: "text", text: "ahoj" }], T0 - 60 * 60_000);
    const s = await schedules.create("acme", { id: "bob", name: "Bob" }, { title: "Souhrn", prompt: "Shrň", cron: "0 7 * * 1-5", delivery: "whatsapp" }, T0 - 24 * 60 * 60_000);
    expect(s.nextRunAt).toBe(new Date(T0).toISOString());

    expect(await worker.step(T0 + 1000)).toBe(true);
    expect(JSON.parse(String(runtimeCalls[0]!.init.body))).toEqual({ title: "Souhrn", prompt: "Shrň", idempotencyKey: `${s.id}:${T0}` });
    expect(call).toMatchObject({ issuer: "control", user: { sub: "bob" }, project: "acme", role: "member", channel: "whatsapp" });
    expect(sent).toEqual([{ to: "420777123456", text: "*Souhrn*\n\n3 nové zakázky", from: "BIZ" }]);
    const after = await schedules.get("acme", s.id);
    expect(after).toMatchObject({ lastStatus: "done", lastThreadId: "th1", lastError: null, nextRunAt: "2026-10-20T05:00:00.000Z" });
    expect(await worker.step(T0 + 2000)).toBe(false);
  });

  it("skips late runs, retries unreachable runtimes and gives up after three attempts", async () => {
    const { schedules, worker, setRuntime } = await setup();
    const late = await schedules.create("acme", { id: "bob", name: "Bob" }, { title: "Late", prompt: "p", runAt: new Date(T0).toISOString() }, T0 - 60_000);
    await worker.step(T0 + 2 * 60 * 60_000);
    expect(await schedules.get("acme", late.id)).toMatchObject({ lastStatus: "skipped", enabled: false });

    setRuntime(() => new Response("down", { status: 502 }));
    const s = await schedules.create("acme", { id: "bob", name: "Bob" }, { title: "Flaky", prompt: "p", runAt: new Date(T0).toISOString() }, T0 - 60_000);
    await worker.step(T0);
    expect(await schedules.get("acme", s.id)).toMatchObject({ enabled: true, lastError: expect.stringContaining("502") });
    await worker.step(T0 + 61_000);
    await worker.step(T0 + 61_000 + 121_000);
    expect(await schedules.get("acme", s.id)).toMatchObject({ lastStatus: "failed", enabled: false });
  });

  it("switches off tasks of owners who left the project", async () => {
    const { schedules, worker, directory, runtimeCalls } = await setup();
    const s = await schedules.create("acme", { id: "bob", name: "Bob" }, { title: "A", prompt: "p", cron: "0 7 * * *" }, T0 - 60 * 60_000);
    await directory.setRole("acme", "bob", null);
    await worker.step(T0 + 1000);
    expect(runtimeCalls).toEqual([]);
    expect(await schedules.get("acme", s.id)).toMatchObject({ enabled: false, lastError: "The task's owner is no longer a member of the project." });
  });

  it("serves the schedules API per owner, with admins seeing all", async () => {
    const { asUser, asRuntime, store } = await setup();
    const bob = asUser("bob", [{ projectId: "acme", role: "member" }]);
    const alice = asUser("alice", [{ projectId: "acme", role: "admin" }]);
    const create = (who: typeof bob, body: object) => who("/schedules", { method: "POST", body: JSON.stringify(body) });
    expect((await create(bob, { title: "x", prompt: "y", cron: "* * * * *" })).status).toBe(400);
    const mine = await (await create(bob, { title: "Ranní", prompt: "Shrň", cron: "0 7 * * *" })).json();
    await create(alice, { title: "Admin", prompt: "p", runAt: new Date(Date.now() + 3600_000).toISOString() });
    expect((await (await bob("/schedules")).json()).map((s: { title: string }) => s.title)).toEqual(["Ranní"]);
    expect((await bob("/schedules?all=true")).status).toBe(403);
    expect((await (await alice("/schedules?all=true")).json())).toHaveLength(2);
    expect((await asUser("carol", [{ projectId: "acme", role: "member" }])(`/schedules/${mine.id}`, { method: "DELETE" })).status).toBe(404);
    expect((await bob(`/schedules/${mine.id}`, { method: "PATCH", body: JSON.stringify({ enabled: false }) })).status).toBe(200);

    // The runtime's tools act for the owner they name, within the runtime's project.
    expect((await (await asRuntime("acme")("/schedules?owner=bob")).json())).toHaveLength(1);
    expect((await asRuntime("acme")(`/schedules/${mine.id}?owner=alice`, { method: "DELETE" })).status).toBe(404);

    await store.update("acme", { features: { scheduler: false } });
    expect((await bob("/schedules")).status).toBe(403);
    expect((await asRuntime("acme")("/schedules", { method: "POST", body: JSON.stringify({ title: "x", prompt: "y", cron: "0 7 * * *", owner: { id: "bob", name: null } }) })).status).toBe(403);
  });
});
