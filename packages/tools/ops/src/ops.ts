import { tool } from "@langchain/core/tools";
import { z } from "zod";

/** Where the twin's ops API is and how this runtime proves which project it is. */
export interface OpsClient {
  url: string;
  token: () => Promise<string>;
  fetch?: typeof fetch;
}

/** The twin's ops API and the projects whose agents run commands through it. */
export interface OpsOptions {
  ops: OpsClient;
  projects: string[];
}

interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  truncated: boolean;
}

/** How much of a command's output goes back to the model. */
const MODEL_OUTPUT = 12_000;

async function call(client: OpsClient, program: "kubectl" | "ceph", args: string[], stdin?: string): Promise<string> {
  const res = await (client.fetch ?? fetch)(`${client.url.replace(/\/$/, "")}/ops/${program}`, {
    method: "POST",
    headers: { authorization: `Bearer ${await client.token()}`, "content-type": "application/json" },
    body: JSON.stringify({ args, stdin }),
    signal: AbortSignal.timeout(150_000),
  });
  if (res.status === 400) {
    const body = (await res.json().catch(() => ({}))) as { refused?: string; error?: string };
    return `Příkaz odmítnut: ${body.refused ?? body.error ?? "neplatný požadavek"}`;
  }
  if (!res.ok) return `Služba pro správu clusteru odpověděla ${res.status}: ${(await res.text()).slice(0, 300)}`;
  const r = (await res.json()) as CommandResult;
  const cut = (s: string) => (s.length > MODEL_OUTPUT ? `${s.slice(0, MODEL_OUTPUT)}\n… (zkráceno, celkem ${s.length} znaků)` : s);
  return [`exit ${r.exitCode}`, r.stdout && cut(r.stdout), r.stderr && `stderr:\n${cut(r.stderr)}`, r.truncated && "(výstup byl na straně služby zkrácen)"].filter(Boolean).join("\n");
}

/**
 * A command-line tool of the cluster (kubectl, ceph), run by the digital twin's ops API. The agent only reads: a
 * call that would change something is refused here, and the twin refuses it again (its account can't change anything
 * either).
 */
function commandTool(client: OpsClient, program: "kubectl" | "ceph", reads: (args: string[]) => boolean, description: string) {
  return tool(
    async ({ args, stdin }) => {
      if (!reads(args)) return `Odmítnuto: ${commandLine(program, args)} by měnil cluster a přístup je jen pro čtení. Navrhni změnu uživateli slovy, sám ji nespouštěj.`;
      return call(client, program, args, stdin);
    },
    {
      name: program,
      description,
      schema: z.object({
        args: z.array(z.string()).min(1).max(80).describe("Argumenty příkazu, každý zvlášť (bez názvu programu)"),
        stdin: z.string().max(1_000_000).optional().describe("Vstup příkazu, např. YAML pro `apply -f - --dry-run=client`"),
      }),
    },
  );
}

/** A command as people read it, for the question that asks to run it. */
export const commandLine = (program: string, args: string[]) =>
  [program, ...args.map((a) => (/^[\w./:=@,+-]+$/.test(a) ? a : `'${a.replace(/'/g, "'\\''")}'`))].join(" ");

export { commandTool };
