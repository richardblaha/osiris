import { once } from "node:events";
import { createServer, type AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { tunnel } from "@osiris/core/net/egress.ts";
import { assertSafePublicUrl } from "@osiris/core/mcp/url.ts";
import { admit, createEgressProxy, createForwarder, parseAuthority } from "../src/gate.ts";
import { containerKey, containerPlan, insideContainer, type ContainerPlanInput } from "../src/launcher.ts";

const servers: { close(): unknown }[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.close();
  delete process.env.OSIRIS_EGRESS_PROXY;
});

async function listening<T extends { listen(port: number, host: string): unknown; address(): unknown; close(): unknown }>(server: T) {
  server.listen(0, "127.0.0.1");
  await once(server as never, "listening");
  servers.push(server);
  return (server.address() as AddressInfo).port;
}

/** A TCP server that answers each line with "echo:<line>". */
const echo = () =>
  createServer((s) => {
    s.on("data", (d) => s.write(`echo:${d}`));
    s.on("error", () => {});
  });

describe("the gate's egress proxy", () => {
  it("parses CONNECT destinations", () => {
    expect(parseAuthority("api.mistral.ai:443")).toEqual({ host: "api.mistral.ai", port: 443 });
    expect(parseAuthority("[2001:db8::1]:993")).toEqual({ host: "2001:db8::1", port: 993 });
    expect(parseAuthority("evil.com")).toBeUndefined();
    expect(parseAuthority("a b:443")).toBeUndefined();
    expect(parseAuthority("x:70000")).toBeUndefined();
  });

  it("admits public addresses only, checking every address a name resolves to, unless excepted", async () => {
    const lookup = async (host: string) => ({ "public.example": ["93.184.215.14"], "rebind.example": ["93.184.215.14", "10.0.0.5"], "meta.example": ["169.254.169.254"] })[host] ?? [];
    expect(await admit("public.example", 443, { lookup })).toEqual({ address: "93.184.215.14" });
    expect(await admit("rebind.example", 443, { lookup })).toEqual({ refused: "private address" });
    expect(await admit("meta.example", 80, { lookup })).toEqual({ refused: "private address" });
    expect(await admit("127.0.0.1", 22, { lookup })).toEqual({ refused: "private address" });
    expect(await admit("nowhere.example", 443, { lookup })).toEqual({ refused: "unresolved" });
    expect(await admit("127.0.0.1", 11434, { lookup, allow: ["127.0.0.1:11434"] })).toEqual({ address: "127.0.0.1" });
    expect(await admit("127.0.0.1", 22, { lookup, allow: ["127.0.0.1:11434"] })).toEqual({ refused: "private address" });
  });

  it("tunnels an allowed destination and refuses the rest, also to the agent's own tunnel()", async () => {
    const target = await listening(echo());
    const log: string[] = [];
    const proxyPort = await listening(createEgressProxy({ allow: [`127.0.0.1:${target}`], log: (l) => log.push(l) }));
    const proxy = new URL(`http://127.0.0.1:${proxyPort}`);

    const socket = await tunnel("127.0.0.1", target, { proxy });
    socket.write("ahoj");
    const [answer] = await once(socket, "data");
    expect(String(answer)).toBe("echo:ahoj");
    socket.destroy();
    expect(log).toEqual([`CONNECT 127.0.0.1:${target} (127.0.0.1)`]);

    await expect(tunnel("127.0.0.1", target + 1 === 65536 ? 1 : target + 1, { proxy })).rejects.toThrow(/refused.*403/);
    await expect(tunnel("localhost", 22, { proxy })).rejects.toThrow(/refused/);
  });

  it("refuses plain-http proxying", async () => {
    const proxyPort = await listening(createEgressProxy({ log: () => {} }));
    const res = await fetch(`http://127.0.0.1:${proxyPort}/http://example.com/`);
    expect(res.status).toBe(405);
  });

  it("forwards the agent's port", async () => {
    const agent = await listening(echo());
    const port = await listening(createForwarder("127.0.0.1", agent));
    const { connect } = await import("node:net");
    const s = connect({ host: "127.0.0.1", port });
    s.write("x");
    expect(String((await once(s, "data"))[0])).toBe("echo:x");
    s.destroy();
  });
});

