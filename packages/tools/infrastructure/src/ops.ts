import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { getRunContext, type RunContext } from "@osiris/core/agent/context.ts";
import type { QuestionStore } from "@osiris/core/agent/questions.ts";
import { cephReads, commandLine, kubectlReads } from "./commands.ts";

/** Where the twin's ops API is and how this runtime proves which project it is. */
export interface OpsClient {
  url: string;
  token: () => Promise<string>;
  fetch?: typeof fetch;
}

interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  truncated: boolean;
}

/** How much of a command's output goes back to the model. */
const MODEL_OUTPUT = 12_000;

const FIELD = "confirm";
const title = "Spustit příkaz v clusteru?";

/**
 * The user's yes or no to exactly this command, from the question they answered, never from the model's arguments:
 * only the newest question counts, only when it names this command, and only once (a yes runs the command once).
 */
async function decision(questions: QuestionStore, ctx: RunContext, line: string): Promise<boolean | "waiting" | "missing"> {
  const q = await questions.latest(ctx.user_id, ctx.thread_id);
  if (!q || q.taken || q.title !== title || q.fields.length !== 1 || q.fields[0]?.name !== FIELD || q.fields[0]?.label !== line) return "missing";
  if (q.state === "open") return "waiting";
  if (q.state === "expired") return "missing";
  const values = await questions.take(ctx.user_id, ctx.thread_id, q.id);
  if (values === null) return "missing";
  return values[FIELD] === true;
}

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
 * A command-line tool of the cluster (kubectl, ceph), run by the digital twin's service. Reads run at once; anything
 * else becomes a yes/no question in the chat naming the exact command, and runs only after the user's yes, when the
 * agent calls the tool again with the same arguments.
 */
function commandTool(client: OpsClient, questions: QuestionStore, program: "kubectl" | "ceph", reads: (args: string[]) => boolean, description: string) {
  return tool(
    async ({ args, stdin }, config) => {
      const ctx = getRunContext(config);
      if (!reads(args)) {
        const line = commandLine(program, args) + (stdin ? ` (+ vstup ${stdin.length} znaků)` : "");
        const answer = await decision(questions, ctx, line);
        if (answer === "missing")
          return JSON.stringify({ question: await questions.create(ctx.user_id, ctx.thread_id, { title, fields: [{ name: FIELD, label: line, type: "boolean", required: true }] }) });
        if (answer === "waiting") return "Uživatel na schválení příkazu ještě neodpověděl. Počkej na jeho odpověď.";
        if (!answer) return "Uživatel spuštění příkazu zamítl. Nespouštěj ho a zeptej se, co dál.";
      }
      return call(client, program, args, stdin);
    },
    {
      name: program,
      description,
      schema: z.object({
        args: z.array(z.string()).min(1).max(80).describe("Argumenty příkazu, každý zvlášť (bez názvu programu)"),
        stdin: z.string().max(1_000_000).optional().describe("Vstup příkazu, např. YAML pro `apply -f -`"),
      }),
    },
  );
}

export const kubectlTool = (client: OpsClient, questions: QuestionStore) =>
  commandTool(
    client,
    questions,
    "kubectl",
    kubectlReads,
    "Správa Kubernetes clusteru (busiris) příkazem kubectl jako administrátor. Argumenty předej jako pole, např. [\"get\", \"pods\", \"-A\", \"-o\", \"wide\"]; " +
      "API přímo: [\"get\", \"--raw\", \"/apis\"]. Čtení (get, describe, logs, top, events, explain, auth can-i, rollout status, --dry-run) proběhne hned. " +
      "Každá změna (apply, create, delete, patch, scale, rollout restart, cordon, drain, label, exec…) se nejdřív zeptá uživatele; když odpoví, zavolej nástroj znovu se stejnými argumenty. " +
      "YAML pro apply předej ve stdin s argumenty [\"apply\", \"-f\", \"-\"]. Nejde: edit, port-forward, proxy, exec -it, vlastní --kubeconfig/--as. " +
      "Cluster je microk8s (kubeadm se v něm nepoužívá; uzly a jejich upgrade spravuje microk8s na hostitelích).",
  );

export const cephTool = (client: OpsClient, questions: QuestionStore) =>
  commandTool(
    client,
    questions,
    "ceph",
    cephReads,
    "Správa úložiště Ceph (microceph na uzlech clusteru) příkazem ceph jako client.admin. Argumenty jako pole, např. [\"status\"], [\"osd\", \"tree\"], [\"df\", \"detail\"], [\"osd\", \"pool\", \"ls\", \"detail\"]; " +
      "pro strojové zpracování přidej [\"--format\", \"json\"]. Čtení (status, health, df, osd tree/df/ls, pg, mon, mgr, fs, config get…) proběhne hned; " +
      "každá změna (osd out/in/reweight, pool create/set/delete, config set, mgr module enable, auth…) se nejdřív zeptá uživatele; po odpovědi zavolej nástroj znovu se stejnými argumenty. " +
      "Příkazy microceph (správa uzlů a disků microcephu) se spouštějí na hostitelích, ne odsud.",
  );
