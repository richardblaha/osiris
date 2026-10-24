import { existsSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import * as vscode from "vscode";
import { localAgent, projectRoot } from "@osiris/client/agent.ts";
import { freshToken, requestTokens, signInUrl, type OidcTokens } from "@osiris/client/oidc.ts";

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

const tokensKey = (server: string) => `osiris.tokens:${server}`;
const config = () => vscode.workspace.getConfiguration("osiris");
const serverUrl = () => config().get<string>("server", "").trim().replace(/\/$/, "");

/** The agent's command from the setting: a command on PATH, or a `bin/osiris.mjs` run with Node. */
export function agentCommand(setting: string): string[] {
  return setting.endsWith(".mjs") ? ["node", setting] : [setting || "osiris"];
}

/** A folder that isn't an Osiris project yet. */
class NotStarted extends Error {
  constructor(readonly folder: string) {
    super(`No Osiris project in ${folder}`);
  }
}

/** The panel in the secondary side bar: a webview with the chat, talking to the agent or the server directly. */
class ChatView implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  private connection?: PanelConnection;
  private localToken?: string;
  private pendingLogin?: { state: string; done: (code: string) => void };
  /** Set by the panel's "Start Osiris in this folder": a folder without `.osiris/` gets an agent only on request. */
  private start = false;
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
      if (err instanceof NotStarted) this.render(undefined, err.folder);
      else this.render((err as Error).message);
    }
  }

  private async resolve(): Promise<PanelConnection> {
    const server = serverUrl();
    if (server) return { mode: "server", url: server, label: new URL(server).host, project: config().get<string>("project") || undefined };
    const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!folder) throw new Error("Open a folder: Osiris works over a project folder.");
    const root = projectRoot(folder);
    // Opening a folder doesn't make it a project: no .osiris/, no agent until the user asks.
    if (!existsSync(join(root, ".osiris")) && !this.start) throw new NotStarted(root);
    const agent = await localAgent(root, agentCommand(config().get<string>("agentPath", "osiris")), { log: (l) => this.log.appendLine(l) });
    this.localToken = agent.token;
    // Out of a devcontainer or a remote, the agent's port is forwarded and the webview gets the forwarded address.
    const external = await vscode.env.asExternalUri(vscode.Uri.parse(agent.url));
    return { mode: "local", url: external.toString(true).replace(/\/$/, ""), label: root.split(/[\\/]/).at(-1) ?? root };
  }

  private render(error?: string, startable?: string) {
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
<script nonce="${nonce}">window.OSIRIS = ${JSON.stringify({ connection: this.connection ?? null, error: error ?? null, startable: startable ?? null, language: vscode.env.language }).replace(/</g, "\\u003c")};</script>
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
    else if (m.type === "start") {
      this.start = true;
      await this.connect();
    }
  }

  /** The server's access token, refreshed when it's about to expire; undefined when not signed in. */
  private async serverToken(server: string): Promise<string | undefined> {
    const raw = await this.context.secrets.get(tokensKey(server));
    return freshToken(server, CLIENT_ID, raw ? (JSON.parse(raw) as OidcTokens) : undefined, async (t) => void (await this.context.secrets.store(tokensKey(server), JSON.stringify(t))));
  }

  /** Signs in at the server in the browser (PKCE); the server sends the browser back to VS Code's URI handler. */
  async login(server: string) {
    const { url, verifier, state } = await signInUrl(server, CLIENT_ID, CALLBACK);
    const code = await new Promise<string>((done) => {
      this.pendingLogin = { state, done };
      void vscode.env.openExternal(vscode.Uri.parse(url));
    });
    const tokens = await requestTokens(server, CLIENT_ID, { grant_type: "authorization_code", code, redirect_uri: CALLBACK, code_verifier: verifier });
    await this.context.secrets.store(tokensKey(server), JSON.stringify(tokens));
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
