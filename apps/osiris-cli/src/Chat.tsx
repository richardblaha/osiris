import { Box, Text, useInput } from "ink";
import TextInput from "ink-text-input";
import { useEffect, useRef, useState } from "react";
import { api } from "@osiris/client/api.ts";
import { QUESTION_TOOLS, type ChatQuestion, type RunStatus, type ThreadMessage } from "@osiris/shared";
import { text } from "./text.ts";
import type { ThemeColors } from "./theme.ts";

type Part = { type: "text"; text: string } | { type: "tool"; id: string; name: string; done: boolean; failed?: boolean };
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

function Message({ m, theme }: { m: ChatMessage; theme: ThemeColors }) {
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text bold color={m.role === "user" ? theme.accentPrimary : theme.accentSecondary}>
        {m.role === "user" ? text.you : "Osiris"}
      </Text>
      {m.parts.map((p, i) =>
        p.type === "text" ? (
          <Text key={i} color={theme.textPrimary}>
            {p.text}
          </Text>
        ) : (
          <Text key={i} color={p.failed ? theme.stateError : p.done ? theme.textSecondary : theme.stateWarning}>
            {p.failed ? "✗" : p.done ? "✓" : "…"} {p.name}
          </Text>
        ),
      )}
    </Box>
  );
}

