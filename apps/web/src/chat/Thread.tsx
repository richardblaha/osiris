import {
  ComposerPrimitive,
  MessagePrimitive,
  ThreadPrimitive,
  type ToolCallMessagePartProps,
} from "@assistant-ui/react";
import { MarkdownTextPrimitive } from "@assistant-ui/react-markdown";

const TOOL_LABELS: Record<string, (args: Record<string, unknown>) => string> = {
  search_knowledge: (a) => `Hledám ve znalostní bázi: „${String(a.query ?? "")}“`,
  load_skill: (a) => `Načítám postup: ${String(a.name ?? "")}`,
  remember: (a) => `Zapamatovávám si: ${String(a.content ?? "")}`,
  forget: () => "Mažu záznam z paměti",
  http_request: (a) => {
    const url = String(a.url ?? "");
    const host = /^https?:\/\/([^/?#]+)/.exec(url)?.[1] ?? url;
    return `Volám ${String(a.method ?? "GET")} ${host}`;
  },
};

function ToolCall({ toolName, args, result }: ToolCallMessagePartProps) {
  // Other names are tools of the tenant's MCP servers (`<server>_<tool>`).
  const label = TOOL_LABELS[toolName]?.(args as Record<string, unknown>) ?? `Nástroj ${toolName}`;
  return (
    <details className="notice my-2 px-3 py-2 text-sm text-fg-secondary">
      <summary className="cursor-pointer">
        {result === undefined ? "⏳ " : <span className="text-success">✓ </span>}
        {label}
      </summary>
      {result !== undefined && <pre className="mt-2 whitespace-pre-wrap text-xs text-fg-muted">{String(result)}</pre>}
    </details>
  );
}

function UserMessage() {
  return (
    <MessagePrimitive.Root className="flex justify-end py-2">
      <div className="max-w-[80%] rounded-sm border border-line-strong bg-selection px-4 py-2 whitespace-pre-wrap">
        <MessagePrimitive.Parts />
      </div>
    </MessagePrimitive.Root>
  );
}

function AssistantMessage() {
  return (
    <MessagePrimitive.Root className="py-2">
      <div className="markdown max-w-[90%]">
        <MessagePrimitive.Parts
          components={{ Text: () => <MarkdownTextPrimitive />, tools: { Fallback: ToolCall } }}
        />
        <MessagePrimitive.Error>
          <p className="notice notice-error mt-2 px-3 py-2 text-sm">Něco se pokazilo. Zkus to znovu.</p>
        </MessagePrimitive.Error>
      </div>
    </MessagePrimitive.Root>
  );
}

export function Thread() {
  return (
    <ThreadPrimitive.Root className="h-full">
      <ThreadPrimitive.Viewport className="flex h-full flex-col overflow-y-auto px-4">
        <div className="mx-auto w-full max-w-3xl flex-1 py-6">
          <ThreadPrimitive.Empty>
            <div className="mt-24 flex flex-col items-center gap-4 text-fg-secondary">
              <img src="/logo.svg" alt="" className="h-16 w-16 opacity-90" />
              <p>S čím ti můžu pomoct?</p>
            </div>
          </ThreadPrimitive.Empty>
          <ThreadPrimitive.Messages>
            {({ message }) => (message.role === "user" ? <UserMessage /> : <AssistantMessage />)}
          </ThreadPrimitive.Messages>
        </div>
        {/* The composer floats over the conversation, which scrolls underneath it. */}
        <ThreadPrimitive.ViewportFooter className="sticky bottom-0 mx-auto w-full max-w-3xl bg-gradient-to-t from-canvas from-70% pb-4 pt-2">
          <ComposerPrimitive.Root className="composer relative rounded-md border border-line-strong bg-input shadow-lg">
            <ComposerPrimitive.Input
              autoFocus
              placeholder="Napiš zprávu…"
              minRows={3}
              maxRows={12}
              className="block w-full resize-none bg-transparent px-4 pt-3 pb-12 outline-none"
            />
            <div className="absolute right-2 bottom-2">
              <ThreadPrimitive.If running={false}>
                <ComposerPrimitive.Send className="icon-button btn-primary" aria-label="Odeslat" title="Odeslat (Enter)">
                  <svg viewBox="0 0 24 24" className="h-5 w-5" aria-hidden="true">
                    <path d="M12 19V5M5 12l7-7 7 7" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </ComposerPrimitive.Send>
              </ThreadPrimitive.If>
              <ThreadPrimitive.If running>
                <ComposerPrimitive.Cancel className="icon-button btn-secondary" aria-label="Zastavit" title="Zastavit">
                  <svg viewBox="0 0 24 24" className="h-4 w-4" aria-hidden="true">
                    <rect x="6" y="6" width="12" height="12" rx="1.5" fill="currentColor" />
                  </svg>
                </ComposerPrimitive.Cancel>
              </ThreadPrimitive.If>
            </div>
          </ComposerPrimitive.Root>
        </ThreadPrimitive.ViewportFooter>
      </ThreadPrimitive.Viewport>
    </ThreadPrimitive.Root>
  );
}
