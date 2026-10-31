import type { ChatQuestion, RunEvent } from "@osiris/shared";
import { api, connect } from "@osiris/client/api.ts";
import { Icon } from "./Icon.tsx";
import { answerMessage, applyEvent, fromHistory, pendingQuestion, type ChatMessage } from "@osiris/client/chat.ts";
import { t } from "i18next";
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { autoSignIn, getAccessToken } from "./auth.ts";
import { currentLocale } from "./i18n.ts";

/** A step for the twin's view, as Osiris's `twin_view` tool sends it. */
export type TwinAction =
  | { action: "select"; target: string }
  | { action: "clear" | "home" | "close" }
  | { action: "rotate" | "tilt"; degrees: number }
  | { action: "zoom"; factor: number }
  | { action: "open"; page: "dashboard" | "logs" | "metrics" | "traces"; filter?: Record<string, string> }
  | { action: "history"; at?: string };

// Osiris through the twin's own proxy (/osiris/api/… → its gateway, with the twin's project), as the signed-in user.
connect({ url: "/osiris", token: getAccessToken, signIn: async () => void autoSignIn(), locale: currentLocale });

const THREAD = "osiris.digital-twin.thread";
const SPEAK = "osiris.digital-twin.speak";
const MAX_RECORDING_MS = 120_000;
const stored = (key: string) => {
  try {
    return localStorage.getItem(key) ?? undefined;
  } catch {
    return undefined;
  }
};
const store = (key: string, value?: string) => {
  try {
    if (value === undefined) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // Without storage the conversation lasts as long as the page.
  }
};
const textOf = (m: ChatMessage) => m.parts.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("");
/** A user's message as people read it: the text of an attachments envelope, a voice message as a mark. */
const shown = (m: ChatMessage): ReactNode => {
  const text = textOf(m);
  if (text.startsWith("@osiris-answer:")) return t("twin:chat.answered");
  if (!text.startsWith("@osiris-attachments:")) return text;
  try {
    const a = JSON.parse(text.slice("@osiris-attachments:".length)) as { text?: string; voice?: string };
    return a.voice ? (
      <>
        <Icon name="mic" className="me-1 h-4 w-4 align-[-0.2em]" />
        {a.text || t("twin:chat.voice")}
      </>
    ) : (a.text ?? "");
  } catch {
    return text;
  }
};

/**
 * Osiris's agent over the twin: the input at the bottom in the middle (typing, or the microphone: the recording goes
 * as a voice message Osiris transcribes), the conversation in a panel above the twin, questions (a command to
 * approve) as forms, answers read aloud (Piper) when speech is on, and the `twin_view` tool's steps handed to the
 * twin as they come. The conversation is one thread, kept across visits.
 */