describe("URL checks behind the gate", () => {
  it("leave names to the gate, but still refuse private addresses written in the URL", async () => {
    process.env.OSIRIS_EGRESS_PROXY = "http://gate:3128";
    await expect(assertSafePublicUrl("https://name-that-does-not-resolve.invalid/x")).resolves.toBeInstanceOf(URL);
    await expect(assertSafePublicUrl("https://169.254.169.254/latest")).rejects.toThrow(/private/);
    await expect(assertSafePublicUrl("http://example.com/")).rejects.toThrow(/https/);
  });
});

describe("the container plan", () => {
  const input: ContainerPlanInput = {
    cli: "docker",
    image: "ghcr.io/richardblaha/osiris-local:1.0.0",
    root: "/home/ana/Zakázky",
    projectId: "zakazky",
    projectName: "Zakázky",
    hostPort: 7777,
    uid: 1000,
    gid: 1000,
    user: { login: "ana", name: "Ana Nováková", email: "ana@example.com" },
    launcherPid: 4242,
    secretEnv: ["OSIRIS_PROJECT_KEY", "MISTRAL_API_KEY"],
    egressAllow: [],
  };

  it("puts the agent on an internal network with the gate as its only door, hardened, with only the folder mounted", () => {
    const plan = containerPlan(input);
    const key = containerKey(input.root, "zakazky");
    expect(key).toMatch(/^zakazky-[0-9a-f]{8}$/);
    expect(containerKey("/elsewhere/Zakázky", "zakazky")).not.toBe(key);
    expect(plan.network).toEqual(["docker", "network", "create", "--internal", "--label", `osiris.project=${key}`, `osiris-${key}`]);

    const agent = plan.agent.join(" ");
    expect(agent).toContain(`--network osiris-${key}`);
    expect(agent).not.toMatch(/ -p /);
    for (const opt of ["--read-only", "--cap-drop ALL", "--security-opt no-new-privileges", "--user 1000:1000", "--pids-limit 512"]) expect(agent).toContain(opt);
    expect(plan.agent.filter((a) => a.includes(":/project"))).toEqual(["/home/ana/Zakázky:/project"]);
    expect(agent).toContain("HTTPS_PROXY=http://gate:3128");
    expect(agent).toContain("NODE_USE_ENV_PROXY=1");

    // The port is published by the gate, on the host's loopback only.
    expect(plan.gate.join(" ")).toContain("-p 127.0.0.1:7777:7777");
    expect(plan.connectGate).toEqual(["docker", "network", "connect", "--alias", "gate", `osiris-${key}`, `osiris-gate-${key}`]);
  });

  it("never puts a secret's value on a command line, only its name", () => {
    const plan = containerPlan(input);
    const i = plan.agent.indexOf("OSIRIS_PROJECT_KEY");
    expect(plan.agent[i - 1]).toBe("-e");
    expect(plan.agent).toContain("MISTRAL_API_KEY");
    expect(plan.agent.some((a) => a.startsWith("OSIRIS_PROJECT_KEY=") || a.startsWith("MISTRAL_API_KEY="))).toBe(false);
  });

  it("keeps the user's ids under rootless podman", () => {
    expect(containerPlan({ ...input, cli: "podman" }).agent.join(" ")).toContain("--userns keep-id");
    expect(containerPlan(input).agent).not.toContain("--userns");
  });

  it("knows when it runs in a container already", () => {
    expect(insideContainer({}, () => false)).toBe(false);
    expect(insideContainer({}, (p) => p === "/.dockerenv")).toBe(true);
    expect(insideContainer({ REMOTE_CONTAINERS: "true" }, () => false)).toBe(true);
    expect(insideContainer({ CODESPACES: "true" }, () => false)).toBe(true);
  });
});
