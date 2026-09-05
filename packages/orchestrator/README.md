# @osiris/orchestrator

The lightweight TypeScript stand-in for the **.NET Aspire AppHost**. One
declarative `StackSpec` describes the local dependency environment; the
`Orchestrator` drives it onto Docker through [`dockerode`](https://github.com/apocas/dockerode).

| Module        | Exports                                                                              |
| ------------- | ----------------------------------------------------------------------------------- |
| `stack.ts`    | `StackSpec`, `ServiceSpec`, `defaultStack()`, `stackModel()` — collector · dashboard · Ollama · sync worker |
| `ollama.ts`   | `ensureOllamaModel()` + `DEFAULT_OLLAMA_IMAGE` / `DEFAULT_LOCAL_MODEL`              |
| `runner.ts`   | `Orchestrator` — `up()` / `down()` / `status()` over the Docker engine              |
| `topo.ts`     | `topoSort()` — start-order resolution, fails fast on cycles / unknown deps          |
| `compose.ts`  | `toComposeDocument()` — render the same spec as a `docker compose` file             |

```ts
import { Orchestrator, defaultStack, ensureOllamaModel, stackModel } from '@osiris/orchestrator';

const spec = defaultStack({ dashboard: 'aspire' }); // or { model: 'qwen3:1.7b' }
const orchestrator = new Orchestrator();
await orchestrator.up(spec);          // ollama · otel-collector · dashboard · sync-worker
await ensureOllamaModel(stackModel(spec)); // pull the chat model on first run (cached in the volume)
// … wire OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 into the extension host
```

## Local model

`defaultStack()` pins `ollama/ollama` to a release recent enough for Qwen3 and
streamed tool-calls, and records the chat model to pull as `OSIRIS_LOCAL_MODEL`
on the `ollama` service. The default is **`qwen3:4b`** (Apache-2.0, ~2.6 GB at
Q4_K_M) — small enough to ship with the install, capable enough for Osiris
orchestration and features like the backlog.

An embedding model (`nomic-embed-text`, ~274 MB) is pulled alongside it by
default — it powers `@osiris/memory` retrieval far better than the built-in hash
fallback. Disable with `defaultStack({ embedModel: null })` / `--no-embed-model`.

`ensureOllamaModel()` is idempotent: one `GET /api/tags` when the model is
already there, a streamed `POST /api/pull` (with progress) when it is not.
`ensureOllamaModels([...])` runs several in sequence. The blobs live in the
`osiris-ollama` volume, so the download happens once per install and survives
container recreation.

## CLI

```bash
osiris-orchestrator up --dashboard aspire            # pulls qwen3:4b after the stack is healthy
osiris-orchestrator up --model qwen3:1.7b            # smaller model
osiris-orchestrator up --no-model                    # skip the pull
osiris-orchestrator status
osiris-orchestrator down
```

Telemetry from the orchestrator itself flows through `@opentelemetry/api`; start
`@richardblaha/telemetry` in the host process to export it.

Pure ESM, built with `tsc` to `dist/`. Tests cover the pure logic (`topo`,
`stack`, `compose`); `runner` needs a live Docker socket and is exercised in the
desktop smoke test.
