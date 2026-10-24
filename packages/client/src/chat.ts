import { QUESTION_TOOLS, type ChatQuestion, type RunEvent, type ThreadMessage } from "@osiris/shared";

// A conversation as the clients show it (the TUI, the VS Code panel): messages of text and tool steps, built from the
// stored history and the events of a run as they stream.

export type Part = { type: "text"; text: string } | { type: "tool"; id: string; name: string; done: boolean; failed?: boolean };
export interface ChatMessage {
  role: "user" | "assistant";
  parts: Part[];
}

/** A question a tool result carries (`ask_user`, a workflow's approval), or undefined. */
export function questionOf(result: string | undefined): ChatQuestion | undefined {
  try {
    const q = (JSON.parse(result ?? "") as { question?: ChatQuestion }).question;
    return q?.id && q.fields ? q : undefined;
  } catch {
    return undefined;
  }
}

export const fromHistory = (messages: ThreadMessage[]): ChatMessage[] =>
  messages.map((m) => ({
    role: m.role,
    parts: m.content.map((p): Part => (p.type === "text" ? p : { type: "tool", id: p.toolCallId, name: p.toolName, done: p.result !== undefined })),
  }));

/** Lines a message takes at `width` columns, roughly (for keeping the newest ones on screen). */
const linesOf = (m: ChatMessage, width: number) =>
  2 + m.parts.reduce((n, p) => n + (p.type === "tool" ? 1 : p.text.split("\n").reduce((k, l) => k + Math.max(1, Math.ceil(l.length / Math.max(10, width - 2))), 0)), 0);

/** The messages that fit `height` lines, newest last, `back` messages up from the end. */
export function visible(messages: ChatMessage[], height: number, width: number, back = 0): ChatMessage[] {
  const end = Math.max(0, messages.length - back);
  let used = 0;
  let start = end;
  while (start > 0 && used + linesOf(messages[start - 1]!, width) <= height) used += linesOf(messages[--start]!, width);
  return messages.slice(start === end && end > 0 ? end - 1 : start, end);
}

/** A value for a question's field from what the user typed (yes/no, a number, an option by its number or label). */
export function fieldValue(field: ChatQuestion["fields"][number], typed: string): unknown {
  const t = typed.trim();
  const option = (v: string) => field.options?.find((o) => o.value === v || o.label.toLowerCase() === v.toLowerCase())?.value ?? field.options?.[Number(v) - 1]?.value ?? v;
  if (field.type === "boolean") return /^(a|ano|y|yes|true)$/i.test(t) ? true : /^(n|ne|no|false)$/i.test(t) ? false : t;
  if (field.type === "number") return Number(t.replace(",", "."));
  if (field.type === "select") return option(t);
  if (field.type === "multiselect") return t.split(",").map((v) => option(v.trim())).filter(Boolean);
  return t;
}

/** A run's event folded into the last (assistant) message; a question it carries is returned beside it. */
export function applyEvent(messages: ChatMessage[], e: RunEvent): { messages: ChatMessage[]; question?: ChatQuestion } {
  const last = messages.at(-1);
  if (!last || last.role !== "assistant") return { messages };
  const set = (m: ChatMessage) => [...messages.slice(0, -1), m];
  if (e.type === "text-delta") {
    const tail = last.parts.at(-1);
    return { messages: set({ ...last, parts: tail?.type === "text" ? [...last.parts.slice(0, -1), { type: "text", text: tail.text + e.delta }] : [...last.parts, { type: "text", text: e.delta }] }) };
  }
  if (e.type === "tool-call-start" || e.type === "tool-call") {
    if (last.parts.some((p) => p.type === "tool" && p.id === e.toolCallId)) return { messages };
    // A call announced before its id was known (`pending:<n>`) gets it now.
    const pending = last.parts.findIndex((p) => p.type === "tool" && p.id.startsWith("pending:") && p.name === e.toolName);
    if (pending >= 0) return { messages: set({ ...last, parts: last.parts.map((p, i) => (i === pending ? { ...p, id: e.toolCallId } : p)) }) };
    return { messages: set({ ...last, parts: [...last.parts, { type: "tool", id: e.toolCallId, name: e.toolName, done: false }] }) };
  }
  if (e.type === "tool-result") {
    const parts = last.parts.map((p) => (p.type === "tool" && p.id === e.toolCallId ? { ...p, done: true, failed: /^(Error|Chyba)/.test(e.result) } : p));
    return { messages: set({ ...last, parts }), question: questionOf(e.result) };
  }
  return { messages };
}

/** The answer a question's form sends as the next message. */
export const answerMessage = (question: ChatQuestion, values: Record<string, unknown>, cancel = false) => `@osiris-answer:${JSON.stringify({ id: question.id, values, cancel })}`;

/** An open question the history ended with (the run stopped waiting for it), to ask again. */
export function pendingQuestion(history: ThreadMessage[]): ChatQuestion | undefined {
  const last = history.at(-1)?.content.findLast((p) => p.type === "tool-call" && QUESTION_TOOLS.includes(p.toolName));
  return last?.type === "tool-call" ? questionOf(last.result) : undefined;
}
