import { createHash } from "node:crypto";
import { AIMessage } from "@langchain/core/messages";
import { describe, expect, it } from "vitest";
import { createTestApp, createTestProjects } from "./helpers.ts";

type Call = { url: URL; init: RequestInit };

/** Google and Microsoft as far as the tools use them, recording every call. */
function fakeProviders() {
  const calls: Call[] = [];
  const state = { challenge: "", tokenRequests: [] as URLSearchParams[], expiresIn: 3600 };
  const fetchFn = (async (input: string, init: RequestInit = {}) => {
    const url = new URL(input);
    calls.push({ url, init });
    const json = (data: unknown, status = 200) => Response.json(data, { status });
    if (url.pathname === "/token" || url.pathname.endsWith("/oauth2/v2.0/token")) {
      const form = new URLSearchParams(String(init.body));
      state.tokenRequests.push(form);
      if (form.get("grant_type") === "authorization_code") {
        if (createHash("sha256").update(form.get("code_verifier") ?? "").digest("base64url") !== state.challenge) return json({ error: "invalid_grant" }, 400);
        return json({ access_token: "access-1", refresh_token: "refresh-1", expires_in: state.expiresIn });
      }
      return json({ access_token: "access-2", expires_in: 3600 });
    }
    if (url.pathname === "/v1/userinfo") return json({ email: "bob@gmail.com" });
    if (url.pathname === "/v1.0/me") return json({ mail: "bob@firma.onmicrosoft.com" });
    if (url.pathname.endsWith("/messages/m1")) {
      return json({ id: "m1", threadId: "t1", payload: { headers: [{ name: "Message-ID", value: "<orig@mail.gmail.com>" }] } });
    }
    if (url.pathname.endsWith("/messages/send")) return json({ id: "sent-1" });
    if (url.pathname === "/v1.0/me/contacts") {
      return json({ value: [{ id: "c1", displayName: "Jan Dvořák", mobilePhone: "+420 777 111 222" }, { id: "c2", displayName: "Eva Nová" }] });
    }
    return json({ error: { message: "unexpected" } }, 404);
  }) as unknown as typeof fetch;
  return { calls, state, fetchFn };
}

async function setup(script: AIMessage[] = []) {
  const providers = fakeProviders();
  const { projects, model } = createTestProjects(script, [], undefined, {
    integrations: {
      redirectUrl: "https://osiris.test/integration-callback",
      clients: { google: { clientId: "g-id", clientSecret: "g-secret" }, microsoft: { clientId: "m-id", clientSecret: "m-secret" } },
      fetch: providers.fetchFn,
    },
  });
  const app = await createTestApp(projects);
  const as = (user: string) => (path: string, init: RequestInit = {}) =>
    app.request(`/api${path}`, { ...init, headers: { authorization: `Bearer ${user}`, "x-project-id": "acme", "content-type": "application/json", ...init.headers } });
  const connect = async (who: ReturnType<typeof as>, provider: "google" | "microsoft") => {
    const { authorizationUrl } = await (await who(`/integrations/${provider}/connect`, { method: "POST" })).json();
    const url = new URL(authorizationUrl);
    providers.state.challenge = url.searchParams.get("code_challenge")!;
    const res = await who("/integrations/callback", { method: "POST", body: JSON.stringify({ state: url.searchParams.get("state"), code: "the-code" }) });
    return { url, res };
  };
  return { ...providers, projects, model, as, connect };
}

