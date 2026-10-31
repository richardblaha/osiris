import type { ChatQuestion, RunEvent, ThreadSummary } from "@osiris/shared";
import { api, connect } from "@osiris/client/api.ts";
import { api as twinApi, type TwinAlert } from "./api.ts";
import { Icon } from "./Icon.tsx";
import { answerMessage, applyEvent, fromHistory, pendingQuestion, type ChatMessage } from "@osiris/client/chat.ts";
import { t } from "i18next";
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { autoSignIn, getAccessToken } from "./auth.ts";
import { currentLocale, formatDateTime } from "./i18n.ts";
import { usePopupClose } from "./Telemetry.tsx";
import type { PanelView } from "./Windows.tsx";
import type { PanelId, Snap } from "./windowLayout.ts";

/** A step for the twin's view, as Osiris's `twin_view` tool sends it. */
export type TwinAction =
  | { action: "select"; target: string }
  | { action: "clear" | "home" | "close" }
  | { action: "rotate" | "tilt"; degrees: number }
  | { action: "zoom"; factor: number }
  | { action: "open"; page: "dashboard" | "logs" | "metrics" | "traces"; filter?: Record<string, string> }
  | { action: "history"; at?: string }
  | { action: "window"; op: "show" | "close" | "focus" | "maximize" | "restore" | "snap" | "merge" | "detach"; panel: PanelId; snap?: Snap; with?: PanelId }
  | { action: "layout"; op: "reset" };

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

/** Osiris's conversation over the twin: its state and what can be done with it, shared by the bar and the window. */
export type OsirisChatState = ReturnType<typeof useOsirisChat>;

/**
 * Osiris's agent over the twin: the input at the bottom in the middle (typing, or the microphone: the recording goes
 * as a voice message Osiris transcribes), the conversation in a window over the twin (`chatPanel`), questions (a
 * command to approve) as forms, answers read aloud (Piper) when speech is on, and the `twin_view` tool's steps handed
 * to the twin as they come. The conversation shown is kept across visits; the history menu opens another or starts
 * a new one.
 */
