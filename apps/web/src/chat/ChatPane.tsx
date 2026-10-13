import { AssistantRuntimeProvider, useLocalRuntime, type ThreadMessageLike } from "@assistant-ui/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api.ts";
import { createAdapter, toInitialMessages } from "./adapter.ts";
import { Thread } from "./Thread.tsx";

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
  if (!initial) return <p className="p-6 text-fg-muted">Načítám…</p>;
  return <Chat threadId={threadId} initial={initial} onThreadCreated={onThreadCreated} onRunFinished={onRunFinished} />;
}

function Chat({ threadId, initial, onThreadCreated, onRunFinished }: Props & { initial: ThreadMessageLike[] }) {
  const idRef = useRef(threadId);
  const callbacks = useRef({ onThreadCreated, onRunFinished });
  callbacks.current = { onThreadCreated, onRunFinished };

  const adapter = useMemo(
    () =>
      createAdapter(
        async () => {
          if (!idRef.current) {
            idRef.current = (await api.createThread()).id;
            callbacks.current.onThreadCreated(idRef.current);
          }
          return idRef.current;
        },
        () => callbacks.current.onRunFinished(),
      ),
    [],
  );
  const runtime = useLocalRuntime(adapter, { initialMessages: initial });

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <Thread />
    </AssistantRuntimeProvider>
  );
}
