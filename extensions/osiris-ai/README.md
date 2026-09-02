# Osiris AI

AI agent orchestration for Osiris IDE, with **Model Context Protocol (MCP)**
support and a custom agent panel.

## Features

- **Agent panel** — a React webview in the activity bar. Type a prompt; the agent
  streams its reply, shows every tool call inline, and can be cancelled.
- **Provider-agnostic orchestrator** — a bounded tool-use loop
  (`osiris-ai.maxIterations`) over any `ProviderAdapter`. The chat model comes
  from **`osiris.models.chat`** (set via *Osiris: Configure Models…*) — a
  `<provider>/<model>` spec resolved to an `ollama` / `anthropic` /
  `openai-compatible` / `echo` adapter. When it is unset the legacy
  `osiris-ai.provider` applies:
  - `ollama` — the local model in the Osiris stack (default;
    `osiris-ai.ollamaModel`, `osiris-ai.ollamaUrl`, else `OSIRIS_OLLAMA_URL`).
    Falls back to `echo` when the server is unreachable.
  - `echo` — offline, deterministic (great for tests and air-gapped runs).
  - `openai-compatible` — streams from any OpenAI-style `/chat/completions`
    endpoint (`osiris-ai.endpoint`, `osiris-ai.model`, `osiris-ai.apiKeyEnv`).
- **MCP client** — launches the stdio servers listed in `osiris-ai.mcpServers`,
  speaks JSON-RPC 2.0 (`initialize` / `tools/list` / `tools/call` /
  `resources/list`), and exposes their tools to the agent namespaced as
  `<serverId>.<tool>`.
- **Built-in workspace tools** — `workspace.listFiles`, `workspace.readFile`,
  `workspace.showMessage`.

## Configuration

```jsonc
{
  // default — the local model the Osiris stack pulls on first run
  "osiris-ai.provider": "ollama",
  "osiris-ai.ollamaModel": "qwen3:4b",

  // or point at a hosted endpoint
  "osiris-ai.provider": "openai-compatible",
  "osiris-ai.endpoint": "https://api.example.com/v1",
  "osiris-ai.model": "some-model",
  "osiris-ai.apiKeyEnv": "OSIRIS_AI_API_KEY",

  "osiris-ai.mcpServers": [
    {
      "id": "fs",
      "transport": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "."],
    },
  ],
}
```

No hosted-model SDK is bundled; `ollama` talks to the local server in the Osiris
stack and every other backend is user-configured.

## Architecture

| Module                           | Responsibility                        | vscode? |
| -------------------------------- | ------------------------------------- | ------- |
| `src/agent/orchestrator.ts`      | provider-agnostic tool-use loop       | no      |
| `src/agent/providers.ts`         | `ollama` / `echo` / openai-compatible | no      |
| `src/mcp/client.ts`              | MCP stdio JSON-RPC client             | no      |
| `src/mcp/registry.ts`            | MCP lifecycle → orchestrator tools    | no      |
| `src/panel/AgentViewProvider.ts` | webview host + run driver             | yes     |
| `src/tools/builtins.ts`          | workspace tools                       | yes     |
| `webview/main.tsx`               | React agent panel                     | browser |

`vitest` covers the orchestrator (fake providers/tools) and the MCP client +
registry (against `test/fixtures/mock-mcp-server.mjs`).

## Development

```bash
pnpm --filter osiris-ai build     # esbuild → dist/extension.js + media/panel.{js,css}
pnpm --filter osiris-ai test
pnpm --filter osiris-ai package
```