export function OsirisChat({ onTwin, dock }: { onTwin: (actions: TwinAction[]) => void; /** In the bottom bar: the input inline, the conversation in a panel above the bar. */
  dock?: boolean }) {
  const [thread, setThread] = useState(() => stored(THREAD));
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [question, setQuestion] = useState<ChatQuestion>();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string>();
  const [speak, setSpeak] = useState(() => stored(SPEAK) === "1");
  const [recording, setRecording] = useState(false);
  const recorder = useRef<MediaRecorder | null>(null);
  const abort = useRef<AbortController | null>(null);
  const list = useRef<HTMLDivElement>(null);
  const audio = useRef<HTMLAudioElement | null>(null);
  const twin = useRef(onTwin);
  twin.current = onTwin;

  // The kept conversation, and a question it stopped at.
  useEffect(() => {
    if (!thread) return;
    void api.messages(thread).then(
      (history) => (setMessages(fromHistory(history)), setQuestion(pendingQuestion(history))),
      () => (store(THREAD), setThread(undefined)),
    );
  }, []);
  useEffect(() => {
    if (open) list.current?.scrollTo({ top: list.current.scrollHeight });
  }, [messages, open]);
  useEffect(() => () => abort.current?.abort(), []);

  /** Reads an answer aloud with Piper (through Osiris), unless another one started meanwhile. */
  const say = async (words: string) => {
    if (!words.trim()) return;
    try {
      const url = URL.createObjectURL(await api.tts(words, currentLocale()));
      audio.current?.pause();
      const player = new Audio(url);
      audio.current = player;
      player.onended = () => URL.revokeObjectURL(url);
      await player.play();
    } catch {
      // Speech is a courtesy: a failure leaves the written answer.
    }
  };

  /** Sends a message (typed, an answer, a voice message) and folds the run's events into the conversation. */
  const send = async (message: string, label?: string) => {
    if (busy) return;
    setBusy(true);
    setError(undefined);
    setOpen(true);
    setQuestion(undefined);
    audio.current?.pause();
    try {
      let id = thread;
      if (!id) {
        id = (await api.createThread()).id;
        store(THREAD, id);
        setThread(id);
      }
      let current: ChatMessage[] = [...messages, { role: "user", parts: [{ type: "text", text: label ?? message }] }, { role: "assistant", parts: [] }];
      setMessages(current);
      abort.current = new AbortController();
      for await (const e of api.run(id, message, abort.current.signal) as AsyncGenerator<RunEvent>) {
        if (e.type === "error") throw new Error(e.message);
        const next = applyEvent(current, e);
        current = next.messages;
        setMessages(current);
        if (next.question) setQuestion(next.question);
        if (e.type === "tool-result") {
          const steps = (e.artifact as { twin?: TwinAction[] } | undefined)?.twin;
          if (Array.isArray(steps)) twin.current(steps);
        }
      }
      if (speak) void say(textOf(current.at(-1)!));
    } catch (err) {
      if (!abort.current?.signal.aborted) setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
      abort.current = null;
    }
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const words = text.trim();
    if (!words) return;
    setText("");
    void send(words);
  };

  /** The microphone: a recording sent as a voice message (Osiris transcribes it), stopped by a second press. */
  const toggleRecording = async () => {
    if (recording) return recorder.current?.stop();
    setError(undefined);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mimeType = ["audio/webm", "audio/ogg", "audio/mp4"].find((type) => MediaRecorder.isTypeSupported(type));
      const media = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      recorder.current = media;
      const chunks: BlobPart[] = [];
      const limit = setTimeout(() => media.state === "recording" && media.stop(), MAX_RECORDING_MS);
      media.ondataavailable = (e) => chunks.push(e.data);
      media.onstop = async () => {
        clearTimeout(limit);
        stream.getTracks().forEach((track) => track.stop());
        setRecording(false);
        const blob = new Blob(chunks, { type: media.mimeType });
        if (!blob.size) return;
        try {
          let id = thread;
          if (!id) {
            id = (await api.createThread()).id;
            store(THREAD, id);
            setThread(id);
          }
          const ext = media.mimeType.includes("ogg") ? "ogg" : media.mimeType.includes("mp4") ? "m4a" : "webm";
          const path = `${crypto.randomUUID()}-hlas.${ext}`;
          await api.uploadFile({ scope: "temp", path, thread: id }, new File([blob], path, { type: media.mimeType }));
          await send(`@osiris-attachments:${JSON.stringify({ text: text.trim(), paths: [path], voice: path })}`);
          setText("");
        } catch (err) {
          setError(err instanceof Error ? err.message : String(err));
        }
      };
      media.start();
      setRecording(true);
    } catch {
      setError(t("twin:chat.noMicrophone"));
    }
  };

  const newConversation = () => {
    abort.current?.abort();
    store(THREAD);
    setThread(undefined);
    setMessages([]);
    setQuestion(undefined);
    setError(undefined);
  };
  const toggleSpeak = () => {
    store(SPEAK, speak ? "0" : "1");
    if (speak) audio.current?.pause();
    setSpeak(!speak);
  };

  return (
    <>
      {open && (messages.length > 0 || error) && (
        <section className={dock ? "osiris-answers osiris-answers-dock" : "osiris-answers"} aria-label={t("twin:chat.title")} aria-live="polite">
          <header className="flex items-center gap-2 border-b border-line px-3 py-1.5">
            <span className="section-header flex-1">{t("twin:chat.title")}</span>
            <button type="button" className="btn-link text-xs" onClick={newConversation}>
              {t("twin:chat.new")}
            </button>
            <button type="button" className="px-1 text-fg-muted hover:text-fg" onClick={() => setOpen(false)} aria-label={t("twin:chat.hide")} title={t("twin:chat.hide")}>
              <Icon name="close" className="h-4 w-4" />
            </button>
          </header>
          <div ref={list} className="min-h-0 flex-1 space-y-2 overflow-y-auto px-3 py-2 text-sm">
            {messages.map((m, i) =>
              m.role === "user" ? (
                <p key={i} className="osiris-user">
                  {shown(m)}
                </p>
              ) : (
                <div key={i} className="space-y-1">
                  {m.parts.map((p, j) =>
                    p.type === "tool" ? (
                      <span key={j} className="osiris-step" data-state={p.failed ? "failed" : p.done ? "done" : "running"}>
                        {p.done ? <Icon name={p.failed ? "close" : "check"} className="h-3.5 w-3.5 align-[-0.15em]" /> : "…"} {p.name}
                      </span>
                    ) : (
                      <p key={j} className="whitespace-pre-wrap">
                        {p.text}
                      </p>
                    ),
                  )}
                  {busy && i === messages.length - 1 && !textOf(m) && <p className="text-fg-muted">{t("twin:chat.thinking")}</p>}
                </div>
              ),
            )}
            {question && <QuestionForm question={question} onAnswer={(values, cancel) => void send(answerMessage(question, values, cancel), cancel ? t("twin:chat.cancelled") : t("twin:chat.answered"))} />}
            {error && <p className="text-xs text-error">{error}</p>}
          </div>
        </section>
      )}
      <form className={dock ? "osiris-input osiris-input-dock" : "osiris-input"} onSubmit={submit}>
        <button type="button" onClick={() => setOpen(!open)} className="osiris-icon" aria-pressed={open} title={t("twin:chat.title")} aria-label={t("twin:chat.title")}>
          <Icon name="chat" />
        </button>
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          onFocus={() => messages.length > 0 && setOpen(true)}
          placeholder={recording ? t("twin:chat.recording") : t("twin:chat.placeholder")}
          aria-label={t("twin:chat.placeholder")}
          className="min-w-0 flex-1 bg-transparent px-2 py-1.5 text-sm outline-none"
          disabled={recording}
        />
        <button type="button" onClick={toggleSpeak} className="osiris-icon" aria-pressed={speak} title={speak ? t("twin:chat.speakOff") : t("twin:chat.speakOn")} aria-label={speak ? t("twin:chat.speakOff") : t("twin:chat.speakOn")}>
          <Icon name={speak ? "volume_up" : "volume_off"} />
        </button>
        <button type="button" onClick={() => void toggleRecording()} className="osiris-icon" data-recording={recording} disabled={busy && !recording} title={recording ? t("twin:chat.stop") : t("twin:chat.speakToMe")} aria-label={recording ? t("twin:chat.stop") : t("twin:chat.speakToMe")}>
          <Icon name={recording ? "stop" : "mic"} />
        </button>
        {busy ? (
          <button type="button" className="osiris-icon" onClick={() => abort.current?.abort()} title={t("twin:chat.stop")} aria-label={t("twin:chat.stop")}>
            <Icon name="stop" />
          </button>
        ) : (
          <button className="osiris-icon osiris-send" disabled={!text.trim()} title={t("twin:chat.send")} aria-label={t("twin:chat.send")}>
            <Icon name="send" />
          </button>
        )}
      </form>
    </>
  );
}

