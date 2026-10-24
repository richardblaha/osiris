import { createHash, randomBytes } from "node:crypto";
import * as vscode from "vscode";
import { localAgent, projectRoot } from "@osiris/client/agent.ts";

export const CLIENT_ID = "osiris-vscode";
/** Where the server sends the browser back after signing in: VS Code's URI handler for this extension. */
const CALLBACK = "vscode://osiris.osiris-vscode/callback";

/** What the panel connects to: the agent over the workspace folder, or a server's project. */
export interface PanelConnection {
  mode: "local" | "server";
  /** The address the webview can reach (forwarded out of a devcontainer). */
  url: string;
  label: string;
  project?: string;
}

type Tokens = { accessToken: string; refreshToken: string; expiresAt: number };
const tokensKey = (server: string) => `osiris.tokens:${server}`;
const config = () => vscode.workspace.getConfiguration("osiris");
const serverUrl = () => config().get<string>("server", "").trim().replace(/\/$/, "");

/** The agent's command from the setting: a command on PATH, or a `bin/osiris.mjs` run with Node. */
export function agentCommand(setting: string): string[] {
  return setting.endsWith(".mjs") ? ["node", setting] : [setting || "osiris"];
}

/** The panel in the secondary side bar: a webview with the chat, talking to the agent or the server directly. */
class ChatView implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  private connection?: PanelConnection;
  private localToken?: string;
  private pendingLogin?: { server: string; state: string; verifier: string; done: (code: string) => void };
  private readonly queue: unknown[] = [];

  constructor(private readonly context: vscode.ExtensionContext, private readonly log: vscode.OutputChannel) {}

  resolveWebviewView(view: vscode.WebviewView) {
    this.view = view;
    view.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, "dist")] };
    view.webview.onDidReceiveMessage((m) => void this.onMessage(m));
    void this.connect();
  }

  /** Sends to the webview, or holds it until the webview is there. */
  post(message: unknown) {
    if (this.view) void this.view.webview.postMessage(message);
    else this.queue.push(message);
  }

  async connect() {
    if (!this.view) return;
    try {
      this.connection = await this.resolve();
      this.render();
    } catch (err) {
      this.connection = undefined;
      this.render((err as Error).message);
    }
  }

  private async resolve(): Promise<PanelConnection> {
    const server = serverUrl();
    if (server) return { mode: "server", url: server, label: new URL(server).host, project: config().get<string>("project") || undefined };
    const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!folder) throw new Error("Open a folder: Osiris works over a project folder.");
    const root = projectRoot(folder);
    const agent = await localAgent(root, agentCommand(config().get<string>("agentPath", "osiris")), { log: (l) => this.log.appendLine(l) });
    this.localToken = agent.token;
    // Out of a devcontainer or a remote, the agent's port is forwarded and the webview gets the forwarded address.
    const external = await vscode.env.asExternalUri(vscode.Uri.parse(agent.url));
    return { mode: "local", url: external.toString(true).replace(/\/$/, ""), label: root.split(/[\\/]/).at(-1) ?? root };
  }

  private render(error?: string) {
    const view = this.view!;
    const nonce = randomBytes(16).toString("base64");
    const dist = (file: string) => view.webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, "dist", file));
    const connect = this.connection ? new URL(this.connection.url).origin : "";
    view.webview.html = `<!doctype html>
<html lang="${vscode.env.language}">
<head>
<meta charset="utf-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${view.webview.cspSource} 'unsafe-inline'; font-src ${view.webview.cspSource}; img-src ${view.webview.cspSource} data:; script-src 'nonce-${nonce}'; connect-src ${connect};" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<link rel="stylesheet" href="${dist("webview.css")}" />
</head>
<body>
<div id="root"></div>
<script nonce="${nonce}">window.OSIRIS = ${JSON.stringify({ connection: this.connection ?? null, error: error ?? null, language: vscode.env.language }).replace(/</g, "\\u003c")};</script>
<script nonce="${nonce}" src="${dist("webview.js")}"></script>
</body>
</html>`;
    for (const m of this.queue.splice(0)) void view.webview.postMessage(m);
  }

  private async onMessage(m: { type: string; id?: number }) {
    if (m.type === "token") {
      const token = this.connection?.mode === "server" ? await this.serverToken(this.connection.url) : this.localToken;
      void this.view?.webview.postMessage({ type: "token", id: m.id, token: token ?? null });
    } else if (m.type === "signIn" && this.connection?.mode === "server") await this.login(this.connection.url);
    else if (m.type === "connectServer") await vscode.commands.executeCommand("osiris.connectServer");
    else if (m.type === "useLocal") await vscode.commands.executeCommand("osiris.useLocal");
    else if (m.type === "retry") await this.connect();
  }

  /** The server's access token, refreshed when it's about to expire; undefined when not signed in. */
  private async serverToken(server: string): Promise<string | undefined> {
    const raw = await this.context.secrets.get(tokensKey(server));
    if (!raw) return undefined;
    const t = JSON.parse(raw) as Tokens;
    if (t.expiresAt - 60_000 > Date.now()) return t.accessToken;
    return this.tokenRequest(server, { grant_type: "refresh_token", refresh_token: t.refreshToken }).catch(() => undefined);
  }

  private async tokenRequest(server: string, params: Record<string, string>): Promise<string> {
    const { token_endpoint } = (await (await fetch(`${server}/auth/.well-known/openid-configuration`)).json()) as { token_endpoint: string };
    const res = await fetch(token_endpoint, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ client_id: CLIENT_ID, ...params }) });
    const body = (await res.json()) as { access_token?: string; refresh_token?: string; expires_in?: number; error_description?: string };
    if (!res.ok || !body.access_token) throw new Error(body.error_description ?? `Sign-in failed (${res.status})`);
    const previous = await this.context.secrets.get(tokensKey(server));
    const refreshToken = body.refresh_token ?? (previous ? (JSON.parse(previous) as Tokens).refreshToken : "");
    await this.context.secrets.store(tokensKey(server), JSON.stringify({ accessToken: body.access_token, refreshToken, expiresAt: Date.now() + (body.expires_in ?? 600) * 1000 } satisfies Tokens));
    return body.access_token;
  }

  /** Signs in at the server in the browser (PKCE); the server sends the browser back to VS Code's URI handler. */
  async login(server: string) {
    const { authorization_endpoint } = (await (await fetch(`${server}/auth/.well-known/openid-configuration`)).json()) as { authorization_endpoint: string };
    const verifier = randomBytes(32).toString("base64url");
    const state = randomBytes(16).toString("base64url");
    const code = await new Promise<string>((done) => {
      this.pendingLogin = { server, state, verifier, done };
      const url = `${authorization_endpoint}?${new URLSearchParams({
        client_id: CLIENT_ID,
        redirect_uri: CALLBACK,
        response_type: "code",
        scope: "openid profile email",
        code_challenge: createHash("sha256").update(verifier).digest("base64url"),
        code_challenge_method: "S256",
        state,
      })}`;
      void vscode.env.openExternal(vscode.Uri.parse(url));
    });
    await this.tokenRequest(server, { grant_type: "authorization_code", code, redirect_uri: CALLBACK, code_verifier: verifier });
    void vscode.window.showInformationMessage(`Osiris: signed in to ${new URL(server).host}.`);
    await this.connect();
  }

  /** Back from the browser: `vscode://osiris.osiris-vscode/callback?code=…&state=…`. */
  handleUri(uri: vscode.Uri) {
    const params = new URLSearchParams(uri.query);
    if (uri.path !== "/callback" || !this.pendingLogin || params.get("state") !== this.pendingLogin.state) return;
    const code = params.get("code");
    if (code) this.pendingLogin.done(code);
    else void vscode.window.showErrorMessage(`Osiris: ${params.get("error_description") ?? "sign-in failed"}`);
    this.pendingLogin = undefined;
  }
}

