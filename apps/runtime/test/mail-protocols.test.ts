import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { pop3Read } from "@osiris/core/integrations/pop3.ts";
import { mailTools } from "@osiris/core/integrations/mail.ts";
import { StandardAccounts } from "@osiris/core/integrations/standard.ts";
import { SecretBox } from "@osiris/core/secrets.ts";
import { createTestDb } from "./helpers.ts";

const mocks = vi.hoisted(() => ({ connect: vi.fn(), sendMail: vi.fn(), close: vi.fn(), createTransport: vi.fn() }));
vi.mock("node:tls", async importOriginal => ({ ...await importOriginal<typeof import("node:tls")>(), connect: mocks.connect }));

class PopSocket extends EventEmitter {
  destroyed = false;
  writes: string[] = [];
  setTimeout() { return this; }
  destroy(error?: Error) { this.destroyed = true; if (error) this.emit("error", error); this.emit("close"); return this; }
  write(command: string) {
    this.writes.push(command);
    let response = "+OK\r\n";
    if (command === "UIDL\r\n") response += "1 first\r\n2 second\r\n.\r\n";
    if (command === "RETR 2\r\n") response += "Subject: Test\r\n\r\n..hello\r\n.\r\n";
    queueMicrotask(() => {
      // Simulate a fragmented TCP response.
      this.emit("data", Buffer.from(response.slice(0, 3)));
      this.emit("data", Buffer.from(response.slice(3)));
    });
    return true;
  }
}

function popServer() {
  const socket = new PopSocket();
  mocks.connect.mockImplementationOnce(() => {
    queueMicrotask(() => { socket.emit("secureConnect"); socket.emit("data", Buffer.from("+OK Ready\r\n")); });
    return socket;
  });
  return socket;
}
const endpoint = { host: "mail.example.cz", port: 995, username: "bob", password: "secret" };

describe("standard mail protocols", () => {
  it("lists stable POP3 UIDLs and reads with dot unstuffing without deleting messages", async () => {
    const list = popServer();
    expect(JSON.parse(await pop3Read(endpoint, undefined, 1))).toEqual([{ number: "2", id: "second" }]);
    expect(list.destroyed).toBe(true);
    const read = popServer();
    expect(await pop3Read(endpoint, "second")).toBe("Subject: Test\r\n\r\n.hello");
    expect(read.writes).toContain("RETR 2\r\n");
    expect(read.writes.some(command => command.startsWith("DELE"))).toBe(false);
    expect(read.destroyed).toBe(true);
    const missing = popServer();
    await expect(pop3Read(endpoint, "absent")).rejects.toThrow("not found");
    expect(missing.destroyed).toBe(true);
  });

  it("sends with configured sender, mandatory STARTTLS, and closes the transport", async () => {
    const db = await createTestDb();
    const accounts = new StandardAccounts(db, SecretBox.insecureDev());
    await accounts.put("bob", "work", { kind: "mail", from: "bob@example.cz", smtp: { ...endpoint, port: 587, secure: false } });
    const createTransport = mocks.createTransport.mockReturnValue({ sendMail: mocks.sendMail, close: mocks.close });
    mocks.sendMail.mockResolvedValue({ messageId: "m1", accepted: ["eva@example.cz"], rejected: [] });
    const send = mailTools(accounts, true, createTransport as never).find(t => t.name === "mail_send")!;
    const config = { configurable: { tenant_id: "acme", user_id: "bob", role: "member", channel: "web", thread_id: "t1" } };
    await send.invoke({ account: "work", to: ["eva@example.cz"], subject: "Český předmět", body: "Ahoj" }, config);
    expect(createTransport).toHaveBeenCalledWith(expect.objectContaining({ secure: false, requireTLS: true, disableFileAccess: true, disableUrlAccess: true }));
    expect(mocks.sendMail).toHaveBeenCalledWith(expect.objectContaining({ from: "bob@example.cz", text: "Ahoj" }));
    expect(mocks.close).toHaveBeenCalled();
    await expect(send.invoke({ account: "work", to: ["eva@example.cz"], subject: "Test\r\nBcc: bad@example.cz", body: "Ahoj" }, config)).rejects.toThrow();
    await expect(send.invoke({ account: "work", to: ["eva@example.cz"], subject: "Test", body: "Ahoj" }, { configurable: { ...config.configurable, user_id: "eva" } })).rejects.toThrow("isn't connected");
    db.close();
  });
});
