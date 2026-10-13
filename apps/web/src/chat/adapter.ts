import type { ChatModelAdapter, ThreadAssistantMessagePart, ThreadMessageLike } from "@assistant-ui/react";
import type { ThreadMessage } from "@osiris/shared";
import { api } from "../api.ts";

type Part = ThreadAssistantMessagePart;

/**
 * Bridges assistant-ui's local runtime to the API. The server keeps the conversation in its
 * checkpointer, so only the newest user message is sent; `getThreadId` creates the thread on first send.
 */
export function createAdapter(getThreadId: () => Promise<string>, onDone: () => void): ChatModelAdapter {
  return {
    async *run({ messages, abortSignal }) {
      const last = messages.at(-1);
      const text = last?.content.map((p) => (p.type === "text" ? p.text : "")).join("") ?? "";
      const threadId = await getThreadId();

      let parts: Part[] = [];
      try {
        for await (const event of api.run(threadId, text, abortSignal)) {
          switch (event.type) {
            case "text-delta": {
              const tail = parts.at(-1);
              parts =
                tail?.type === "text"
                  ? [...parts.slice(0, -1), { ...tail, text: tail.text + event.delta }]
                  : [...parts, { type: "text", text: event.delta }];
              break;
            }
            case "tool-call":
              parts = [
                ...parts,
                {
                  type: "tool-call",
                  toolCallId: event.toolCallId,
                  toolName: event.toolName,
                  args: event.args as never,
                  argsText: JSON.stringify(event.args),
                },
              ];
              break;
            case "tool-result":
              parts = parts.map((p) => (p.type === "tool-call" && p.toolCallId === event.toolCallId ? { ...p, result: event.result } : p));
              break;
            case "error":
              throw new Error(event.message);
            case "done":
              break;
          }
          yield { content: parts };
        }
      } finally {
        onDone();
      }
    },
  };
}

export function toInitialMessages(messages: ThreadMessage[]): ThreadMessageLike[] {
  return messages.map((m) => ({
    id: m.id,
    role: m.role,
    content: m.content.map((p) =>
      p.type === "text" ? p : { ...p, args: p.args as never, argsText: JSON.stringify(p.args) },
    ),
  }));
}
