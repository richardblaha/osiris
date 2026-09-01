# Change Log

All notable changes to the `osiris-ai` extension are documented here.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added

- Provider-agnostic agent orchestrator with a bounded tool-use loop.
- `echo` (offline) and `openai-compatible` (streaming) provider adapters.
- MCP stdio client (JSON-RPC 2.0) and a registry that exposes MCP tools to the agent.
- React agent panel webview with streaming output and inline tool-call cards.
- Built-in `workspace.listFiles` / `workspace.readFile` / `workspace.showMessage` tools.
