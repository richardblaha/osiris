import { EventEmitter } from "node:events";
import { render } from "ink";
import { afterEach, describe, expect, it, vi } from "vitest";
import { connect } from "@osiris/client/api.ts";
import { THEME } from "@osiris/shared/theme.ts";
import { App } from "../src/App.tsx";
import { fieldValue, visible } from "@osiris/client/chat.ts";

/** A terminal of a given size that keeps what was drawn last. */
class Terminal extends EventEmitter {
  last = "";
  constructor(readonly columns: number, readonly rows = 24) {
    super();
  }
  write = (frame: string) => void (this.last = frame);
}
class Keyboard extends EventEmitter {
  isTTY = true;
  data: string | null = null;
  write = (data: string) => {
    this.data = data;
    this.emit("readable");
    this.emit("data", data);
  };
  read = () => {
    const d = this.data;
    this.data = null;
    return d;
  };
  setEncoding() {}
  setRawMode() {}
  resume() {}
  pause() {}
  ref() {}
  unref() {}
}

const sse = (...events: unknown[]) => new Response(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
/** A local agent with one earlier conversation; a run answers with a tool call and a text. */
function fakeAgent() {
  const sent: string[] = [];
  vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
    const path = new URL(url).pathname;
    if (path === "/api/me") return Response.json({ user: { id: "local:bob", name: "Bob", email: null, phone: null, picture: null }, systemAdmin: false, projects: [{ id: "elektro", name: "Elektro", role: "admin", logo: null }], mode: "local" });
    if (path === "/api/project") return Response.json({ id: "elektro", name: "Elektro", role: "admin", features: { knowledge: true, memory: true, files: true, skills: true }, logo: null });
    if (path === "/api/usage") return Response.json({ storage: { used: 2048, limit: null }, tokens: { used: 12_000, limit: null } });
    if (path === "/api/threads" && init.method === "POST") return Response.json({ id: "t2" }, { status: 201 });
    if (path === "/api/threads") return Response.json([{ id: "t1", title: "Nabídka pro Nováka", channel: "web", updatedAt: "2026-10-24T10:00:00Z" }]);
    if (path === "/api/threads/t2/runs") {
      sent.push(JSON.parse(String(init.body)).message);
      return sse({ type: "status", status: "tools" }, { type: "tool-call", toolCallId: "c1", toolName: "search_knowledge", args: {} }, { type: "tool-result", toolCallId: "c1", result: "[]" }, { type: "text-delta", delta: "Hodina stojí 650 Kč." }, { type: "done" });
    }
    return Response.json({ error: "?" }, { status: 404 });
  });
  connect({ url: "http://127.0.0.1:7777", token: async () => "t" });
  return sent;
}

const settle = () => new Promise((r) => setTimeout(r, 150));
async function draw(columns: number) {
  const out = new Terminal(columns);
  const keys = new Keyboard();
  const app = render(<App theme={THEME.dark} />, { stdout: out as never, stdin: keys as never, debug: true, exitOnCtrlC: false, patchConsole: false });
  await settle();
  return { out, keys, app };
}

afterEach(() => vi.unstubAllGlobals());

describe("the terminal client", () => {
  it("lays out sidebar, chat and the project beside them when wide, and narrows to one pane", async () => {
    fakeAgent();
    const wide = await draw(140);
    expect(wide.out.last).toContain("O S I R I S");
    expect(wide.out.last).toContain("Nabídka pro Nováka");
    expect(wide.out.last).toContain("KNOWLEDGE");
    expect(wide.out.last).toContain("Storage: 2.0 kB");
    wide.app.unmount();

    const medium = await draw(100);
    expect(medium.out.last).toContain("Nabídka pro Nováka");
    expect(medium.out.last).not.toContain("Storage: 2.0 kB");
    medium.app.unmount();

    const narrow = await draw(70);
    expect(narrow.out.last).not.toContain("Nabídka pro Nováka");
    expect(narrow.out.last).toContain("How can I help?");
    // Tab shows the sidebar instead.
    narrow.keys.write("\t");
    await settle();
    expect(narrow.out.last).toContain("Nabídka pro Nováka");
    narrow.app.unmount();
  });

  it("moves through the sidebar with Tab and the arrows, and opens a context list", async () => {
    fakeAgent();
    const { out, keys, app } = await draw(120);
    keys.write("\t");
    await settle();
    keys.write("\x1b[B");
    await settle();
    expect(out.last).toContain("› Nabídka pro Nováka");
    keys.write("\x1b[B");
    await settle();
    expect(out.last).toContain("› KNOWLEDGE");
    keys.write("\r");
    await settle();
    expect(out.last).toContain("Edit in the PWA");
    app.unmount();
  });

  it("sends a message into a new conversation and shows the tool call and the streamed answer", async () => {
    const sent = fakeAgent();
    const { out, keys, app } = await draw(120);
    keys.write("Kolik stojí hodina?");
    await settle();
    keys.write("\r");
    await settle();
    await settle();
    expect(sent).toEqual(["Kolik stojí hodina?"]);
    expect(out.last).toContain("✓ search_knowledge");
    expect(out.last).toContain("Hodina stojí 650 Kč.");
    app.unmount();
  });

  it("reads typed answers to a question's fields and keeps the newest messages on screen", () => {
    expect(fieldValue({ name: "ok", label: "OK", type: "boolean", required: true }, "ano")).toBe(true);
    expect(fieldValue({ name: "s", label: "S", type: "select", required: true, options: [{ value: "a", label: "Alfa" }, { value: "b", label: "Beta" }] }, "2")).toBe("b");
    expect(fieldValue({ name: "n", label: "N", type: "number", required: true }, "3,5")).toBe(3.5);
    const many = Array.from({ length: 30 }, (_, i) => ({ role: "user" as const, parts: [{ type: "text" as const, text: `zpráva ${i}` }] }));
    const shown = visible(many, 9, 60);
    expect(shown.at(-1)?.parts[0]).toEqual({ type: "text", text: "zpráva 29" });
    expect(shown.length).toBe(3);
  });
});
