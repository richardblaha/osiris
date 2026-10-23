import { UploadContext } from "./Attachments.tsx";
import { Pending } from "../Scope.tsx";
import { AssistantRuntimeProvider, ExportedMessageRepository, useLocalRuntime, type ThreadMessageLike } from "@assistant-ui/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api.ts";
import { createAdapter, toInitialMessages } from "./adapter.ts";
import { Thread, ThreadIdContext } from "./Thread.tsx";
import { Files } from "../Files.tsx";
import { t } from "i18next";

interface Props {
  /** Existing thread to open, or null for a new conversation (created on first send). */
  threadId: string | null;
  onThreadCreated: (id: string) => void;
  onRunFinished: () => void;
}

export function ChatPane({ threadId, onThreadCreated, onRunFinished }: Props) {
  const [initial, setInitial] = useState<ThreadMessageLike[] | null>(threadId ? null : []);
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (!threadId) return;
    api.messages(threadId).then((m) => setInitial(toInitialMessages(m)), (e: Error) => setError(e.message));
    // Only on mount: the parent remounts this component (via `key`) to switch threads.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (error) return <p className="notice notice-error m-6 px-3 py-2">{error}</p>;
  if (!initial) return <Pending className="relative h-full" />;
  return <Chat threadId={threadId} initial={initial} onThreadCreated={onThreadCreated} onRunFinished={onRunFinished} />;
}

function Chat({ threadId, initial, onThreadCreated, onRunFinished }: Props & { initial: ThreadMessageLike[] }) {
  const idRef = useRef(threadId);
  // The thread once it exists (its scratchpad opens only then) and the scratchpad's state: open, and reloaded after each run.
  const [thread, setThread] = useState(threadId);
  const [scratchpad, setScratchpad] = useState(false);
  const [runs, setRuns] = useState(0);
  const wrapped = { onThreadCreated: (id: string) => (setThread(id), onThreadCreated(id)), onRunFinished: () => (setRuns((n) => n + 1), onRunFinished()) };
  const callbacks = useRef(wrapped);
  callbacks.current = wrapped;

  const creating = useRef<Promise<string> | null>(null);
  const getThreadId = async () => {
    if (idRef.current) return idRef.current;
    creating.current ??= api.createThread().then(({ id }) => {
      idRef.current = id;
      callbacks.current.onThreadCreated(id);
      return id;
    }).finally(() => { creating.current = null; });
    return creating.current;
  };
  const adapter = useMemo(
    () =>
      createAdapter(
        getThreadId,
        () => callbacks.current.onRunFinished(),
      ),
    [],
  );
  const runtime = useLocalRuntime(adapter, { initialMessages: initial });
  useEffect(() => {
    let disposed = false;
    let pending = false;
    let last = "";
    const sync = async () => {
      const id = idRef.current;
      if (!id || pending || document.visibilityState === "hidden" || runtime.thread.getState().isRunning) return;
      pending = true;
      try {
        const snapshot = await api.threadState(id);
        if (disposed || snapshot.busy || runtime.thread.getState().isRunning) return;
        if (snapshot.messages.length < runtime.thread.getState().messages.length) return;
        const signature = JSON.stringify(snapshot.messages);
        if (signature !== last) {
          runtime.thread.import(ExportedMessageRepository.fromArray(toInitialMessages(snapshot.messages)));
          last = signature;
          callbacks.current.onRunFinished();
        }
      } catch { /* A transient reconnect leaves the visible history intact. */ }
      finally { pending = false; }
    };
    const timer = setInterval(() => void sync(), 5000);
    const focus = () => void sync();
    window.addEventListener("focus", focus);
    return () => { disposed = true; clearInterval(timer); window.removeEventListener("focus", focus); };
  }, [runtime]);
  const upload = async (file: File) => {
    const id = await getThreadId();
    const name = file.name.replace(/[^a-zA-Z0-9._-]/g, "-").replace(/^\.+/, "").slice(-120) || "priloha.txt";
    const path = `${crypto.randomUUID()}-${name}`;
    await api.uploadFile({ scope: "temp", path, thread: id }, file);
    return path;
  };

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <ThreadIdContext.Provider value={() => idRef.current}>
        <div className="relative h-full">
          <UploadContext.Provider value={upload}><Thread /></UploadContext.Provider>
          {thread && !scratchpad && (
            <button onClick={() => setScratchpad(true)} className="btn-secondary absolute end-4 top-3 z-10 text-sm" title={t("chat:scratchpad.hint")}>
              {t("chat:scratchpad.open")}
            </button>
          )}
          {thread && scratchpad && (
            <aside className="absolute inset-y-0 end-0 z-30 flex w-[min(56rem,100%)] flex-col border-s border-line bg-canvas shadow-xl" aria-label={t("chat:scratchpad.title")}>
              <button onClick={() => setScratchpad(false)} className="btn-secondary absolute end-4 top-3 z-10 text-sm">
                {t("close")}
              </button>
              <div className="min-h-0 flex-1">
                <Files key={runs} location={{ scope: "temp", thread }} title={t("chat:scratchpad.title")} intro={t("chat:scratchpad.intro")} />
              </div>
            </aside>
          )}
        </div>
      </ThreadIdContext.Provider>
    </AssistantRuntimeProvider>
  );
}
