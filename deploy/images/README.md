# Conversational images through Comfy Cloud

The existing project LangGraph agent provides image generation and editing through its native tool registry. It reuses the MCP adapter, OAuth, project vault, libSQL database/checkpointer, file storage, usage accounting, streaming, PWA and WhatsApp delivery. No separate agent, queue, server, database or mandatory paid service is introduced.

## Configuration and authentication

Enable `IMAGE_GENERATION_ENABLED=true` in the runtime environment. Two authentication paths are supported:

- **Runtime API key:** set `COMFY_API_KEY` securely. At project initialization it is sealed into the existing project vault, restricted to `cloud.comfy.org`, and a missing `comfy-cloud` MCP connection is created at `https://cloud.comfy.org/mcp`. Existing vault values, OAuth connections and disabled connections are not overwritten; manage subsequent key rotation in the vault.
- **Existing MCP connection:** create the project connection `comfy-cloud` in Tools and MCP, choose OAuth and sign in, or use `X-API-Key: {{secret:COMFY_API_KEY}}`. No environment bootstrap key is required for OAuth. Credentials never enter tool arguments, model context or artifact responses.

Both `files` and `mcp` features must be on. Individual image tools respect the existing disabled-tools controls; public assistants get none. Raw tools of this Comfy connection are hidden from the conversational agent while native image integration is enabled, so paid execution cannot bypass its limits and user/thread authorization.

```dotenv
IMAGE_GENERATION_ENABLED=true
IMAGE_MCP_SERVER=comfy-cloud
IMAGE_TIMEOUT_MS=180000
IMAGE_DOWNLOAD_HOSTS=cloud.comfy.org,storage.googleapis.com
IMAGE_MAX_ATTEMPTS=1
IMAGE_MAX_REFINEMENTS=0
IMAGE_MAX_READ_ATTEMPTS=3
IMAGE_MAX_COUNT=16
IMAGE_VISUAL_EVALUATION=false
IMAGE_API_UPLOAD_FALLBACK=false
IMAGE_API_KEY_SECRET=COMFY_API_KEY
IMAGE_RETENTION_DAYS=30
# Optional: requires a real provider quote; unknown cost never becomes zero.
# IMAGE_MAX_ESTIMATED_COST=1
```

Local child runtimes inherit control's environment. For Kubernetes, use the operator's existing passthrough: `RUNTIME_ENV_IMAGE_GENERATION_ENABLED=true`, other `RUNTIME_ENV_IMAGE_*` settings, and `RUNTIME_SECRET_COMFY_API_KEY` when using key bootstrap. The operator updates project ConfigMaps/Secrets and restarts runtimes on configuration changes. Configuration does not grant a Comfy subscription or credits.

