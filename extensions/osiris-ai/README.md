# Osiris AI

AI agent orchestration for Osiris IDE, with **Model Context Protocol (MCP)**
support and a custom agent panel.

## Features

- **Agent panel** — a React webview in the activity bar. Type a prompt; the agent
  streams its reply, shows every tool call inline, and can be cancelled.
- **Provider-agnostic orchestrator** — a bounded tool-use loop
  (`osiris-ai.maxIterations`) over any `ProviderAdapter`. Ships two:
  - `echo` — offline, deterministic (default; great for a first run and tests).
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

No model SDK is bundled — the concrete backend is entirely user-configured.

## Architecture

| Module                           | Responsibility                        | vscode? |
| -------------------------------- | ------------------------------------- | ------- |
| `src/agent/orchestrator.ts`      | provider-agnostic tool-use loop       | no      |
| `src/agent/providers.ts`         | `echo` + `openai-compatible` adapters | no      |
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
