import { Composer } from "./Attachments.tsx";
import { Question } from "./Question.tsx";
import {
  MessagePrimitive,
  ThreadPrimitive,
  useAuiState,
  type ToolCallMessagePartProps,
} from "@assistant-ui/react";
import { MarkdownTextPrimitive } from "@assistant-ui/react-markdown";
import { asWorkflowView, QUESTION_TOOLS, type FileScope, type RunStatus } from "@osiris/shared";
import { WorkflowDiagram } from "./WorkflowDiagram.tsx";
import { createContext, useContext, useEffect, useState } from "react";
import { api, saveBlob } from "../api.ts";
import { t } from "i18next";

/** The open thread's id (null until the first message creates it), for downloading the thread's temp files. */
export const ThreadIdContext = createContext<() => string | null>(() => null);

const file = (a: Record<string, unknown>, scope = "scope", path = "path") => `${String(a[scope] ?? "tenant")}:${String(a[path] ?? "")}`;

/** What a built-in tool is doing, in words; other tools (MCP servers' `<server>_<tool>`) show their name. */
const TOOL_LABELS: Record<string, (args: Record<string, unknown>) => string> = {
  search_knowledge: (a) => t("chat:tools.search_knowledge", { query: String(a.query ?? "") }),
  load_skill: (a) => t("chat:tools.load_skill", { name: String(a.name ?? "") }),
  remember: (a) => t("chat:tools.remember", { content: String(a.content ?? "") }),
  forget: () => t("chat:tools.forget"),
  list_files: (a) => t("chat:tools.list_files", { file: file(a, "scope", "dir") }),
  read_file: (a) => t("chat:tools.read_file", { file: file(a) }),
  write_file: (a) => t("chat:tools.write_file", { file: file(a) }),
  delete_file: (a) => t("chat:tools.delete_file", { file: file(a) }),
  move_file: (a) => t("chat:tools.move_file", { from: file(a, "from_scope", "from_path"), to: file(a, "to_scope", "to_path") }),
  render_template: (a) => t("chat:tools.render_template", { file: file(a, "template_scope", "template_path") }),
  edit_text: (a) => (a.dry_run ? t("chat:tools.edit_text_dry", { file: file(a) }) : t("chat:tools.edit_text", { file: file(a) })),
  convert_to_pdf: (a) => t("chat:tools.convert_to_pdf", { file: file(a) }),
  image_import: () => t("chat:tools.image_import"),
  image_generate: () => t("chat:tools.image_generate"),
  image_edit: () => t("chat:tools.image_edit"),
  image_variations: () => t("chat:tools.image_variations"),
  image_get_status: () => t("chat:tools.image_get_status"),
  image_cancel: () => t("chat:tools.image_cancel"),
  image_get_history: () => t("chat:tools.image_get_history"),
  image_analyze: () => t("chat:tools.image_analyze"),
  image_capabilities: () => t("chat:tools.image_capabilities"),
  image_generate_spritesheet: () => t("chat:tools.image_generate_spritesheet"),
  image_select_revision: () => t("chat:tools.image_select_revision"),
  image_contact_sheet: () => t("chat:tools.image_contact_sheet"),
  image_assemble_spritesheet: () => t("chat:tools.image_assemble_spritesheet"),
  resize_image: (a) => t("chat:tools.resize_image", { file: file(a) }),
  search_files: (a) => t("chat:tools.search_files", { query: String(a.query ?? "") }),
  save_knowledge: (a) => t("chat:tools.save_knowledge", { title: String(a.title ?? a.id ?? "") }),
  schedule_task: (a) => t("chat:tools.schedule_task", { title: String(a.title ?? "") }),
  list_schedules: () => t("chat:tools.list_schedules"),
  cancel_schedule: () => t("chat:tools.cancel_schedule"),
  build_vitepress_site: (a) => t("chat:tools.build_vitepress_site", { site: String(a.site ?? "") }),
  publish_site: (a) => t("chat:tools.publish_site", { target: String(a.target ?? a.dir ?? "") }),
  run_workflow: (a) => (a.resume ? t("chat:tools.run_workflow_resume") : t("chat:tools.run_workflow")),
  http_request: (a) => {
    const url = String(a.url ?? "");
    const host = /^https?:\/\/([^/?#]+)/.exec(url)?.[1] ?? url;
    return t("chat:tools.http_request", { method: String(a.method ?? "GET"), host });
  },
};

/** File tools report what they created as `<scope>:<path>` after one of these words (the tools' own, model-facing texts). */
const CREATED = /(?:Uloženo|Vytvořeno|PDF vytvořeno|Přesunuto do):? (personal|tenant|temp):([^\s()]+)/;

function Download({ scope, path }: { scope: FileScope; path: string }) {
  const threadId = useContext(ThreadIdContext);
  const [error, setError] = useState<string>();
  const name = path.slice(path.lastIndexOf("/") + 1).replace(/\.$/, "");
  const download = () =>
    api.downloadFile({ scope, path: path.replace(/\.$/, ""), thread: threadId() ?? undefined }).then((b) => saveBlob(b, name), (e: Error) => setError(e.message));
  return (
    <span className="ms-2">
      <button onClick={download} className="btn-link">
        {t("chat:download", { name })}
      </button>
      {error && <span className="ms-2 text-error">{error}</span>}
    </span>
  );
}

function GeneratedImage({ scope, path, mime }: { scope: FileScope; path: string; mime?: string }) {
  const threadId = useContext(ThreadIdContext);
  const [url, setUrl] = useState<string>();
  useEffect(() => {
    if (!/^image\/(png|jpeg|webp)$/.test(mime ?? "")) return;
    let disposed = false, objectUrl: string | undefined;
    api.downloadFile({ scope, path, thread: threadId() ?? undefined }).then(blob => {
      if (disposed) return;
      objectUrl = URL.createObjectURL(blob); setUrl(objectUrl);
    }).catch(() => {});
    return () => { disposed = true; if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [scope, path, mime, threadId]);
  return <div className="my-2">{url && <img src={url} alt={t("chat:generatedImage")} className="max-h-96 max-w-full rounded border border-line-strong" />}<Download scope={scope} path={path} /></div>;
}

/** A result the tool reports as a failure: a refusal, an error (the tools' own texts), or a JSON answer with `success: false`. */
const failed = (result: string) => {
  if (/^(Nelze|Operace selhala|Chyba|Error)/.test(result)) return true;
  try { const value = JSON.parse(result); return value.success === false || value.status === "failed" || !!value.error; } catch { return false; }
};

/** A JSON result or argument, indented; long values cut so a step stays readable. */
function pretty(value: unknown): string {
  let text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  if (typeof value === "string" && /^[[{]/.test(value)) {
    try {
      text = JSON.stringify(JSON.parse(value), null, 2);
    } catch {
      // Not JSON after all.
    }
  }
  return text.length > 4000 ? `${text.slice(0, 4000)}\n… ${t("chat:moreChars", { count: text.length - 4000 })}` : text;
}

/**
 * One step of the run, as a coding agent shows it: running, done or failed, what it does, and (opened) the tool, its
 * arguments and its result.
 */
function ToolCall(props: ToolCallMessagePartProps) {
  const workflow = asWorkflowView(props.artifact);
  if (!workflow) return <ToolStep {...props} />;
  // A workflow's diagram, live while it runs, then above its result (or its approval question).
  return (
    <>
      <WorkflowDiagram view={workflow} running={props.result === undefined} />
      <ToolStep {...props} />
    </>
  );
}

function ToolStep({ toolName, args, argsText, result }: ToolCallMessagePartProps) {
  const writing = !argsText;
  if (QUESTION_TOOLS.includes(toolName) && result) {
    try { const parsed = JSON.parse(String(result)); if (parsed.question) return <Question initial={parsed.question} />; } catch { /* A failed tool uses the normal display. */ }
  }
  // Other names are tools of the tenant's MCP servers (`<server>_<tool>`).
  const label = writing ? t("chat:preparing", { tool: toolName }) : (TOOL_LABELS[toolName]?.(args as Record<string, unknown>) ?? t("chat:tool", { tool: toolName }));
  const output = result === undefined ? undefined : String(result);
  const state = output === undefined ? "running" : failed(output) ? "failed" : "done";
  const created = output === undefined || state === "failed" ? null : CREATED.exec(output);
  let imageFiles: { scope: FileScope; path: string; mime?: string }[] = [];
  if (toolName.startsWith("image_") && output) { try { const parsed = JSON.parse(output); imageFiles = parsed.artifacts ?? parsed.result?.artifacts ?? []; } catch { /* A failed tool has no files. */ } }
  let offered: { scope: FileScope; path: string } | undefined;
  if (toolName === "send_chat_file" && output) { try { offered = JSON.parse(output).file; } catch { /* Tool failure. */ } }
  return (
    <div className="tool-step" data-state={state}>
      <details>
        <summary>
          <span className="tool-step-icon" aria-hidden="true">
            {state === "running" ? <span className="tool-spinner" /> : state === "done" ? "✓" : "✗"}
          </span>
          <span className="min-w-0 flex-1 truncate">{label}</span>
          <code className="tool-step-name">{toolName}</code>
        </summary>
        <div className="tool-step-body">
          {!writing && (
            <>
              <div className="tool-step-heading">{t("chat:input")}</div>
              <pre>{pretty(args)}</pre>
            </>
          )}
          {output !== undefined && (
            <>
              <div className="tool-step-heading">{t("chat:result")}</div>
              <pre>{pretty(output)}</pre>
            </>
          )}
        </div>
      </details>
      {created && <Download scope={created[1] as FileScope} path={created[2]!} />}
      {imageFiles.map(f => <GeneratedImage key={f.path} scope={f.scope} path={f.path} mime={f.mime} />)}
      {offered && <Download scope={offered.scope} path={offered.path} />}
    </div>
  );
}

const statusLabel = (status: RunStatus) => t(`chat:status.${status}`);
const IMAGE_STATES = ["queued", "running", "planning", "submitting", "unknown"] as const;
const imageState = (s: string) => ((IMAGE_STATES as readonly string[]).includes(s) ? t(`chat:image.${s as (typeof IMAGE_STATES)[number]}`) : t("chat:image.processing"));

/** Under a running answer: what the run is doing now. */
function RunStatusLine() {
  const running = useAuiState((s) => s.message.status?.type === "running");
  const status = useAuiState((s) => s.message.metadata?.custom?.status as RunStatus | undefined);
  const image = useAuiState((s) => s.message.metadata?.custom?.imageProgress as { status: string; progress?: { value: number; max: number } } | undefined);
  if (!running) return null;
  return (
    <div className="run-status" role="status">
      <span className="tool-spinner" aria-hidden="true" />
      {image && !["completed", "failed", "cancelled"].includes(image.status) ? imageState(image.status) : statusLabel(status ?? "thinking")}
      {image?.progress && <span>{image.progress.value}/{image.progress.max}</span>}
      <span className="run-status-dots" aria-hidden="true" />
    </div>
  );
}

function UserMessage() {
  const text = useAuiState(s => s.message.content.filter(p => p.type === "text").map(p => p.text).join(""));
  const submitted = text.startsWith("@osiris-answer:");
  const attachment = text.startsWith("@osiris-attachments:");
  const voice = attachment && text.includes('"voice":');

  return (
    <MessagePrimitive.Root className="flex justify-end py-2">
      <div className="max-w-[80%] rounded-sm border border-line-strong bg-selection px-4 py-2 whitespace-pre-wrap">
        {submitted ? t("chat:answerSent") : voice ? t("chat:voiceSent") : attachment ? t("chat:attachmentsSent") : <MessagePrimitive.Parts />}
      </div>
    </MessagePrimitive.Root>
  );
}

function AssistantMessage() {
  return (
    <MessagePrimitive.Root className="py-2">
      <div className="markdown max-w-[90%]">
        <MessagePrimitive.Parts
          components={{ Text: () => <MarkdownTextPrimitive />, tools: { Fallback: ToolCall } }}
        />
        <RunStatusLine />
        <MessagePrimitive.Error>
          <p className="notice notice-error mt-2 px-3 py-2 text-sm">{t("chat:runFailed")}</p>
        </MessagePrimitive.Error>
      </div>
    </MessagePrimitive.Root>
  );
}

export function Thread({ greeting = t("chat:greeting"), placeholder = t("chat:placeholder") }: { greeting?: string; placeholder?: string } = {}) {
  return (
    <ThreadPrimitive.Root className="h-full">
      <ThreadPrimitive.Viewport className="flex h-full flex-col overflow-y-auto px-4">
        <div className="mx-auto w-full max-w-3xl flex-1 py-6">
          <ThreadPrimitive.Empty>
            <div className="mt-24 flex flex-col items-center gap-4 text-fg-secondary">
              <img src="/logo.svg" alt="" className="h-16 w-16 opacity-90" />
              <p className="text-center whitespace-pre-wrap">{greeting}</p>
            </div>
          </ThreadPrimitive.Empty>
          <ThreadPrimitive.Messages>
            {({ message }) => (message.role === "user" ? <UserMessage /> : <AssistantMessage />)}
          </ThreadPrimitive.Messages>
        </div>
        {/* The composer floats over the conversation, which scrolls underneath it. */}
        <ThreadPrimitive.ViewportFooter className="sticky bottom-0 mx-auto w-full max-w-3xl bg-gradient-to-t from-canvas from-70% pb-4 pt-2">
          <Composer placeholder={placeholder} />
        </ThreadPrimitive.ViewportFooter>
      </ThreadPrimitive.Viewport>
    </ThreadPrimitive.Root>
  );
}
