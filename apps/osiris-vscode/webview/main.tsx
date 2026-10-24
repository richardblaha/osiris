import { createRoot } from "react-dom/client";
import { Component, useEffect, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from "react";
import { api, connect, setProject } from "@osiris/client/api.ts";
import { answerMessage, applyEvent, fromHistory, pendingQuestion, type ChatMessage } from "@osiris/client/chat.ts";
import { THEME } from "@osiris/shared/theme.ts";
import type { ChatQuestion, RunStatus, ThreadSummary } from "@osiris/shared";
import { texts } from "./texts.ts";

interface Boot {
  connection: { mode: "local" | "server"; url: string; label: string; project?: string } | null;
  error: string | null;
  /** A folder without `.osiris/`: the panel offers to start Osiris there. */
  startable: string | null;
  language: string;
}
declare global {
  interface Window {
    OSIRIS: Boot;
  }
}
declare function acquireVsCodeApi(): { postMessage(message: unknown): void };

const vscode = acquireVsCodeApi();
const boot = window.OSIRIS;
const t = texts(boot.language);

// Tokens stay in the extension (VS Code's secret storage, the agent's file): the webview asks for one per request.
let asked = 0;
const waiting = new Map<number, (token: string | null) => void>();
window.addEventListener("message", (e) => {
  const m = e.data as { type: string; id?: number; token?: string | null };
  if (m.type === "token") waiting.get(m.id!)?.(m.token ?? null), waiting.delete(m.id!);
});
const ask = () =>
  new Promise<string | null>((done) => {
    const id = ++asked;
    waiting.set(id, done);
    vscode.postMessage({ type: "token", id });
  });
// A local agent's token never changes: asked once (and again after a 401). A server's is refreshed by the extension.
let localToken: Promise<string | null> | undefined;
const token = () => (boot.connection?.mode === "local" ? (localToken ??= ask()) : ask());

/** The PWA's accent colors on VS Code's own (it marks the theme on <body>). */
function applyAccents() {
  const colors = document.body.classList.contains("vscode-light") ? THEME.light : THEME.dark;
  document.body.style.setProperty("--osiris-primary", colors.accentPrimary);
  document.body.style.setProperty("--osiris-secondary", colors.accentSecondary);
  document.body.style.setProperty("--osiris-success", colors.stateSuccess);
  document.body.style.setProperty("--osiris-warning", colors.stateWarning);
}
new MutationObserver(applyAccents).observe(document.body, { attributes: true, attributeFilter: ["class"] });
applyAccents();

function Question({ question, onAnswer }: { question: ChatQuestion; onAnswer: (values: Record<string, unknown>, cancel?: boolean) => void }) {
  const [values, setValues] = useState<Record<string, unknown>>({});
  const set = (name: string, value: unknown) => setValues((v) => ({ ...v, [name]: value }));
  const submit = (e: FormEvent) => (e.preventDefault(), onAnswer(values));
  return (
    <form className="question" onSubmit={submit}>
      <strong>{question.title}</strong>
      {question.fields.map((f) => (
        <label key={f.name}>
          <span>
            {f.label}
            {f.required ? " *" : ""}
          </span>
          {f.type === "boolean" ? (
            <span className="row">
              <button type="button" className={values[f.name] === true ? "on" : ""} onClick={() => set(f.name, true)}>
                {t.yes}
              </button>
              <button type="button" className={values[f.name] === false ? "on" : ""} onClick={() => set(f.name, false)}>
                {t.no}
              </button>
            </span>
          ) : f.type === "select" ? (
            <select required={f.required} value={String(values[f.name] ?? "")} onChange={(e) => set(f.name, e.target.value)}>
              <option value="" />
              {f.options?.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          ) : f.type === "multiselect" ? (
            f.options?.map((o) => (
              <label key={o.value} className="check">
                <input
                  type="checkbox"
                  checked={((values[f.name] as string[]) ?? []).includes(o.value)}
                  onChange={(e) => set(f.name, e.target.checked ? [...((values[f.name] as string[]) ?? []), o.value] : ((values[f.name] as string[]) ?? []).filter((v) => v !== o.value))}
                />
                {o.label}
              </label>
            ))
          ) : (
            <input type={f.type === "number" ? "number" : f.type === "date" ? "date" : "text"} required={f.required} onChange={(e) => set(f.name, f.type === "number" ? Number(e.target.value) : e.target.value)} />
          )}
        </label>
      ))}
      <span className="row">
        <button type="submit" className="primary">
          {t.send}
        </button>
        <button type="button" onClick={() => onAnswer({}, true)}>
          {t.cancel}
        </button>
      </span>
    </form>
  );
}

function Message({ m }: { m: ChatMessage }) {
  return (
    <div className={`message ${m.role}`}>
      <div className="who">{m.role === "user" ? t.you : "Osiris"}</div>
      {m.parts.map((p, i) =>
        p.type === "text" ? (
          <div key={i} className="text">
            {p.text}
          </div>
        ) : (
          <div key={i} className={`tool ${p.failed ? "failed" : p.done ? "done" : "running"}`}>
            {p.failed ? "✗" : p.done ? "✓" : "…"} {p.name}
          </div>
        ),
      )}
    </div>
  );
}

function App() {
  const [ready, setReady] = useState(false);
  const [error, setError] = useState(boot.error);
  const [threads, setThreads] = useState<ThreadSummary[]>([]);
  const [threadId, setThreadId] = useState<string>();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [question, setQuestion] = useState<ChatQuestion>();
  const [status, setStatus] = useState<RunStatus | "loading">();
  const [input, setInput] = useState("");
  const running = useRef<AbortController>(undefined);
  const created = useRef<string>(undefined);
  const end = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLTextAreaElement>(null);

  const loadThreads = () => api.threads().then(setThreads, () => {});
  useEffect(() => {
    if (!boot.connection) return;
    connect({
      url: boot.connection.url,
      token,
      signIn: async () => {
        localToken = undefined;
        vscode.postMessage({ type: "signIn" });
      },
      locale: () => boot.language,
    });
    void (async () => {
      const me = await api.me();
      const project = me.projects.find((p) => p.id === boot.connection?.project) ?? me.projects[0];
      if (!project) throw new Error(t.noProject);
      setProject(project.id);
      await loadThreads();
      setReady(true);
    })().catch((e: Error) => setError(e.message));
  }, []);

  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      const m = e.data as { type: string; text?: string };
      if (m.type === "newChat") open(undefined);
      if (m.type === "prompt") setInput((v) => v + (m.text ?? "")), field.current?.focus();
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  // A block body: scrollIntoView returns a Promise in newer Chromium, which React would take for a cleanup.
  useEffect(() => {
    void end.current?.scrollIntoView({ block: "end" });
  }, [messages, question]);

  const open = (id: string | undefined) => {
    running.current?.abort();
    setThreadId(id);
    setMessages([]);
    setQuestion(undefined);
    if (!id) return;
    setStatus("loading");
    void api
      .messages(id)
      .then(async (history) => {
        setMessages(fromHistory(history));
        const q = pendingQuestion(history);
        if (q) setQuestion(await api.question(id, q.id).then((fresh) => (fresh.state === "open" ? fresh : undefined), () => undefined));
      }, (e: Error) => setError(e.message))
      .finally(() => setStatus(undefined));
  };

  const send = async (message: string, shown = message) => {
    setError(null);
    let id = threadId;
    if (!id) {
      id = created.current = (await api.createThread()).id;
      setThreadId(id);
    }
    setMessages((all) => [...all, { role: "user", parts: [{ type: "text", text: shown }] }, { role: "assistant", parts: [] }]);
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
      void loadThreads();
    }
  };

  const submit = () => {
    const text = input.trim();
    if (!text || status) return;
    setInput("");
    void send(text);
  };
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) (e.preventDefault(), submit());
  };

  if (!boot.connection && boot.startable)
    return (
      <div className="empty">
        <p>{t.notProject(boot.startable)}</p>
        <button className="primary" onClick={() => vscode.postMessage({ type: "start" })}>
          {t.start}
        </button>
        <button onClick={() => vscode.postMessage({ type: "connectServer" })}>{t.connectServer}</button>
      </div>
    );
  if (!boot.connection)
    return (
      <div className="empty">
        <p className="error">{error}</p>
        <button onClick={() => vscode.postMessage({ type: "retry" })}>{t.retry}</button>
        <button onClick={() => vscode.postMessage({ type: "connectServer" })}>{t.connectServer}</button>
      </div>
    );

  return (
    <div className="app">
      <header>
        <select value={threadId ?? ""} onChange={(e) => open(e.target.value || undefined)} title={t.conversations}>
          <option value="">{t.newChat}</option>
          {threads.map((th) => (
            <option key={th.id} value={th.id}>
              {th.title || "…"}
            </option>
          ))}
        </select>
        <button className="icon" title={t.newChat} onClick={() => open(undefined)}>
          +
        </button>
      </header>
      <main>
        {!messages.length && status !== "loading" ? (
          <div className="welcome">
            <div className="logo">◆</div>
            <p>{ready ? t.empty : t.connecting}</p>
          </div>
        ) : (
          messages.map((m, i) => <Message key={i} m={m} />)
        )}
        {question && (
          <Question
            question={question}
            onAnswer={(values, cancel) => {
              setQuestion(undefined);
              void send(answerMessage(question, values, cancel), cancel ? t.cancel : question.fields.map((f) => `${f.label}: ${String(values[f.name] ?? "—")}`).join("\n"));
            }}
          />
        )}
        {status && <div className="status">{status === "loading" ? t.loading : t[status]}</div>}
        {error && <div className="error">{error}</div>}
        <div ref={end} />
      </main>
      <footer>
        <textarea ref={field} value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={onKey} placeholder={t.placeholder} rows={3} />
        <div className="row">
          <span className="where" title={boot.connection.url}>
            {boot.connection.mode === "local" ? `◆ ${boot.connection.label}` : `☁ ${boot.connection.label}`}
          </span>
          {status && status !== "loading" ? (
            <button onClick={() => running.current?.abort()}>{t.stop}</button>
          ) : (
            <button className="primary" disabled={!input.trim()} onClick={submit}>
              {t.send}
            </button>
          )}
        </div>
      </footer>
    </div>
  );
}

/** A crash of the panel shows itself, with a way back, instead of an empty panel. */
class Boundary extends Component<{ children: ReactNode }, { error?: Error }> {
  state: { error?: Error } = {};
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="empty">
        <p className="error">{String(this.state.error.stack ?? this.state.error)}</p>
        <button onClick={() => vscode.postMessage({ type: "retry" })}>{t.retry}</button>
      </div>
    );
  }
}

createRoot(document.getElementById("root")!).render(
  <Boundary>
    <App />
  </Boundary>,
);
