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
};

function ToolCall({ toolName, args, result }: ToolCallMessagePartProps) {
  const label = TOOL_LABELS[toolName]?.(args as Record<string, unknown>) ?? toolName;
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
    <ThreadPrimitive.Root className="flex h-full flex-col">
      <ThreadPrimitive.Viewport className="flex-1 overflow-y-auto px-4">
        <div className="mx-auto max-w-3xl py-6">
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
      </ThreadPrimitive.Viewport>
      <div className="border-t border-line bg-sidebar px-4 py-3">
        <ComposerPrimitive.Root className="mx-auto flex max-w-3xl items-end gap-2">
          <ComposerPrimitive.Input
            autoFocus
            placeholder="Napiš zprávu…"
            className="field max-h-40 flex-1 resize-none"
          />
          <ThreadPrimitive.If running={false}>
            <ComposerPrimitive.Send className="btn-primary">
              Odeslat
            </ComposerPrimitive.Send>
          </ThreadPrimitive.If>
          <ThreadPrimitive.If running>
            <ComposerPrimitive.Cancel className="btn-secondary">Zastavit</ComposerPrimitive.Cancel>
          </ThreadPrimitive.If>
        </ComposerPrimitive.Root>
      </div>
    </ThreadPrimitive.Root>
  );
}