/** A question as a form: yes/no for a confirmation (a command to run), a field per value otherwise. */
function QuestionForm({ question, onAnswer }: { question: ChatQuestion; onAnswer: (values: Record<string, unknown>, cancel: boolean) => void }) {
  const [values, setValues] = useState<Record<string, unknown>>({});
  const single = question.fields.length === 1 && question.fields[0]!.type === "boolean" ? question.fields[0]! : undefined;
  if (single)
    return (
      <div className="osiris-question">
        <p className="font-semibold">{question.title}</p>
        <code className="block break-all text-xs">{single.label}</code>
        <div className="mt-2 flex gap-2">
          <button type="button" className="btn-primary px-3 py-1 text-sm" onClick={() => onAnswer({ [single.name]: true }, false)}>
            {t("twin:chat.yes")}
          </button>
          <button type="button" className="btn-secondary px-3 py-1 text-sm" onClick={() => onAnswer({ [single.name]: false }, false)}>
            {t("twin:chat.no")}
          </button>
        </div>
      </div>
    );
  return (
    <form className="osiris-question space-y-1" onSubmit={(e) => (e.preventDefault(), onAnswer(values, false))}>
      <p className="font-semibold">{question.title}</p>
      {question.fields.map((f) => (
        <label key={f.name} className="flex flex-col text-xs text-fg-secondary">
          {f.label}
          {f.type === "boolean" ? (
            <input type="checkbox" checked={values[f.name] === true} onChange={(e) => setValues({ ...values, [f.name]: e.target.checked })} />
          ) : f.type === "select" ? (
            <select className="field py-1 text-sm" value={String(values[f.name] ?? "")} onChange={(e) => setValues({ ...values, [f.name]: e.target.value })} required={f.required}>
              <option value="">—</option>
              {f.options?.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          ) : (
            <input
              className="field py-1 text-sm"
              type={f.type === "number" ? "number" : f.type === "date" ? "date" : "text"}
              required={f.required}
              value={String(values[f.name] ?? "")}
              onChange={(e) => setValues({ ...values, [f.name]: f.type === "number" ? Number(e.target.value) : e.target.value })}
            />
          )}
        </label>
      ))}
      <div className="flex gap-2 pt-1">
        <button className="btn-primary px-3 py-1 text-sm">{t("twin:chat.send")}</button>
        <button type="button" className="btn-secondary px-3 py-1 text-sm" onClick={() => onAnswer({}, true)}>
          {t("twin:chat.cancel")}
        </button>
      </div>
    </form>
  );
}
