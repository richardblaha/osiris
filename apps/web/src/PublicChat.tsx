import { Pending } from "./Scope.tsx";
import { AssistantRuntimeProvider, useLocalRuntime, type ThreadMessageLike } from "@assistant-ui/react";
import type { ChatQuestion, PublicInfo, ThreadMessage } from "@osiris/shared";
import { useEffect, useMemo, useRef, useState } from "react";
import { readEvents } from "./api.ts";
import { createAdapter, toInitialMessages } from "./chat/adapter.ts";
import { QuestionLoaderContext } from "./chat/Question.tsx";
import { Thread, ThreadIdContext } from "./chat/Thread.tsx";
import { t } from "i18next";
import { Trans } from "react-i18next";
import { currentLocale } from "./i18n.ts";

/** Per-browser conveniences only: without storage every visit is a new conversation. */
const remember = (key: string, make?: () => string) => {
  try {
    let v = localStorage.getItem(key);
    if (!v && make) localStorage.setItem(key, (v = make()));
    return v;
  } catch {
    return make?.() ?? null;
  }
};
const forget = (key: string, value?: string) => {
  try {
    if (value) localStorage.setItem(key, value);
    else localStorage.removeItem(key);
  } catch {
    // See remember.
  }
};
const randomId = () => btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(24)))).replace(/[+/=]/g, (c) => ({ "+": "-", "/": "_", "=": "" })[c]!);

/** A public assistant's API, as the browser's anonymous visitor (the gateway's /public/<tenant>/<assistant>). */
function publicApi(tenant: string, assistant: string) {
  const visitor = remember("osiris.visitor", randomId)!;
  const call = async (path: string, init: RequestInit = {}) => {
    const res = await fetch(`/public/${encodeURIComponent(tenant)}/${encodeURIComponent(assistant)}${path}`, {
      ...init,
      headers: { "x-visitor-id": visitor, "content-type": "application/json", "accept-language": currentLocale(), ...init.headers },
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      throw Object.assign(new Error(body?.error ?? t("public:httpError", { status: res.status })), { status: res.status });
    }
    return res;
  };
  return {
    question: async (thread: string, id: string) => (await (await call(`/threads/${thread}/questions/${id}`)).json()) as ChatQuestion,
    info: async () => (await (await call("/info")).json()) as PublicInfo,
    createThread: async () => ((await (await call("/threads", { method: "POST" })).json()) as { id: string }).id,
    messages: async (id: string) => (await (await call(`/threads/${id}/messages`)).json()) as ThreadMessage[],
    async *run(id: string, message: string, signal: AbortSignal) {
      yield* readEvents(await call(`/threads/${id}/runs`, { method: "POST", body: JSON.stringify({ message }), signal }));
    },
  };
}

/**
 * One of the tenant's assistants for its customers, without signing in: /c/<tenant>/<assistant> (without the
 * assistant, the tenant's first), full page or (?embed=1) inside the widget on the tenant's website. The
 * conversation continues on the next visit from the same browser.
 */
export function PublicChat({ tenant, assistant = "_" }: { tenant: string; assistant?: string }) {
  const client = useMemo(() => publicApi(tenant, assistant), [tenant, assistant]);
  const threadKey = `osiris.publicThread.${tenant}${assistant === "_" ? "" : `.${assistant}`}`;
  const [info, setInfo] = useState<PublicInfo>();
  const [initial, setInitial] = useState<ThreadMessageLike[]>();
  const [error, setError] = useState<string>();
  const embedded = new URLSearchParams(location.search).has("embed");

  useEffect(() => {
    (async () => {
      const i = await client.info();
      setInfo(i);
      if (!i.enabled) return;
      const saved = remember(threadKey);
      const history = saved ? await client.messages(saved).catch(() => (forget(threadKey), [])) : [];
      setInitial(toInitialMessages(history));
    })().catch((e: Error) => setError(e.message));
  }, [client]);

  useEffect(() => {
    if (info?.title) document.title = info.title;
  }, [info]);

  return (
    <div className="flex h-full flex-col bg-canvas">
      {!embedded && info?.title && (
        <header className="border-b border-line px-4 py-3 text-center font-semibold">{info.title}</header>
      )}
      <div className="min-h-0 flex-1">
        {error ? (
          <p className="notice notice-error m-6 px-3 py-2 text-sm">{error}</p>
        ) : info && !info.enabled ? (
          <p className="m-6 text-center text-fg-secondary">{t("public:unavailable")}</p>
        ) : !info || !initial ? (
          <Pending className="relative h-full" />
        ) : (
          <Chat client={client} threadKey={threadKey} initial={initial} greeting={info.greeting} />
        )}
      </div>
      <footer className="py-1 text-center text-[11px] text-fg-muted">
        <Trans ns="public" i18nKey="footer" components={{ a: <a href="https://osiris.k6labs.cz" target="_blank" rel="noreferrer" className="underline" /> }} />
      </footer>
    </div>
  );
}

function Chat({ client, threadKey, initial, greeting }: { client: ReturnType<typeof publicApi>; threadKey: string; initial: ThreadMessageLike[]; greeting: string }) {
  const id = useRef(remember(threadKey));
  const adapter = useMemo(
    () =>
      createAdapter(
        async () => {
          if (!id.current) forget(threadKey, (id.current = await client.createThread()));
          return id.current;
        },
        () => {},
        { stream: client.run, showTools: false },
      ),
    [client],
  );
  const runtime = useLocalRuntime(adapter, { initialMessages: initial });
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <ThreadIdContext.Provider value={() => id.current}>
        <QuestionLoaderContext.Provider value={client.question}>
          <Thread greeting={greeting || t("public:defaultGreeting")} placeholder={t("public:placeholder")} />
        </QuestionLoaderContext.Provider>
      </ThreadIdContext.Provider>
    </AssistantRuntimeProvider>
  );
}
