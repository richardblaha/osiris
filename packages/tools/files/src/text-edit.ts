import { Worker } from "node:worker_threads";

/**
 * Deterministic edits of a text for the agent's `edit_text`: an exact replacement that must match a known number of
 * times, a regular expression (in a worker stopped after REGEX_TIMEOUT_MS, against ReDoS), an insertion at a line, or
 * a unified diff. A failure says what went wrong and how to fix the call.
 */

export type TextEdit =
  | { operation: "replace_exact"; search: string; replacement: string; expected_occurrences?: number }
  | { operation: "replace_regex"; pattern: string; flags?: string; replacement: string; max_matches?: number }
  | { operation: "insert_at"; line_number: number; position: "before" | "after"; content: string }
  | { operation: "diff_patch"; patch: string };

export type EditFailure = { success: false; error_code: string; message: string; hint?: string };
export type EditOutcome = { success: true; text: string; diff: string; lines_changed: number } | EditFailure;

const REGEX_TIMEOUT_MS = 200;
const fail = (error_code: string, message: string, hint?: string): EditFailure => ({ success: false, error_code, message, hint });

const eolOf = (text: string) => (text.includes("\r\n") ? "\r\n" : "\n");
/** 1-based line of a character offset. */
const lineAt = (text: string, offset: number) => text.slice(0, offset).split("\n").length;

export async function editText(text: string, edit: TextEdit): Promise<EditOutcome> {
  const result = await apply(text, edit);
  if (typeof result !== "string") return result;
  const diff = unifiedDiff(text, result);
  return { success: true, text: result, diff, lines_changed: diff.split("\n").filter((l) => /^[+-](?![+-]{2} )/.test(l)).length };
}

async function apply(text: string, edit: TextEdit): Promise<string | EditFailure> {
  switch (edit.operation) {
    case "replace_exact": {
      const expected = edit.expected_occurrences ?? 1;
      if (!edit.search) return fail("EMPTY_SEARCH", "Parametr search je prázdný.");
      const at: number[] = [];
      for (let i = text.indexOf(edit.search); i !== -1; i = text.indexOf(edit.search, i + edit.search.length)) at.push(i);
      if (at.length !== expected) {
        const lines = at.slice(0, 10).map((i) => lineAt(text, i));
        return at.length === 0
          ? fail("NOT_FOUND", `Hledaný text nebyl nalezen (očekáváno ${expected}×).`, "Přečti soubor znovu a zkopíruj hledaný blok přesně, včetně mezer a odsazení.")
          : fail(
              "AMBIGUOUS_MATCH",
              `Chyba shody: Hledaný text nalezen ${at.length}×${lines.length ? ` (na řádcích ${lines.join(", ")})` : ""}, ale očekáváno ${expected}×.`,
              "Zahrň do parametru search i několik okolních řádků (kontext), aby byla pozice jednoznačná, nebo uprav expected_occurrences.",
            );
      }
      return text.split(edit.search).join(edit.replacement);
    }
    case "replace_regex": {
      if (/[^imsu]/.test(edit.flags ?? "")) return fail("BAD_FLAGS", "Povolené příznaky jsou jen i, m, s a u.");
      const out = await regexInWorker(text, edit.pattern, `g${edit.flags ?? ""}`, edit.replacement, edit.max_matches);
      return out;
    }
    case "insert_at": {
      const eol = eolOf(text);
      const lines = text.split(eol);
      // A trailing newline isn't a line of its own.
      const count = text.endsWith(eol) ? lines.length - 1 : lines.length;
      if (!Number.isInteger(edit.line_number) || edit.line_number < 1 || edit.line_number > Math.max(count, 1)) {
        return fail("LINE_OUT_OF_RANGE", `Řádek ${edit.line_number} neexistuje, text má ${count} řádků.`, "Použij číslo řádku v rozsahu 1 až počet řádků.");
      }
      const content = edit.content.replace(/\r?\n/g, eol).replace(new RegExp(`${eol}$`), "");
      lines.splice(edit.position === "before" ? edit.line_number - 1 : edit.line_number, 0, content);
      return lines.join(eol);
    }
    case "diff_patch":
      return applyPatch(text, edit.patch);
  }
}

