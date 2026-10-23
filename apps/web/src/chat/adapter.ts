import type { ChatModelAdapter, ThreadAssistantMessagePart, ThreadMessageLike } from "@assistant-ui/react";
import { applyTelemetry, asWorkflowView, QUESTION_TOOLS, type RunStatus, type ThreadMessage } from "@osiris/shared";

const WORKFLOW_TOOL = "run_workflow";
import { api } from "../api.ts";

type Part = ThreadAssistantMessagePart;

/**
 * Bridges assistant-ui's local runtime to the API. The server keeps the conversation in its
 * checkpointer, so only the newest user message is sent; `getThreadId` creates the thread on first send.
 */
export function createAdapter(
  getThreadId: () => Promise<string>,
  onDone: () => void,
  /** Where the run's events come from (the public chat has its own API); `showTools: false` hides tool calls. */
  { stream = api.run, showTools = true }: { stream?: typeof api.run; showTools?: boolean } = {},
): ChatModelAdapter {
  return {
    async *run({ messages, abortSignal }) {
      const last = messages.at(-1);
      const text = last?.content.map((p) => (p.type === "text" ? p.text : "")).join("") ?? "";
      const threadId = await getThreadId();

      let parts: Part[] = [];
      // What the run is doing now, for the line under the message (`metadata.custom.status`).
      let status: RunStatus | undefined;
      let imageProgress: { id: string; status: string; progress?: { value: number; max: number } } | undefined;
      try {
        for await (const event of stream(threadId, text, abortSignal)) {
          switch (event.type) {
            case "text-delta": {
              const tail = parts.at(-1);
              parts =
                tail?.type === "text"
                  ? [...parts.slice(0, -1), { ...tail, text: tail.text + event.delta }]
                  : [...parts, { type: "text", text: event.delta }];
              break;
            }
            case "image-progress":
              imageProgress = event;
              break;
            case "status":
              status = event.status;
              break;
            case "tool-call-start":
              if ((!showTools && !QUESTION_TOOLS.includes(event.toolName)) || parts.some((p) => p.type === "tool-call" && p.toolCallId === event.toolCallId)) break;
              // Arguments still being written: shown as a step in progress.
              parts = [...parts, { type: "tool-call", toolCallId: event.toolCallId, toolName: event.toolName, args: {} as never, argsText: "" }];
              break;
            case "tool-call": {
              if (!showTools && !QUESTION_TOOLS.includes(event.toolName)) break;
              const part: Part = {
                type: "tool-call",
                toolCallId: event.toolCallId,
                toolName: event.toolName,
                args: event.args as never,
                argsText: JSON.stringify(event.args),
              };
              // Its announcement, by id, or (a model without ids in its stream) the first announced one of that tool.
              const i = parts.findIndex(
                (p) => p.type === "tool-call" && (p.toolCallId === event.toolCallId || (p.toolCallId.startsWith("pending:") && p.toolName === event.toolName)),
              );
              parts = i < 0 ? [...parts, part] : parts.map((p, k) => (k === i ? part : p));
              break;
            }
            case "tool-result":
              parts = parts.map((p) =>
                p.type === "tool-call" && p.toolCallId === event.toolCallId ? { ...p, result: event.result, ...(event.artifact === undefined ? {} : { artifact: event.artifact }) } : p,
              );
              break;
            case "telemetry": {
              // A workflow's events belong to the run_workflow call still running.
              const i = parts.findLastIndex((p) => p.type === "tool-call" && p.toolName === WORKFLOW_TOOL && p.result === undefined);
              if (i < 0) break;
              parts = parts.map((p, k) => (k === i && p.type === "tool-call" ? { ...p, artifact: applyTelemetry(asWorkflowView(p.artifact), event.event) } : p));
              break;
            }
            case "error":
              throw new Error(event.message);
            case "done":
              break;
          }
          yield { content: parts, metadata: { custom: { status: event.type === "done" ? undefined : status, imageProgress: event.type === "done" ? undefined : imageProgress } } };
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
