import type { RunEvent, ThreadMessage } from "@osiris/shared";
import type { Alert, Investigator } from "./engine.ts";

/**
 * Osiris's gateway as the alerts service talks to it: as its own service account (osiris-auth's client credentials:
 * the app `ALERTS_CLIENT_ID` acts as that account, a member of the twin's project), never as a person. The token is
 * fetched when needed and kept until shortly before it expires.
 */
export class OsirisClient {
  private token?: { value: string; until: number };

  constructor(
    private readonly o: {
      /** Osiris's gateway (https://osiris.k6labs.cz). */
      url: string;
      /** The twin's project there, whose agent investigates. */
      project: string;
      /** osiris-auth: its token endpoint gives the service account's tokens. */
      authUrl: string;
      clientId: string;
      clientSecret: string;
      fetchFn?: typeof fetch;
    },
  ) {}

  private get fetch() {
    return this.o.fetchFn ?? fetch;
  }

  /** A valid access token of the service account. */
  async accessToken(): Promise<string> {
    if (this.token && this.token.until > Date.now()) return this.token.value;
    const res = await this.fetch(`${this.o.authUrl.replace(/\/$/, "")}/token`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        authorization: `Basic ${Buffer.from(`${encodeURIComponent(this.o.clientId)}:${encodeURIComponent(this.o.clientSecret)}`).toString("base64")}`,
      },
      body: new URLSearchParams({ grant_type: "client_credentials" }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`osiris-auth refused the service's token: ${res.status}`);
    const answer = (await res.json()) as { access_token: string; expires_in?: number };
    this.token = { value: answer.access_token, until: Date.now() + Math.max(30, (answer.expires_in ?? 300) - 60) * 1000 };
    return answer.access_token;
  }

  private async call(path: string, init: RequestInit = {}): Promise<Response> {
    const res = await this.fetch(`${this.o.url.replace(/\/$/, "")}/api${path}`, {
      ...init,
      headers: { authorization: `Bearer ${await this.accessToken()}`, "x-project-id": this.o.project, "content-type": "application/json", "accept-language": "cs", ...(init.headers as Record<string, string>) },
    });
    if (!res.ok) throw new Error(`Osiris answered ${path} with ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`);
    return res;
  }

  async createThread(): Promise<string> {
    return ((await (await this.call("/threads", { method: "POST" })).json()) as { id: string }).id;
  }

  async messages(thread: string): Promise<ThreadMessage[]> {
    return (await (await this.call(`/threads/${encodeURIComponent(thread)}/messages`)).json()) as ThreadMessage[];
  }

  /** Runs the agent on a message to the end; its answer's text. */
  async run(thread: string, message: string, signal?: AbortSignal): Promise<string> {
    const res = await this.call(`/threads/${encodeURIComponent(thread)}/runs`, { method: "POST", body: JSON.stringify({ message }), signal });
    let text = "";
    for await (const e of readEvents(res)) {
      if (e.type === "error") throw new Error(e.message);
      if (e.type === "done") break;
      if (e.type === "text-delta") text += e.delta;
      // A tool's text resets what came before: the answer is the text after the last tool.
      if (e.type === "tool-call-start") text = "";
    }
    return text;
  }
}

/** A run's server-sent events. */
async function* readEvents(res: Response): AsyncGenerator<RunEvent> {
  const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return;
    buffer += value;
    const chunks = buffer.split("\n\n");
    buffer = chunks.pop()!;
    for (const chunk of chunks) {
      const data = chunk
        .split("\n")
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).trimStart())
        .join("\n");
      if (data) yield JSON.parse(data) as RunEvent;
    }
  }
}

/** The task the agent gets for an alert (Czech, like the agent's prompts): investigate, explain, propose; change nothing. */
export function alertPrompt(a: Alert): string {
  const where = [
    a.cluster && `cluster ${a.cluster}`,
    a.namespace && `namespace ${a.namespace}`,
    a.workload && `workload ${a.workload}`,
    a.pod && `pod ${a.pod}`,
    a.container && `kontejner ${a.container}`,
    a.node && `node ${a.node}`,
    a.service && `služba ${a.service}`,
  ]
    .filter(Boolean)
    .join(", ");
  return [
    `Alert z digitálního dvojčete (${a.severity.toLowerCase()}${where ? `; ${where}` : ""}), poprvé ${new Date(a.firstSeen).toISOString()}:`,
    "",
    a.message.slice(0, 2000),
    a.traceId ? `\nTrace: ${a.traceId}` : "",
    "",
    "Prozkoumej příčinu: podívej se na události (twin_events), logy a stav dotčených objektů (kubectl, případně ceph). " +
      "Pak napiš krátce: co se stalo, proč, jaký to má dopad a jak to vyřešit (konkrétní kroky a příkazy). " +
      "Nic neměň a nespouštěj žádný měnící příkaz: běžíš automaticky, nikdo ti teď neodpoví; řešení navrhni, schválí ho člověk.",
  ]
    .filter((l) => l !== undefined)
    .join("\n");
}

/** Investigates each alert in a new conversation of the service account, up to `timeoutMs`. */
export function osirisInvestigator(osiris: OsirisClient, timeoutMs = 10 * 60_000): Investigator {
  return {
    async start(alert) {
      const thread = await osiris.createThread();
      const done = osiris.run(thread, alertPrompt(alert), AbortSignal.timeout(timeoutMs)).then(
        (text) => ({ summary: text.trim().slice(0, 600) || undefined }),
        (err: unknown) => ({ error: err instanceof Error ? err.message : String(err) }),
      );
      return { thread, done };
    },
  };
}
