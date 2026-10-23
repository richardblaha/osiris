import { displayUserText } from "./questions.ts";
import { AIMessage, AIMessageChunk, HumanMessage, ToolMessage, type BaseMessage } from "@langchain/core/messages";
import type { MessagePart, RunEvent, RunStatus, ThreadMessage } from "@osiris/shared";
import type { RunContext } from "./context.ts";
import type { AgentGraph } from "./graph.ts";

/** The graph's nodes as what the user is told the run is doing. */
const NODE_STATUS: Record<string, RunStatus> = { agent: "thinking", tools: "tools", guard_in: "checking", guard_out: "checking" };

/**
 * Runs one user turn and yields UI events: what it's doing (each node as it starts), streamed text tokens, a tool
 * call as soon as the model starts writing it, then its arguments and result as each node finishes.
 * `guarded` (rules apply to the run): the answer is only sent once the output check passed (or replaced it), so no
 * part of an answer breaking the rules ever reaches the user.
 */
export async function* streamRun(
  graph: AgentGraph,
  ctx: RunContext,
  text: string,
  signal?: AbortSignal,
  { guarded = false, input }: { guarded?: boolean; input?: HumanMessage } = {},
): AsyncGenerator<RunEvent> {
  const stream = await graph.stream(
    { messages: [input ?? new HumanMessage({ content: text, additional_kwargs: { display_text: displayUserText(text, ctx.locale) } })] },
    { configurable: { ...ctx }, streamMode: ["messages", "updates", "tasks", "custom"], signal },
  );

  let held = "";
  const announced = new Set<string>();
  for await (const [mode, data] of stream) {
    if (mode === "custom") {
      if (data && typeof data === "object" && data.type === "image-progress" && typeof data.id === "string" && typeof data.status === "string") yield data as RunEvent;
      continue;
    }
    if (mode === "tasks") {
      // A task's start has no result yet. The rules' nodes pass straight through when there are none.
      const status = NODE_STATUS[data.name];
      if (status && !("result" in data) && (guarded || status !== "checking")) yield { type: "status", status };
      continue;
    }
    if (guarded && mode === "updates") {
      for (const [node, message] of nodeMessages(data)) {
        if (!AIMessage.isInstance(message) || message.tool_calls?.length) continue;
        // The agent's answer waits for guard_out, which may replace it; guard_in's refusal goes out at once.
        if (node === "agent" || node === "guard_out") held = message.text;
        else if (node === "guard_in") yield { type: "text-delta", delta: message.text };
      }
    }
    if (mode === "messages") {
      const [chunk, meta] = data;
      if (meta?.langgraph_node !== "agent") continue;
      // A tool call shows as soon as its name comes, long before its arguments (a whole file) are written. Not text,
      // so it goes out even when the answer waits for the rules check.
      if (AIMessageChunk.isInstance(chunk)) {
        for (const call of chunk.tool_call_chunks ?? []) {
          const id = call.id ?? `pending:${call.index ?? 0}`;
          if (!call.name || announced.has(id)) continue;
          announced.add(id);
          yield { type: "tool-call-start", toolCallId: id, toolName: call.name };
        }
      }
      if (guarded) continue;
      // Streaming models emit AIMessageChunks; non-streaming ones emit the whole AIMessage once.
      const isAi = AIMessageChunk.isInstance(chunk) || AIMessage.isInstance(chunk);
      if (isAi && chunk.text) yield { type: "text-delta", delta: chunk.text };
    } else if (mode === "updates") {
      for (const message of updatedMessages(data)) {
        if (AIMessage.isInstance(message)) {
          for (const call of message.tool_calls ?? []) {
            yield { type: "tool-call", toolCallId: call.id ?? "", toolName: call.name, args: call.args };
          }
        } else if (ToolMessage.isInstance(message)) {
          yield { type: "tool-result", toolCallId: message.tool_call_id, result: message.text };
        }
      }
    }
  }
  if (held) yield { type: "text-delta", delta: held };
  yield { type: "done" };
}

function nodeMessages(update: unknown): [string, BaseMessage][] {
  if (!update || typeof update !== "object") return [];
  return Object.entries(update).flatMap(([node, nodeUpdate]) =>
    nodeUpdate && typeof nodeUpdate === "object" && "messages" in nodeUpdate && Array.isArray(nodeUpdate.messages)
      ? (nodeUpdate.messages as BaseMessage[]).map((m): [string, BaseMessage] => [node, m])
      : [],
  );
}

function updatedMessages(update: unknown): BaseMessage[] {
  if (!update || typeof update !== "object") return [];
  return Object.values(update).flatMap((nodeUpdate) =>
    nodeUpdate && typeof nodeUpdate === "object" && "messages" in nodeUpdate && Array.isArray(nodeUpdate.messages)
      ? (nodeUpdate.messages as BaseMessage[])
      : [],
  );
}

/** Converts checkpointed LangGraph messages to the UI shape, attaching tool results to their calls. */
export function toThreadMessages(messages: BaseMessage[]): ThreadMessage[] {
  const out: ThreadMessage[] = [];
  const toolParts = new Map<string, Extract<MessagePart, { type: "tool-call" }>>();

  for (const m of messages) {
    if (HumanMessage.isInstance(m)) {
      out.push({ id: m.id ?? crypto.randomUUID(), role: "user", content: [{ type: "text", text: typeof m.additional_kwargs.display_text === "string" ? m.additional_kwargs.display_text : m.text }] });
    } else if (AIMessage.isInstance(m)) {
      // Consecutive model turns (text → tool call → text) render as one assistant message.
      let target = out.at(-1);
      if (target?.role !== "assistant") {
        target = { id: m.id ?? crypto.randomUUID(), role: "assistant", content: [] };
        out.push(target);
      }
      if (m.text) target.content.push({ type: "text", text: m.text });
      for (const call of m.tool_calls ?? []) {
        const part: MessagePart = { type: "tool-call", toolCallId: call.id ?? "", toolName: call.name, args: call.args };
        toolParts.set(part.toolCallId, part);
        target.content.push(part);
      }
    } else if (ToolMessage.isInstance(m)) {
      const part = toolParts.get(m.tool_call_id);
      if (part) part.result = m.text;
    }
  }
  return out;
}