The official [MCP reference](https://docs.comfy.org/agent-tools/mcp) documents the endpoint and available tools. Authenticated discovery was also performed against the user's account; sanitized input-schema fixtures are in `apps/runtime/test/fixtures/comfy-cloud-contracts.json`. MCP definitions are still discovered at runtime rather than frozen to these fixtures.

## Native tools

| Tool | Behavior |
| --- | --- |
| `image_generate` | Natural-language generation or a specialized operation; provider/model/workflow details remain internal. |
| `image_edit` | Edit the selected/latest image, or a specified revision/variant. Supports specialized operations through its optional operation field. |
| `image_variations` | Branch from an existing image without overwriting it. |
| `image_generate_spritesheet` | Generate named frames or UI states, then assemble PNG and JSON atlas with exact geometry. |
| `image_get_status` | Reconcile the same provider job/batch and materialize results. A configured, bounded refinement may submit a corrected attempt. |
| `image_cancel` | Request cancellation of the exact job, or the known jobs in a batch; never interrupt the whole account. Cancellation is reported only when confirmed. |
| `image_get_history` | Current selection and up to 50 scoped revisions with requests, lineage and artifacts. |
| `image_select_revision` | Persist a revision and zero-based variant as the source for subsequent edits. |
| `image_analyze` | Dimensions, integrity, alpha, pixel differences, tiling edges and border slices; optional `question` uses the existing model to inspect content and approximate object/text locations. |
| `image_assemble_spritesheet` | Assemble existing thread images into an exact sprite grid and atlas, with no paid generation. |
| `image_contact_sheet` | Assemble existing thread images into a preview grid, with no paid generation. |
| `image_import` | Import a user-authorized HTTPS resource from an administrator-allowed host into this thread. |
| `image_capabilities` | Current tool schemas and cached model/workflow capability evidence, including unknown capabilities. |

The PWA displays generated images inline and offers authenticated downloads. WhatsApp recognizes successful image-tool artifacts through the same current-turn offer authorization used by `send_chat_file`. Atlas files can also be offered with `send_chat_file`. No inaccessible server path or expiring provider URL is used as the final artifact.

## Conversational editing

The agent's image instructions are included only when image tools are available. It resolves ordinary language against the existing conversation/checkpoint history, current selection and scoped revision history. For example: generate a city → make it darker → use the lighting of the first version. If the source is ambiguous, it asks a short question using the existing `ask_user` mechanism.

Requests have a natural-language `prompt` and optional fields:

- `operation`: `generate`, `edit`, `variations`, `inpaint`, `outpaint`, `upscale`, `remove_background`, `resize`, `crop`, `pad`, `convert`, `text`, or `composite`.
- `references`: existing file paths with `temp`/`project` scope and distinct `source`, `identity`, `style`, `composition`, `color`, `structure`, `texture`, or `mask` roles. Uploads already use this FileStore. `sourceRevision` and `sourceIndex` select a specific earlier output; otherwise the durable selection/latest completed image is used.
- `output`: dimensions, aspect ratio, PNG/JPEG/WebP format, genuine transparency, count (1–16, configurable).
- `quality`: `auto`, `best`, `fast`, `economical`, `precise-edit`, or `consistent-style`.
- `preserve`, `seed`, and `inheritConstraints`: preservation/style/identity references and available seed metadata survive edits. Set `inheritConstraints=false` only when the user explicitly replaces prior constraints.
- `geometry`: exact crop, padding, overlay position, editable rectangle, or a resize multiplier (`scale: 0.9` means 10% smaller).
- `text`: escaped text, a bounded rectangle, font size, alignment, colour and optional background fill. A text overlay preserves pixels outside its region; removing old text over a complex unknown background requires inpainting rather than a fictitious perfect deterministic replacement.
- `validation`: visual requirements, edge-continuity tolerance, protected-region difference tolerance, and border-image slices.
- `game`: asset kind, named frames or `default`/`hover`/`focus`/`active`/`disabled`/`selected` states, cell dimensions, columns and spacing.

Users need not provide these technical fields themselves; the existing agent plans them. For precise edits it prefers deterministic geometry/text processing and masks over regenerating the whole image. Visual-model coordinates are explicitly approximate and cannot replace exact region input when precision matters.

## Provider discovery, selection and upload

The fixed pipeline discovers models where available, searches templates by operation, reads the selected template's advertised slots/nodes or JSON schema, and submits it through `run_template`. If no compatible template exists and an actual partner model is discovered, it can use `partner_generate`. Multiple independent outputs use `submit_batch` where exposed; their item count, selected tools, references and cumulative cost are checked before submission. Raw workflow construction and provider shell execution are prohibited.

`image_catalog` caches provider model/workflow records for 24 hours. Capabilities have three states: supported, unsupported and unknown. Explicit provider capability fields and operation tags supply evidence; unknown licensing, prices, model access and fidelity stay unknown. Ranking uses available quality/speed/cost metadata and disclosed name/description hints for fast/economical selection, not invented benchmarks. Compatible previous workflows are preferred when maintaining style. Optional prompting guides use the live discovered tool schema. An available catalog entry does not prove subscription entitlement or perfect image quality.

The authenticated hosted `upload_file` contract **does not support inline base64**. The adapter provides a synthetic filename and receives a credential-free, single-use `PUT` capability on `https://cloud.comfy.org/api/uploads/...`. Node sends the already validated FileStore bytes directly to that URL without an API key; no shell command is executed, no user's absolute path is required, and the returned input filename is wired into generation. Every reference must appear in the actual workflow inputs; silently dropping one is refused before spending.

For deployments with a different MCP upload contract, optional `IMAGE_API_UPLOAD_FALLBACK=true` uses the documented multipart [Cloud upload endpoint](https://docs.comfy.org/development/cloud/api-reference#uploading-inputs), restricted to the existing vault's host-scoped key. This compatibility upload returns the filename expected by legacy LoadImage templates. That v1 surface is deprecated; it is not used for generation, and the verified hosted MCP PUT route needs no fallback or additional API credential.

## Exact processing and validation

Sharp handles resize, percentage scaling, crop, padding, format conversion, compositing, deterministic text overlays, contact sheets and sprite assembly. Masks use **white = edit, black = preserve**, must match source dimensions, and can also be generated from an exact `geometry.region`. The source's sRGB RGBA pixels outside the mask are copied back and compared deterministically. Masked/precise edits require PNG so lossy encoding cannot silently invalidate preservation. Outpainting with explicit padding restores the original image rectangle into the extended result.

Outputs must decode fully, remain within 40 million pixels, match the requested count/dimensions, and contain actual nonopaque alpha pixels when transparency is requested. Opaque RGBA does not count. JPEG plus transparency is refused. Sprite grids have deterministic nonoverlapping cells and bounds; generated frame/state names are included in the atlas. Seamless textures can require opposite-edge continuity within a configurable tolerance. Border slicing returns validated nine-slice metadata/CSS.

Optional automated visual validation uses only the existing multimodal model and token accounting. It checks requested subject/composition/style/reference/text/colour/required/unwanted-element constraints. `IMAGE_VISUAL_EVALUATION` gates automatic evaluation; explicit `image_analyze(question)` also uses the existing model. Providers/models without vision support fail honestly. Visual evaluation is not a guarantee of identity or typography correctness.

Failed alpha, size, seamless or visual checks may trigger refinement only within both `IMAGE_MAX_REFINEMENTS` and `IMAGE_MAX_ATTEMPTS`, the execution deadline and any quoted cost budget. Defaults permit one paid submission and **zero** refinements. An unverified or rejected artifact is never presented as a completed image.

## Persistence, replay and limits

Migrations `020_images.sql` and `021_image_execution.sql` extend the existing project DB with jobs, capability metadata and selected revisions. Binary images stay in FileStore; graph checkpoints and database rows retain lightweight references. Requests, original/parent revisions, selected variants, masks, constraints, workflow/model/seed metadata, provider identifiers, attempts and validation results survive process reconstruction. Selections use compare-and-set updates for concurrent branches.

The graph's stable tool-call id is the unique submission key for each user/thread. Atomic claims, execution leases and a conditional pre-submission write prevent concurrent/replayed paid calls. Provider ids are parsed and persisted immediately without another model call. An interrupted preparation can resume; a known job can be polled after restart. A saved raw submission response can recover its id if parsing was interrupted. The unavoidable window between remote acceptance and receipt/persistence of its id becomes `unknown` and is **not** automatically resubmitted. Inspect the Comfy queue to reconcile it; never invent provider-side idempotency.

Each paid submission is attempted once. Only read operations use bounded exponential retries. Explicit authentication/input/credit refusals are separate from ambiguous submission failures. Known completed/failed/cancelled states are terminal; coarse live progress uses the existing LangGraph custom stream and SSE, with numeric progress only when the provider actually supplies it. Deadlines prevent new attempts/refinements and request job-specific cancellation where supported.

Limits: 1–16 requested outputs, at most five references and 25 MiB combined input, per-artifact size bounded by the FileStore limit or 20 MiB, 64 MiB total downloaded output, and 40 million decoded pixels. Large pixel loops yield back to the event loop. Grid assembly also bounds total input bytes and final canvas size. A finite `maxCost`/`IMAGE_MAX_ESTIMATED_COST` requires a real provider estimate; batch estimates are multiplied by item count and accumulated transactionally across refinements. Quotes use the provider's reported units; they are estimates, not a promise of a hard provider charge cap. Without quotes, request/time/attempt limits apply and a requested monetary estimate is refused.

Output downloads preserve signed URLs and shortlinks intact. Each redirect is handled manually, limited to three, and revalidated against exact administrator-approved HTTPS hosts. DNS answers are validated and pinned for the real HTTPS connection, preventing private-network access and rebinding. Downloads never forward credentials. MIME, streamed size and full file integrity are validated. No provider command is run. Structured errors and logs omit raw provider messages, secrets, image bytes and private prompts by default.

Final images use immutable revision/attempt paths in the existing thread temp scope. Existing temp-file expiry (normally 24 hours after last change in that thread) still applies; missing sources are reported accurately. `IMAGE_RETENTION_DAYS` additionally cleans terminal job metadata/artifacts at project startup; it does not extend FileStore's lifetime. Comfy's cloud-library retention is separate. Thread deletion cascades image metadata as well as existing files/checkpoints.

## Verification and remaining provider limits

Authenticated tool discovery, one successful live 256×256 generation/download/materialization, and a tiny reference upload were exercised with the user's explicit permission. A prior Gemini-backed run failed inside the provider (`Gemini did not generate an image`); Comfy reported possible billing for that failed execution. No automatic paid retries were enabled. Models/workflows not exercised by these checks remain capability-dependent, rather than being claimed verified.

Precise pixel preservation is guaranteed only by deterministic copying/compositing in the declared sRGB regions, not by a generative model. Identity/style/typography depend on the available model and references. Background removal, inpainting, outpainting, upscaling and seamless synthesis require an appropriate discovered workflow or partner model; unsupported inputs fail before submission where detectable. Raster images are never advertised as genuine vectors. Local ComfyUI, speculative providers and a new Comfy frontend remain outside scope.

## Tests and troubleshooting

```bash
pnpm --filter @osiris/runtime exec vitest run test/images.test.ts test/images-advanced.test.ts test/images-execution.test.ts test/images-contracts.test.ts test/chat-attachments.test.ts
pnpm --filter @osiris/runtime typecheck
pnpm --filter @osiris/web typecheck
```

Routine tests mock MCP/model/network responses, include sanitized authenticated contract fixtures, and never spend image credits. Optional live checks are separately gated:

```bash
# COMFY_API_KEY or COMFY_TEST_API_KEY and normal chat-model credentials must be supplied securely.
COMFY_LIVE_TEST=1 pnpm --filter @osiris/runtime exec vitest run test/images-live.test.ts
COMFY_LIVE_UPLOAD=1 pnpm --filter @osiris/runtime exec vitest run test/images-live.test.ts
# Paid: one small submission, zero refinements. Failed checks retain /tmp DB state for reconciliation.
COMFY_LIVE_GENERATE=1 pnpm --filter @osiris/runtime exec vitest run test/images-live.test.ts
```

Use Node ≥24 as required by the project. This workspace's installed Node 22.22.1 and broken pnpm launcher required invoking installed Vitest/TypeScript entry points directly; production requirements are unchanged. The OAuth regression fixture needs loopback access.

For authentication failures inspect the existing MCP status UI; for `unknown`, reconcile the stored job instead of paying again; for expired output links poll the same job to retrieve fresh links; for unsupported input roles inspect `image_capabilities` and the template schema. A blocked output host needs an administrator's exact-host allowlist update, not a new API key. More provider/model live coverage can be added explicitly without enabling paid calls in routine CI.
