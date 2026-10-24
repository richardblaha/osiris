import { Box, Text, useInput } from "ink";
import TextInput from "ink-text-input";
import { useEffect, useRef, useState } from "react";
import { api } from "@osiris/client/api.ts";
import type { ChatQuestion, RunStatus } from "@osiris/shared";
import { answerMessage, applyEvent, fieldValue, fromHistory, pendingQuestion, visible, type ChatMessage } from "@osiris/client/chat.ts";
import { text } from "./text.ts";
import type { ThemeColors } from "./theme.ts";

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
        const q = pendingQuestion(history);
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
        else if (e.type === "error") setError(e.message);
        else
          setMessages((all) => {
            const next = applyEvent(all, e);
            if (next.question) setQuestion(next.question);
            return next.messages;
          });
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
        return void send(answerMessage(question, {}, true), typed);
      }
      const field = question.fields[Object.keys(answers).length]!;
      const values = { ...answers, [field.name]: fieldValue(field, typed) };
      if (Object.keys(values).length < question.fields.length) return setAnswers(values);
      setQuestion(undefined);
      setAnswers({});
      return void send(answerMessage(question, values), question.fields.map((f) => `${f.label}: ${String(values[f.name])}`).join("\n"));
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