/** One conversation: its history, a run streamed as it comes, questions answered field by field, and the input. */
export function Chat({ threadId, onThread, onDone, theme, focused, width, height }: { threadId?: string; onThread: (id: string) => void; onDone?: () => void; theme: ThemeColors; focused: boolean; width: number; height: number }) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [status, setStatus] = useState<RunStatus | "loading">();
  const [error, setError] = useState<string>();
  const [input, setInput] = useState("");
  const [question, setQuestion] = useState<ChatQuestion>();
  const [answers, setAnswers] = useState<Record<string, unknown>>({});
  const [back, setBack] = useState(0);
  const thread = useRef(threadId);
  const running = useRef<AbortController>(undefined);
  /** A conversation this chat created on its first message: it's already on screen, nothing to load. */
  const created = useRef<string>(undefined);

  useEffect(() => {
    thread.current = threadId;
    if (threadId && threadId === created.current) return;
    setMessages([]);
    setQuestion(undefined);
    setError(undefined);
    setBack(0);
    if (!threadId) return;
    setStatus("loading");
    void api
      .messages(threadId)
      .then(async (history) => {
        setMessages(fromHistory(history));
        // An open question from before (the run ended waiting for it).
        const last = history.at(-1)?.content.findLast((p) => p.type === "tool-call" && QUESTION_TOOLS.includes(p.toolName));
        const q = last?.type === "tool-call" ? questionOf(last.result) : undefined;
        if (q) setQuestion(await api.question(threadId, q.id).then((fresh) => (fresh.state === "open" ? fresh : undefined), () => undefined));
      }, (e: Error) => setError(e.message))
      .finally(() => setStatus(undefined));
  }, [threadId]);

  useInput((_, key) => {
    if (!focused) return;
    if (key.pageUp) setBack((b) => Math.min(messages.length - 1, b + 1));
    if (key.pageDown) setBack((b) => Math.max(0, b - 1));
    if (key.escape) running.current?.abort();
  });

  const update = (change: (last: ChatMessage) => ChatMessage) => setMessages((all) => [...all.slice(0, -1), change(all.at(-1)!)]);

  const send = async (message: string, shown = message) => {
    setError(undefined);
    let id = thread.current;
    if (!id) {
      id = (await api.createThread()).id;
      thread.current = created.current = id;
      onThread(id);
    }
    setMessages((all) => [...all, { role: "user", parts: [{ type: "text", text: shown }] }, { role: "assistant", parts: [] }]);
    setBack(0);
    const abort = (running.current = new AbortController());
    try {
      for await (const e of api.run(id, message, abort.signal)) {
        if (e.type === "status") setStatus(e.status);
        else if (e.type === "text-delta")
          update((m) => {
            const last = m.parts.at(-1);
            return { ...m, parts: last?.type === "text" ? [...m.parts.slice(0, -1), { type: "text", text: last.text + e.delta }] : [...m.parts, { type: "text", text: e.delta }] };
          });
        else if (e.type === "tool-call-start" || e.type === "tool-call")
          update((m) => (m.parts.some((p) => p.type === "tool" && (p.id === e.toolCallId || p.id.startsWith("pending:"))) ? { ...m, parts: m.parts.map((p) => (p.type === "tool" && p.id.startsWith("pending:") ? { ...p, id: e.toolCallId } : p)) } : { ...m, parts: [...m.parts, { type: "tool", id: e.toolCallId, name: e.toolName, done: false }] }));
        else if (e.type === "tool-result") {
          update((m) => ({ ...m, parts: m.parts.map((p) => (p.type === "tool" && p.id === e.toolCallId ? { ...p, done: true, failed: /^(Error|Chyba)/.test(e.result) } : p)) }));
          const q = questionOf(e.result);
          if (q) setQuestion(q);
        } else if (e.type === "error") setError(e.message);
      }
    } catch (err) {
      if (!abort.signal.aborted) setError((err as Error).message);
    } finally {
      setStatus(undefined);
      running.current = undefined;
      // The conversation got its title, the usage grew.
      onDone?.();
    }
  };

  const submit = (value: string) => {
    const typed = value.trim();
    setInput("");
    if (!typed || status) return;
    if (question) {
      if (/^\/(zrusit|cancel)$/i.test(typed)) {
        setQuestion(undefined);
        return void send(`@osiris-answer:${JSON.stringify({ id: question.id, values: {}, cancel: true })}`, typed);
      }
      const field = question.fields[Object.keys(answers).length]!;
      const values = { ...answers, [field.name]: fieldValue(field, typed) };
      if (Object.keys(values).length < question.fields.length) return setAnswers(values);
      setQuestion(undefined);
      setAnswers({});
      return void send(`@osiris-answer:${JSON.stringify({ id: question.id, values, cancel: false })}`, question.fields.map((f) => `${f.label}: ${typed && String(values[f.name])}`).join("\n"));
    }
    void send(typed);
  };

  const field = question?.fields[Object.keys(answers).length];
  const inputLines = field ? 4 : 3;
  const shown = visible(messages, Math.max(3, height - inputLines - (error ? 2 : 0)), width, back);
  return (
    <Box flexDirection="column" width={width} height={height}>
      <Box flexDirection="column" flexGrow={1} overflow="hidden" paddingX={1}>
        {!messages.length && status !== "loading" ? (
          <Box flexGrow={1} alignItems="center" justifyContent="center">
            <Text color={theme.textSecondary}>{text.empty}</Text>
          </Box>
        ) : (
          shown.map((m, i) => <Message key={i} m={m} theme={theme} />)
        )}
      </Box>
      {error && (
        <Text color={theme.stateError} wrap="truncate-end">
          {" "}
          {error}
        </Text>
      )}
      <Box borderStyle="round" borderColor={focused ? theme.accentPrimary : theme.borderStrong} paddingX={1} flexDirection="column">
        {field && (
          <Text color={theme.accentSecondary} wrap="truncate-end">
            {text.question}: {field.label}
            {field.options ? ` (${field.options.map((o, n) => `${n + 1}) ${o.label}`).join(", ")})` : field.type === "boolean" ? " (ano/ne)" : ""} · {text.answerHint}
          </Text>
        )}
        {status ? (
          <Text color={theme.textMuted}>{status === "loading" ? text.loading : text[status]} (Esc)</Text>
        ) : (
          <TextInput value={input} onChange={setInput} onSubmit={submit} focus={focused} placeholder={text.placeholder} />
        )}
      </Box>
    </Box>
  );
}
