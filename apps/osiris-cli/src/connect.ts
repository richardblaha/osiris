import { spawn } from "node:child_process";
import { localAgent } from "@osiris/client/agent.ts";
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Connection } from "@osiris/client/api.ts";

export const CLIENT_ID = "osiris-cli";
const configDir = () => join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "osiris");
const credentialsFile = () => join(configDir(), "credentials.json");

/** The local agent's command: the workspace's `osiris` next to this client, or one on PATH. */
function agentCommand(): string[] {
  try {
    return [process.execPath, createRequire(import.meta.url).resolve("@osiris/agent/bin/osiris.mjs")];
  } catch {
    return ["osiris"];
  }
}

/** Connects to the agent over `root` (the one running there, else a new one in the background). */
export async function connectLocal(root: string, log: (line: string) => void = () => {}): Promise<{ connection: Connection; url: string }> {
  const agent = await localAgent(root, agentCommand(), { log });
  return { url: agent.url, connection: { url: agent.url, token: async () => agent.token, locale: () => locale() } };
}

/** The terminal's language for the server's messages: Czech for Czech and Slovak, else English. */
export const locale = () => (/^(cs|sk)/i.test(process.env.LC_ALL ?? process.env.LC_MESSAGES ?? process.env.LANG ?? "") ? "cs" : "en");

interface Credentials {
  [server: string]: { accessToken: string; refreshToken: string; expiresAt: number };
}
const readCredentials = (): Credentials => {
  try {
    return JSON.parse(readFileSync(credentialsFile(), "utf8")) as Credentials;
  } catch {
    return {};
  }
};
const saveCredentials = (c: Credentials) => {
  mkdirSync(configDir(), { recursive: true, mode: 0o700 });
  writeFileSync(credentialsFile(), JSON.stringify(c, null, 2), { mode: 0o600 });
};

const discovery = async (server: string) =>
  (await (await fetch(`${server}/auth/.well-known/openid-configuration`)).json()) as { authorization_endpoint: string; token_endpoint: string };

async function tokenRequest(server: string, params: Record<string, string>) {
  const res = await fetch((await discovery(server)).token_endpoint, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ client_id: CLIENT_ID, ...params }) });
  const body = (await res.json()) as { access_token?: string; refresh_token?: string; expires_in?: number; error_description?: string; error?: string };
  if (!res.ok || !body.access_token) throw new Error(`Sign-in failed: ${body.error_description ?? body.error ?? res.status}`);
  const c = readCredentials();
  c[server] = { accessToken: body.access_token, refreshToken: body.refresh_token ?? c[server]?.refreshToken ?? "", expiresAt: Date.now() + (body.expires_in ?? 600) * 1000 };
  saveCredentials(c);
}

/** Opens a URL in the user's browser (and prints it, for a terminal without one). */
function openBrowser(url: string) {
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open";
  try {
    spawn(cmd, [url], { detached: true, stdio: "ignore" }).unref();
  } catch {
    // No browser here: the printed link is enough.
  }
}

/**
 * Signs in to osiris-server like a native app (RFC 8252): the browser signs in at the server, which sends it back to
 * a port of our own on 127.0.0.1 with a code; the code and our PKCE verifier get the tokens.
 */
export async function login(server: string, log: (line: string) => void = console.log): Promise<void> {
  server = server.replace(/\/$/, "");
  const { authorization_endpoint } = await discovery(server);
  const verifier = randomBytes(32).toString("base64url");
  const state = randomBytes(16).toString("base64url");
  const { code, redirect } = await new Promise<{ code: string; redirect: string }>((done, fail) => {
    const http = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (url.pathname !== "/callback") return void res.writeHead(404).end();
      const ok = url.searchParams.get("state") === state && url.searchParams.get("code");
      res.writeHead(ok ? 200 : 400, { "content-type": "text/html; charset=utf-8" }).end(ok ? "<p>Osiris: signed in, back to the terminal.</p>" : "<p>Osiris: sign-in failed.</p>");
      http.close();
      ok ? done({ code: url.searchParams.get("code")!, redirect: `http://127.0.0.1:${port}/callback` }) : fail(new Error(url.searchParams.get("error_description") ?? "Sign-in failed"));
    });
    let port = 0;
    http.listen(0, "127.0.0.1", () => {
      port = (http.address() as { port: number }).port;
      const url = `${authorization_endpoint}?${new URLSearchParams({
        client_id: CLIENT_ID,
        redirect_uri: `http://127.0.0.1:${port}/callback`,
        response_type: "code",
        scope: "openid profile email",
        code_challenge: createHash("sha256").update(verifier).digest("base64url"),
        code_challenge_method: "S256",
        state,
      })}`;
      log(`Sign in in your browser: ${url}`);
      openBrowser(url);
    });
  });
  await tokenRequest(server, { grant_type: "authorization_code", code, redirect_uri: redirect, code_verifier: verifier });
  log(`Signed in to ${server}.`);
}

/** A connection to osiris-server with the stored sign-in, refreshed when it's about to expire. */
export function connectServer(server: string): Connection {
  server = server.replace(/\/$/, "");
  return {
    url: server,
    locale,
    async token() {
      const c = readCredentials()[server];
      if (!c) return null;
      if (c.expiresAt - 60_000 > Date.now()) return c.accessToken;
      await tokenRequest(server, { grant_type: "refresh_token", refresh_token: c.refreshToken }).catch(() => undefined);
      const fresh = readCredentials()[server];
      return fresh && fresh.expiresAt > Date.now() ? fresh.accessToken : null;
    },
    async signIn() {
      throw new Error(`Not signed in to ${server}: run \`osiris-cli login ${server}\`.`);
    },
  };
}

export function logout(server: string) {
  const c = readCredentials();
  delete c[server.replace(/\/$/, "")];
  saveCredentials(c);
}
