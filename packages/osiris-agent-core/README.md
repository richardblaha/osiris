# @richardblaha/osiris-agent-core

The provider-agnostic agent loop plus the portable snapshot that lets a running
session be **frozen and resumed** on another machine.

| Module            | Exports                                                                              |
| ----------------- | ---------------------------------------------------------------------------------- |
| `orchestrator.ts` | `AgentOrchestrator` — ask → stream text → run tool calls → repeat until stop / `maxIterations` |
| `providers/`      | `AnthropicAdapter` (official SDK, adaptive thinking), `OpenAiCompatibleAdapter` (OpenAI · Mistral · gateways), `OllamaAdapter` (native `/api/chat` — `format` for JSON-schema grammar, `options`, `keep_alive`), `EchoProviderAdapter` (offline) |
| `snapshot.ts`     | `AgentSnapshot` (conversation · tasks · working set · provider — **no API keys**), `JsonSnapshotStore`, `MemorySnapshotStore`, `pendingTasks()` |
| `session.ts`      | `AgentSession` — owns the snapshot, records turns, tracks tasks, `persist()` for handover |

```ts
import { AgentOrchestrator, AnthropicAdapter, AgentSession, JsonSnapshotStore } from '@richardblaha/osiris-agent-core';

const store = new JsonSnapshotStore('/workspace/.osiris/agent-state.json');
const session =
  (await AgentSession.restore(store)) ??
  AgentSession.create(store, {
    sessionId, origin: 'desktop',
    provider: { name: 'anthropic', model: 'claude-opus-5' },
  });

const agent = new AgentOrchestrator(new AnthropicAdapter({ model: session.toSnapshot().provider.model }));
const result = await agent.run({ prompt, history: session.conversation });
session.recordTurn(result.messages);
await session.persist();          // freeze point for "Handover to Server"
```

The snapshot lives inside the workspace volume (`/<workspace>/.osiris/`), so it
migrates with it; on resume the agent re-hydrates and continues `pendingTasks()`.
Adapted from the `osiris-ai` extension's agent; MCP tool integration stays in the
extension and plugs in through the `Tool` interface. Pure ESM, `tsc` to `dist/`.