export function activate(context: vscode.ExtensionContext) {
  const log = vscode.window.createOutputChannel("Osiris");
  const view = new ChatView(context, log);
  const reveal = () => vscode.commands.executeCommand("osiris.chat.focus");
  context.subscriptions.push(
    log,
    vscode.window.registerWebviewViewProvider("osiris.chat", view, { webviewOptions: { retainContextWhenHidden: true } }),
    vscode.window.registerUriHandler(view),
    vscode.commands.registerCommand("osiris.open", reveal),
    vscode.commands.registerCommand("osiris.newChat", async () => (await reveal(), view.post({ type: "newChat" }))),
    vscode.commands.registerCommand("osiris.askSelection", async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor || editor.selection.isEmpty) return;
      const path = vscode.workspace.asRelativePath(editor.document.uri);
      const { start, end } = editor.selection;
      const text = `${path}:${start.line + 1}-${end.line + 1}\n\`\`\`${editor.document.languageId}\n${editor.document.getText(editor.selection)}\n\`\`\`\n\n`;
      await reveal();
      view.post({ type: "prompt", text });
    }),
    vscode.commands.registerCommand("osiris.connectServer", async () => {
      const url = await vscode.window.showInputBox({ prompt: "Osiris server", placeHolder: "https://osiris.k6labs.cz", value: serverUrl(), validateInput: (v) => (/^https?:\/\/\S+$/.test(v.trim()) ? null : "An http(s) address") });
      if (!url) return;
      const server = url.trim().replace(/\/$/, "");
      await config().update("server", server, vscode.ConfigurationTarget.Global);
      await view.login(server).catch((err: Error) => vscode.window.showErrorMessage(`Osiris: ${err.message}`));
    }),
    vscode.commands.registerCommand("osiris.useLocal", async () => {
      await config().update("server", "", vscode.ConfigurationTarget.Global);
    }),
    vscode.workspace.onDidChangeConfiguration((e) => e.affectsConfiguration("osiris") && void view.connect()),
  );
}

export function deactivate() {}