describe("Google and Microsoft accounts", () => {
  it("connects with PKCE, keeps the tokens sealed and gives the tools only to who connected", async () => {
    const { as, connect, projects, model, state } = await setup([new AIMessage("Ahoj."), new AIMessage("Ahoj.")]);
    const bob = as("bob:project=acme");
    const { url, res } = await connect(bob, "google");
    expect(url.origin).toBe("https://accounts.google.com");
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      client_id: "g-id",
      redirect_uri: "https://osiris.test/integration-callback",
      code_challenge_method: "S256",
      access_type: "offline",
      prompt: "consent",
    });
    expect(url.searchParams.get("scope")).toContain("https://www.googleapis.com/auth/gmail.modify");
    expect(await res.json()).toEqual({ provider: "google", account: "bob@gmail.com" });
    expect(state.tokenRequests[0]!.get("client_secret")).toBe("g-secret");
    expect(await (await bob("/integrations")).json()).toEqual([
      { provider: "google", account: "bob@gmail.com", connected: true },
      { provider: "microsoft", account: null, connected: false },
    ]);
    const acme = await projects.get("acme");
    expect(String((await acme.db.execute("SELECT data_enc FROM integrations")).rows[0]!.data_enc)).not.toContain("access-1");

    // The model sees Google's tools in Bob's runs, not in Eva's.
    const bound: string[][] = [];
    model.bindTools = ((tools: { name: string }[]) => (bound.push(tools.map((t) => t.name)), model)) as never;
    for (const who of [bob, as("eva:project=acme")]) {
      const { id } = await (await who("/threads", { method: "POST" })).json();
      await (await who(`/threads/${id}/runs`, { method: "POST", body: JSON.stringify({ message: "Ahoj" }) })).text();
    }
    expect(bound[0]).toContain("google_mail_send");
    expect(bound[0]).not.toContain("microsoft_mail_send");
    expect(bound[1]!.some((n) => n.startsWith("google_"))).toBe(false);

    // A sign-in can't be finished by someone else, and disconnecting forgets the account.
    const { authorizationUrl } = await (await bob("/integrations/microsoft/connect", { method: "POST" })).json();
    const stolen = await as("eva:project=acme")("/integrations/callback", {
      method: "POST",
      body: JSON.stringify({ state: new URL(authorizationUrl).searchParams.get("state"), code: "the-code" }),
    });
    expect(stolen.status).toBe(400);
    expect((await bob("/integrations/google", { method: "DELETE" })).status).toBe(204);
    expect((await (await bob("/integrations")).json())[0]).toMatchObject({ provider: "google", connected: false });
  });

  it("replies in a Gmail thread, refreshing an expired token first", async () => {
    const { as, connect, projects, calls, state } = await setup();
    state.expiresIn = 0;
    await connect(as("bob:project=acme"), "google");
    const acme = await projects.get("acme");
    const send = acme.builtinTools.find(([, t]) => t.name === "google_mail_send")![1];
    const config = { configurable: { thread_id: "t", project_id: "acme", user_id: "dev:bob", role: "member", channel: "web" } };
    expect(await send.invoke({ to: "jan@firma.cz", subject: "Re: Nabídka – koupelna", body: "Dobrý den, posílám nabídku.", reply_to_id: "m1" }, config)).toBe(
      "Odesláno (id sent-1).",
    );
    expect(state.tokenRequests.at(-1)!.get("grant_type")).toBe("refresh_token");
    const sent = calls.find((c) => c.url.pathname.endsWith("/messages/send"))!;
    expect(new Headers(sent.init.headers).get("authorization")).toBe("Bearer access-2");
    const { raw, threadId } = JSON.parse(String(sent.init.body)) as { raw: string; threadId: string };
    const mime = Buffer.from(raw, "base64url").toString();
    expect(threadId).toBe("t1");
    expect(mime).toContain("To: jan@firma.cz\r\n");
    expect(mime).toContain(`Subject: =?UTF-8?B?${Buffer.from("Re: Nabídka – koupelna").toString("base64")}?=`);
    expect(mime).toContain("In-Reply-To: <orig@mail.gmail.com>");
    expect(Buffer.from(mime.split("\r\n\r\n")[1]!.replace(/\r\n/g, ""), "base64").toString()).toBe("Dobrý den, posílám nabídku.");
  });

  it("finds Outlook contacts by name or number", async () => {
    const { as, connect, projects } = await setup();
    await connect(as("bob:project=acme"), "microsoft");
    const acme = await projects.get("acme");
    const search = acme.builtinTools.find(([, t]) => t.name === "microsoft_contacts_search")![1];
    const config = { configurable: { thread_id: "t", project_id: "acme", user_id: "dev:bob", role: "member", channel: "web" } };
    expect(await search.invoke({ query: "777111" }, config)).toBe("Jan Dvořák · +420 777 111 222 · id c1");
    // Not connected: a sentence for the model, not a failure.
    const eva = { configurable: { ...config.configurable, user_id: "dev:eva" } };
    expect(await search.invoke({ query: "Eva" }, eva)).toContain("isn't connected");
  });
});
