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
    <details className="my-2 rounded-md border border-neutral-200 bg-neutral-50 px-3 py-2 text-sm text-neutral-600">
      <summary className="cursor-pointer">
        {result === undefined ? "⏳ " : "✓ "}
        {label}
      </summary>
      {result !== undefined && <pre className="mt-2 whitespace-pre-wrap text-xs">{String(result)}</pre>}
    </details>
  );
}

function UserMessage() {
  return (
    <MessagePrimitive.Root className="flex justify-end py-2">
      <div className="max-w-[80%] rounded-2xl bg-neutral-900 px-4 py-2 text-white whitespace-pre-wrap">
        <MessagePrimitive.Parts />
      </div>
    </MessagePrimitive.Root>
  );
}

function AssistantMessage() {
  return (
    <MessagePrimitive.Root className="py-2">
      <div className="markdown max-w-[90%] text-neutral-900">
        <MessagePrimitive.Parts
          components={{ Text: () => <MarkdownTextPrimitive />, tools: { Fallback: ToolCall } }}
        />
        <MessagePrimitive.Error>
          <p className="mt-2 text-sm text-red-600">Něco se pokazilo. Zkus to znovu.</p>
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
            <p className="mt-24 text-center text-neutral-500">S čím ti můžu pomoct?</p>
          </ThreadPrimitive.Empty>
          <ThreadPrimitive.Messages>
            {({ message }) => (message.role === "user" ? <UserMessage /> : <AssistantMessage />)}
          </ThreadPrimitive.Messages>
        </div>
      </ThreadPrimitive.Viewport>
      <div className="border-t border-neutral-200 px-4 py-3">
        <ComposerPrimitive.Root className="mx-auto flex max-w-3xl items-end gap-2">
          <ComposerPrimitive.Input
            autoFocus
            placeholder="Napiš zprávu…"
            className="max-h-40 flex-1 resize-none rounded-xl border border-neutral-300 px-3 py-2 outline-none focus:border-neutral-500"
          />
          <ThreadPrimitive.If running={false}>
            <ComposerPrimitive.Send className="rounded-xl bg-neutral-900 px-4 py-2 text-white disabled:opacity-40">
              Odeslat
            </ComposerPrimitive.Send>
          </ThreadPrimitive.If>
          <ThreadPrimitive.If running>
            <ComposerPrimitive.Cancel className="rounded-xl border border-neutral-300 px-4 py-2">Zastavit</ComposerPrimitive.Cancel>
          </ThreadPrimitive.If>
        </ComposerPrimitive.Root>
      </div>
    </ThreadPrimitive.Root>
  );
}
