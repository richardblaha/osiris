import { spawn } from "node:child_process";
import { localAgent } from "@osiris/client/agent.ts";
import { freshToken, requestTokens, signInUrl, type OidcTokens } from "@osiris/client/oidc.ts";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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

type Credentials = Record<string, OidcTokens>;
const readCredentials = (): Credentials => {
  try {
    return JSON.parse(readFileSync(credentialsFile(), "utf8")) as Credentials;
  } catch {
    return {};
  }
};
/** Writes the credentials file readable by its owner only (`mode` alone wouldn't tighten an existing file). */
const writeCredentials = (c: Credentials) => {
  mkdirSync(configDir(), { recursive: true, mode: 0o700 });
  writeFileSync(credentialsFile(), JSON.stringify(c, null, 2), { mode: 0o600 });
  chmodSync(credentialsFile(), 0o600);
};
const save = (server: string) => (tokens: OidcTokens) => writeCredentials({ ...readCredentials(), [server]: tokens });

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
  const http = createServer();
  await new Promise<void>((r) => http.listen(0, "127.0.0.1", r));
  const redirect = `http://127.0.0.1:${(http.address() as { port: number }).port}/callback`;
  const { url, verifier, state } = await signInUrl(server, CLIENT_ID, redirect);
  const code = await new Promise<string>((done, fail) => {
    http.on("request", (req, res) => {
      const back = new URL(req.url ?? "/", "http://127.0.0.1");
      if (back.pathname !== "/callback") return void res.writeHead(404).end();
      const ok = back.searchParams.get("state") === state && back.searchParams.get("code");
      res.writeHead(ok ? 200 : 400, { "content-type": "text/html; charset=utf-8" }).end(ok ? "<p>Osiris: signed in, back to the terminal.</p>" : "<p>Osiris: sign-in failed.</p>");
      http.close();
      ok ? done(back.searchParams.get("code")!) : fail(new Error(back.searchParams.get("error_description") ?? "Sign-in failed"));
    });
    log(`Sign in in your browser: ${url}`);
    openBrowser(url);
  });
  save(server)(await requestTokens(server, CLIENT_ID, { grant_type: "authorization_code", code, redirect_uri: redirect, code_verifier: verifier }));
  log(`Signed in to ${server}.`);
}

/** A connection to osiris-server with the stored sign-in, refreshed when it's about to expire. */
export function connectServer(server: string): Connection {
  server = server.replace(/\/$/, "");
  return {
    url: server,
    locale,
    token: () => freshToken(server, CLIENT_ID, readCredentials()[server], save(server)),
    async signIn() {
      throw new Error(`Not signed in to ${server}: run \`osiris-cli login ${server}\`.`);
    },
  };
}

export function logout(server: string) {
  const c = readCredentials();
  delete c[server.replace(/\/$/, "")];
  writeCredentials(c);
}