/** A regular expression replacement in a worker, so a catastrophic pattern can't stall the runtime. */
function regexInWorker(text: string, pattern: string, flags: string, replacement: string, max?: number): Promise<string | EditFailure> {
  try {
    new RegExp(pattern, flags);
  } catch (err) {
    return Promise.resolve(fail("BAD_PATTERN", `Neplatný regulární výraz: ${(err as Error).message}`));
  }
  const code = `
    const { parentPort, workerData: w } = require("node:worker_threads");
    const re = new RegExp(w.pattern, w.flags);
    const count = (w.text.match(re) || []).length;
    parentPort.postMessage({ count, text: count && (w.max == null || count <= w.max) ? w.text.replace(re, w.replacement) : null });`;
  return new Promise((resolve) => {
    const worker = new Worker(code, { eval: true, workerData: { text, pattern, flags, replacement, max } });
    let timer: NodeJS.Timeout | undefined;
    const done = (r: string | EditFailure) => (clearTimeout(timer), void worker.terminate(), resolve(r));
    // The limit counts from when the worker runs, not from its start-up.
    worker.once("online", () => {
      timer = setTimeout(
        () => done(fail("REGEX_TIMEOUT", `Regulární výraz běžel déle než ${REGEX_TIMEOUT_MS} ms a byl zastaven.`, "Zjednoduš výraz (bez vnořených opakování jako (a+)+) nebo použij replace_exact.")),
        REGEX_TIMEOUT_MS,
      );
    });
    worker.once("message", ({ count, text: out }: { count: number; text: string | null }) => {
      if (!count) return done(fail("NOT_FOUND", "Výraz v textu nic nenašel.", "Ověř výraz proti aktuálnímu obsahu souboru."));
      if (out === null) return done(fail("TOO_MANY_MATCHES", `Výraz našel ${count} shod, povoleno je nejvýš ${max}.`, "Zpřesni výraz, nebo zvyš max_matches, pokud mají být změněny všechny."));
      done(out);
    });
    worker.once("error", (err: Error) => done(fail("REGEX_FAILED", err.message)));
  });
}

/** A unified diff of two texts: one hunk around the changed lines, with 3 lines of context. */
export function unifiedDiff(before: string, after: string): string {
  if (before === after) return "";
  const a = before.split("\n");
  const b = after.split("\n");
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) endA--, endB--;
  const from = Math.max(0, start - 3);
  const toA = Math.min(a.length, endA + 3);
  const toB = Math.min(b.length, endB + 3);
  const range = (s: number, n: number) => `${n ? s + 1 : s},${n}`;
  return [
    "--- original",
    "+++ updated",
    `@@ -${range(from, toA - from)} +${range(from, toB - from)} @@`,
    ...a.slice(from, start).map((l) => ` ${l}`),
    ...a.slice(start, endA).map((l) => `-${l}`),
    ...b.slice(start, endB).map((l) => `+${l}`),
    ...a.slice(endA, toA).map((l) => ` ${l}`),
  ].join("\n");
}

/**
 * Applies a unified diff. Each hunk's context and removed lines must match the text exactly; a hunk may have moved
 * (other edits above it), so its lines are looked for near the stated position, and must be found exactly once.
 */
export function applyPatch(text: string, patch: string): string | EditFailure {
  const eol = eolOf(text);
  const lines = text.split(eol);
  const hunks: { at: number; old: string[]; next: string[] }[] = [];
  let hunk: (typeof hunks)[number] | undefined;
  // The patch's final newline isn't an empty context line.
  for (const raw of patch.replace(/\r\n/g, "\n").replace(/\n+$/, "").split("\n")) {
    const head = /^@@ -(\d+)(?:,\d+)? \+\d+(?:,\d+)? @@/.exec(raw);
    if (head) hunks.push((hunk = { at: Math.max(Number(head[1]) - 1, 0), old: [], next: [] }));
    else if (!hunk || raw.startsWith("---") || raw.startsWith("+++") || raw.startsWith("\\")) continue;
    else if (raw.startsWith("+")) hunk.next.push(raw.slice(1));
    else if (raw.startsWith("-")) hunk.old.push(raw.slice(1));
    else if (raw.startsWith(" ") || raw === "") (hunk.old.push(raw.slice(1)), hunk.next.push(raw.slice(1)));
  }
  if (!hunks.length) return fail("BAD_PATCH", "Patch neobsahuje žádný blok @@ … @@.", "Pošli patch ve formátu unified diff (řádky @@ -a,b +c,d @@ a pod nimi ' ', '-', '+').");
  let shift = 0;
  for (const [n, h] of hunks.entries()) {
    const matches = (i: number) => h.old.every((l, k) => lines[i + k] === l);
    const expected = h.at + shift;
    let found = -1;
    if (matches(expected)) found = expected;
    else {
      const all = [...lines.keys()].filter((i) => i + h.old.length <= lines.length && matches(i));
      if (all.length === 1) found = all[0]!;
      else {
        const actual = lines.slice(expected, expected + h.old.length);
        const first = h.old.findIndex((l, k) => actual[k] !== l);
        return fail(
          "HUNK_REJECTED",
          all.length
            ? `Blok ${n + 1} sedí na ${all.length} místech (řádky ${all.map((i) => i + 1).join(", ")}).`
            : `Blok ${n + 1} nesedí: na řádku ${expected + first + 1} je ${JSON.stringify(actual[first] ?? "(konec textu)")}, patch čeká ${JSON.stringify(h.old[first])}.`,
          "Přečti soubor znovu a vytvoř patch proti jeho aktuálnímu obsahu, s přesnými kontextovými řádky.",
        );
      }
    }
    lines.splice(found, h.old.length, ...h.next);
    shift = found - h.at + h.next.length - h.old.length;
  }
  return lines.join(eol);
}