export function useOsirisChat(onTwin: (actions: TwinAction[]) => void) {
  const [thread, setThread] = useState(() => stored(THREAD));
  const [title, setTitle] = useState<string>();
  /** An alert's investigation shown (read-only: it is the alerts service's conversation, not the user's). */
  const [alert, setAlert] = useState<TwinAlert>();
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
  const audio = useRef<HTMLAudioElement | null>(null);
  const twin = useRef(onTwin);
  twin.current = onTwin;

  /** Shows a conversation: its messages, and a question it stopped at. */
  const load = async (id: string) => {
    const history = await api.messages(id);
    setMessages(fromHistory(history));
    setQuestion(pendingQuestion(history));
  };
  // The kept conversation.
  useEffect(() => {
    if (thread) void load(thread).catch(() => (store(THREAD), setThread(undefined)));
  }, []);
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

  const ensureThread = async (fresh = false) => {
    if (thread && !fresh) return thread;
    const id = (await api.createThread()).id;
    store(THREAD, id);
    setThread(id);
    return id;
  };

  /** Sends a message (typed, an answer, a voice message) and folds the run's events into the conversation. */
  const send = async (message: string, label?: string, fresh = false) => {
    if (busy) return;
    // Over an alert's investigation, a message goes on in a new conversation of the user's own, with the alert's
    // findings as its context.
    if (alert && !fresh) return continueAlert(message, label);
    setBusy(true);
    setError(undefined);
    setOpen(true);
    setQuestion(undefined);
    audio.current?.pause();
    try {
      // A fresh one (after an alert) starts its own thread from nothing: this render's state is the alert's.
      const id = await ensureThread(fresh);
      const before = fresh ? [] : messages;
      if (!fresh && !messages.length && !title) setTitle((label ?? message).startsWith("@osiris-") ? undefined : (label ?? message).slice(0, 80));
      let current: ChatMessage[] = [...before, { role: "user", parts: [{ type: "text", text: label ?? message }] }, { role: "assistant", parts: [] }];
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
          const id = await ensureThread();
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

  /** A new conversation about an alert: the user's message after what the investigation found. */
  const continueAlert = async (message: string, label?: string) => {
    const a = alert!;
    const findings = textOf(messages.filter((m) => m.role === "assistant").at(-1) ?? { role: "assistant", parts: [] }).slice(0, 4000);
    newConversation();
    setTitle(t("twin:chat.alertTitle", { message: a.message.slice(0, 60) }));
    const context = t("twin:chat.alertContext", { message: a.message.slice(0, 1000), where: [a.namespace, a.workload ?? a.pod ?? a.node].filter(Boolean).join(" / "), findings });
    await send(`${context}\n\n${message}`, label ?? message, true);
  };

  /** A new, empty conversation, shown. */
  const newConversation = () => {
    abort.current?.abort();
    setAlert(undefined);
    store(THREAD);
    setThread(undefined);
    setTitle(undefined);
    setMessages([]);
    setQuestion(undefined);
    setError(undefined);
    setOpen(true);
  };
  /** Opens an alert's investigation (read-only) from the history. */
  const openAlert = async (a: TwinAlert) => {
    abort.current?.abort();
    setAlert(a);
    setTitle(a.message.slice(0, 80));
    setError(undefined);
    setQuestion(undefined);
    setMessages([]);
    setOpen(true);
    try {
      setMessages(fromHistory(await twinApi.alertMessages(a.id)));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };
  /** Opens a conversation from the history. */
  const openThread = async (id: string, name?: string) => {
    abort.current?.abort();
    setAlert(undefined);
    setError(undefined);
    setTitle(name);
    setOpen(true);
    if (id === thread && messages.length && !alert) return;
    setMessages([]);
    setQuestion(undefined);
    store(THREAD, id);
    setThread(id);
    try {
      await load(id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };
  const toggleSpeak = () => {
    store(SPEAK, speak ? "0" : "1");
    if (speak) audio.current?.pause();
    setSpeak(!speak);
  };
  const stop = () => abort.current?.abort();

  return { thread, title, alert, messages, question, text, setText, busy, open, setOpen, error, speak, recording, send, submit, toggleRecording, newConversation, openThread, openAlert, toggleSpeak, stop };
}

/** The conversation as a window over the twin: closing it hides it (the conversation stays). */
export function chatPanel(chat: OsirisChatState): PanelView {
  return {
    title: t("twin:chat.title"),
    heading: chat.busy ? t("twin:chat.thinking") : chat.alert ? t("twin:chat.alertTitle", { message: chat.alert.message.slice(0, 60) }) : (chat.title ?? t("twin:chat.subtitle")),
    icon: "chat",
    actions: (
      <button type="button" className="wm-button" onClick={chat.newConversation} title={t("twin:chat.new")} aria-label={t("twin:chat.new")}>
        <Icon name="add_comment" className="h-4 w-4" />
      </button>
    ),
    body: <ChatConversation chat={chat} />,
    onClose: () => chat.setOpen(false),
  };
}

/** The conversation's messages, the question it waits on, and what went wrong; kept scrolled to the newest. */
function ChatConversation({ chat }: { chat: OsirisChatState }) {
  const list = useRef<HTMLDivElement>(null);
  const { messages, busy, question, error, alert } = chat;
  useEffect(() => {
    // The window's body scrolls: to the newest message.
    const body = list.current?.parentElement;
    body?.scrollTo({ top: body.scrollHeight });
  }, [messages, question]);
  return (
    <div ref={list} className="space-y-2 text-sm" aria-live="polite">
      {alert && (
        <div className="osiris-question">
          <p className="font-semibold">{t("twin:chat.alertHeading", { state: t(`twin:chat.alertState.${alert.state}`), count: alert.count })}</p>
          <p className="text-xs text-fg-secondary">{t("twin:chat.alertReadOnly")}</p>
          {alert.error && <p className="text-xs text-error">{alert.error}</p>}
        </div>
      )}
      {!messages.length && !error && !alert && <p className="text-fg-muted">{t("twin:chat.empty")}</p>}
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
      {question && <QuestionForm question={question} onAnswer={(values, cancel) => void chat.send(answerMessage(question, values, cancel), cancel ? t("twin:chat.cancelled") : t("twin:chat.answered"))} />}
      {error && <p className="text-xs text-error">{error}</p>}
    </div>
  );
}

/** The input in the bottom bar: the history menu, the text, speech, the microphone, send (or stop). */
export function ChatInput({ chat }: { chat: OsirisChatState }) {
  const { text, setText, recording, busy, speak } = chat;
  return (
    <form className="osiris-input osiris-input-dock" onSubmit={chat.submit}>
      <ChatHistory chat={chat} />
      <input
        value={text}
        onChange={(e) => setText(e.target.value)}
        onFocus={() => chat.messages.length > 0 && chat.setOpen(true)}
        placeholder={recording ? t("twin:chat.recording") : chat.alert ? t("twin:chat.alertPlaceholder") : t("twin:chat.placeholder")}
        aria-label={t("twin:chat.placeholder")}
        className="min-w-0 flex-1 bg-transparent px-2 py-1.5 text-sm outline-none"
        disabled={recording}
      />
      <button type="button" onClick={chat.toggleSpeak} className="osiris-icon" aria-pressed={speak} title={speak ? t("twin:chat.speakOff") : t("twin:chat.speakOn")} aria-label={speak ? t("twin:chat.speakOff") : t("twin:chat.speakOn")}>
        <Icon name={speak ? "volume_up" : "volume_off"} />
      </button>
      <button type="button" onClick={() => void chat.toggleRecording()} className="osiris-icon" data-recording={recording} disabled={busy && !recording} title={recording ? t("twin:chat.stop") : t("twin:chat.speakToMe")} aria-label={recording ? t("twin:chat.stop") : t("twin:chat.speakToMe")}>
        <Icon name={recording ? "stop" : "mic"} />
      </button>
      {busy ? (
        <button type="button" className="osiris-icon" onClick={chat.stop} title={t("twin:chat.stop")} aria-label={t("twin:chat.stop")}>
          <Icon name="stop" />
        </button>
      ) : (
        <button className="osiris-icon osiris-send" disabled={!text.trim()} title={t("twin:chat.send")} aria-label={t("twin:chat.send")}>
          <Icon name="send" />
        </button>
      )}
    </form>
  );
}

/** The chat's icon: a menu opening upward with a new conversation and the earlier ones, newest first. */
function ChatHistory({ chat }: { chat: OsirisChatState }) {
  const [open, setOpen] = useState(false);
  const [list, setList] = useState<ThreadSummary[]>();
  const [alerts, setAlerts] = useState<TwinAlert[]>([]);
  const [error, setError] = useState<string>();
  const box = useRef<HTMLDivElement>(null);
  usePopupClose(open, box, () => setOpen(false));
  useEffect(() => {
    if (!open) return;
    setError(undefined);
    void api.threads().then(
      (threads) => setList([...threads].filter((x) => x.channel !== "public").sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))),
      (e: Error) => setError(e.message),
    );
    // The alerts Osiris investigated: their conversations are the alerts service's, opened read-only.
    void twinApi.alerts(20).then(setAlerts, () => setAlerts([]));
  }, [open]);
  const label = t("twin:chat.history");
  return (
    <div ref={box} className="relative">
      <button type="button" onClick={() => setOpen(!open)} className="osiris-icon" aria-haspopup="menu" aria-expanded={open} title={label} aria-label={label}>
        <Icon name="history" />
      </button>
      {open && (
        <div className="menu-popup menu-up start-0 w-80" role="menu" aria-label={label}>
          <button type="button" role="menuitem" className="list-row flex w-full items-center gap-2 px-3 py-2 text-start text-sm text-primary" onClick={() => (setOpen(false), chat.newConversation())}>
            <Icon name="add_comment" className="h-4 w-4" />
            {t("twin:chat.new")}
          </button>
          {alerts.length > 0 && (
            <>
              <p className="section-header border-t border-line px-3 pt-2 pb-1">{t("twin:chat.alerts")}</p>
              <ul className="max-h-56 overflow-y-auto pb-1">
                {alerts.map((a) => (
                  <li key={a.id}>
                    <button
                      type="button"
                      role="menuitemradio"
                      aria-checked={a.id === chat.alert?.id}
                      data-active={a.id === chat.alert?.id}
                      className="list-row flex w-full items-start gap-2 px-3 py-1.5 text-start"
                      onClick={() => (setOpen(false), void chat.openAlert(a))}
                    >
                      <Icon name={a.resolved ? "check_circle" : a.severity.toLowerCase() === "warn" ? "warning" : "error"} className={`mt-0.5 h-4 w-4 shrink-0 ${a.resolved ? "text-fg-muted" : "text-error"}`} />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm">{a.message}</span>
                        <span className="block truncate text-xs text-fg-muted">
                          {[formatDateTime(a.lastSeen), a.count > 1 ? `×${a.count}` : "", [a.namespace, a.workload ?? a.pod ?? a.node].filter(Boolean).join(" / "), t(`twin:chat.alertState.${a.state}`)].filter(Boolean).join(" · ")}
                        </span>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}
          <p className="section-header border-t border-line px-3 pt-2 pb-1">{label}</p>
          {error && <p className="px-3 py-1 text-xs text-error">{error}</p>}
          {!list && !error && <p className="px-3 py-1 text-xs text-fg-muted">{t("common:loading")}</p>}
          {list && !list.length && <p className="px-3 py-1 text-xs text-fg-muted">{t("twin:chat.noHistory")}</p>}
          <ul className="max-h-80 overflow-y-auto pb-1">
            {list?.map((x) => (
              <li key={x.id}>
                <button
                  type="button"
                  role="menuitemradio"
                  aria-checked={x.id === chat.thread}
                  data-active={x.id === chat.thread}
                  className="list-row block w-full px-3 py-1.5 text-start"
                  onClick={() => (setOpen(false), void chat.openThread(x.id, x.title ?? undefined))}
                >
                  <span className="block truncate text-sm">{x.title || t("twin:chat.untitled")}</span>
                  <span className="block text-xs text-fg-muted">{formatDateTime(Date.parse(x.updatedAt))}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
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
