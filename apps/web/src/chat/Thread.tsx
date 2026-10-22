import { Attachments } from "./Attachments.tsx";
import { Question } from "./Question.tsx";
import {
  ComposerPrimitive,
  MessagePrimitive,
  ThreadPrimitive,
  useAuiState,
  type ToolCallMessagePartProps,
} from "@assistant-ui/react";
import { MarkdownTextPrimitive } from "@assistant-ui/react-markdown";
import type { FileScope, RunStatus } from "@osiris/shared";
import { createContext, useContext, useEffect, useState } from "react";
import { api, saveBlob } from "../api.ts";

/** The open thread's id (null until the first message creates it), for downloading the thread's temp files. */
export const ThreadIdContext = createContext<() => string | null>(() => null);

const file = (a: Record<string, unknown>, scope = "scope", path = "path") => `${String(a[scope] ?? "tenant")}:${String(a[path] ?? "")}`;

const TOOL_LABELS: Record<string, (args: Record<string, unknown>) => string> = {
  search_knowledge: (a) => `Hledám ve znalostní bázi: „${String(a.query ?? "")}“`,
  load_skill: (a) => `Načítám postup: ${String(a.name ?? "")}`,
  remember: (a) => `Zapamatovávám si: ${String(a.content ?? "")}`,
  forget: () => "Mažu záznam z paměti",
  list_files: (a) => `Prohlížím soubory ${file(a, "scope", "dir")}`,
  read_file: (a) => `Čtu soubor ${file(a)}`,
  write_file: (a) => `Ukládám soubor ${file(a)}`,
  delete_file: (a) => `Mažu ${file(a)}`,
  move_file: (a) => `Přesouvám ${file(a, "from_scope", "from_path")} → ${file(a, "to_scope", "to_path")}`,
  render_template: (a) => `Vyplňuji šablonu ${file(a, "template_scope", "template_path")}`,
  edit_text: (a) => `${a.dry_run ? "Zkouším úpravu" : "Upravuji"} ${file(a)}`,
  convert_to_pdf: (a) => `Převádím do PDF ${file(a)}`,
  image_import: () => "Načítám referenční obrázek",
  image_generate: () => "Vytvářím obrázek",
  image_edit: () => "Upravuji obrázek",
  image_variations: () => "Vytvářím variantu obrázku",
  image_get_status: () => "Kontroluji stav tvorby obrázku",
  image_cancel: () => "Ruším tvorbu obrázku",
  image_get_history: () => "Procházím předchozí verze obrázků",
  image_analyze: () => "Ověřuji vlastnosti obrázku",
  image_capabilities: () => "Zjišťuji dostupné obrazové nástroje",
  image_generate_spritesheet: () => "Vytvářím herní snímky a atlas",
  image_select_revision: () => "Vybírám verzi obrázku",
  image_contact_sheet: () => "Sestavuji přehled obrázků",
  image_assemble_spritesheet: () => "Sestavuji obrázky do mřížky",
  resize_image: (a) => `Upravuji obrázek ${file(a)}`,
  search_files: (a) => `Hledám v souborech: „${String(a.query ?? "")}“`,
  save_knowledge: (a) => `Ukládám do znalostní báze: ${String(a.title ?? a.id ?? "")}`,
  schedule_task: (a) => `Plánuji úlohu: ${String(a.title ?? "")}`,
  list_schedules: () => "Procházím plánované úlohy",
  cancel_schedule: () => "Ruším plánovanou úlohu",
  build_vitepress_site: (a) => `Sestavuji web ${String(a.site ?? "")}`,
  publish_site: (a) => `Publikuji web ${String(a.target ?? a.dir ?? "")}`,
  http_request: (a) => {
    const url = String(a.url ?? "");
    const host = /^https?:\/\/([^/?#]+)/.exec(url)?.[1] ?? url;
    return `Volám ${String(a.method ?? "GET")} ${host}`;
  },
};

/** File tools report what they created as `<scope>:<path>` after one of these words. */
const CREATED = /(?:Uloženo|Vytvořeno|PDF vytvořeno|Přesunuto do):? (personal|tenant|temp):([^\s()]+)/;

function Download({ scope, path }: { scope: FileScope; path: string }) {
  const threadId = useContext(ThreadIdContext);
  const [error, setError] = useState<string>();
  const name = path.slice(path.lastIndexOf("/") + 1).replace(/\.$/, "");
  const download = () =>
    api.downloadFile({ scope, path: path.replace(/\.$/, ""), thread: threadId() ?? undefined }).then((b) => saveBlob(b, name), (e: Error) => setError(e.message));
  return (
    <span className="ml-2">
      <button onClick={download} className="btn-link">
        Stáhnout {name}
      </button>
      {error && <span className="ml-2 text-error">{error}</span>}
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
  return <div className="my-2">{url && <img src={url} alt="Vytvořený obrázek" className="max-h-96 max-w-full rounded border border-line-strong" />}<Download scope={scope} path={path} /></div>;
}

/** A result the tool reports as a failure: a refusal, an error, or a JSON answer with `success: false`. */
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
  return text.length > 4000 ? `${text.slice(0, 4000)}\n… (${text.length - 4000} znaků navíc)` : text;
}

/**
 * One step of the run, as a coding agent shows it: running, done or failed, what it does, and (opened) the tool, its
 * arguments and its result.
 */
function ToolCall({ toolName, args, argsText, result }: ToolCallMessagePartProps) {
  const writing = !argsText;
  if (toolName === "ask_user" && result) {
    try { const parsed = JSON.parse(String(result)); if (parsed.question) return <Question initial={parsed.question} />; } catch { /* A failed tool uses the normal display. */ }
  }
  // Other names are tools of the tenant's MCP servers (`<server>_<tool>`).
  const label = writing ? `Připravuji ${toolName}…` : (TOOL_LABELS[toolName]?.(args as Record<string, unknown>) ?? `Nástroj ${toolName}`);
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
              <div className="tool-step-heading">Vstup</div>
              <pre>{pretty(args)}</pre>
            </>
          )}
          {output !== undefined && (
            <>
              <div className="tool-step-heading">Výsledek</div>
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

const STATUS_LABELS: Record<RunStatus, string> = { thinking: "Přemýšlím", tools: "Pracuji", checking: "Kontroluji pravidla" };

/** Under a running answer: what the run is doing now. */
function RunStatusLine() {
  const running = useAuiState((s) => s.message.status?.type === "running");
  const status = useAuiState((s) => s.message.metadata?.custom?.status as RunStatus | undefined);
  const image = useAuiState((s) => s.message.metadata?.custom?.imageProgress as { status: string; progress?: { value: number; max: number } } | undefined);
  if (!running) return null;
  return (
    <div className="run-status" role="status">
      <span className="tool-spinner" aria-hidden="true" />
      {image && !["completed", "failed", "cancelled"].includes(image.status) ? ({ queued: "Obrázek čeká ve frontě", running: "Vytvářím obrázek", planning: "Připravuji obrázek", submitting: "Odesílám zadání obrázku", unknown: "Ověřuji stav obrázku" }[image.status] ?? "Zpracovávám obrázek") : STATUS_LABELS[status ?? "thinking"]}
      {image?.progress && <span>{image.progress.value}/{image.progress.max}</span>}
      <span className="run-status-dots" aria-hidden="true" />
    </div>
  );
}

function UserMessage() {
  const text = useAuiState(s => s.message.content.filter(p => p.type === "text").map(p => p.text).join(""));
  const submitted = text.startsWith("@osiris-answer:");
  const attachment = text.startsWith("@osiris-attachments:");

  return (
    <MessagePrimitive.Root className="flex justify-end py-2">
      <div className="max-w-[80%] rounded-sm border border-line-strong bg-selection px-4 py-2 whitespace-pre-wrap">
        {submitted ? "Odpověď na otázku odeslána." : attachment ? "Odeslané přílohy." : <MessagePrimitive.Parts />}
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
          <p className="notice notice-error mt-2 px-3 py-2 text-sm">Něco se pokazilo. Zkus to znovu.</p>
        </MessagePrimitive.Error>
      </div>
    </MessagePrimitive.Root>
  );
}

export function Thread({ greeting = "S čím ti můžu pomoct?", placeholder = "Napiš zprávu…" }: { greeting?: string; placeholder?: string } = {}) {
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
          <ComposerPrimitive.Root className="composer relative rounded-md border border-line-strong bg-input shadow-lg">
            <ComposerPrimitive.Input
              autoFocus
              placeholder={placeholder}
              minRows={3}
              maxRows={12}
              className="block w-full resize-none bg-transparent px-4 pt-3 pb-12 outline-none"
            />
            <div className="absolute right-2 bottom-2">
              <ThreadPrimitive.If running={false}>
                <ComposerPrimitive.Send className="icon-button btn-primary" aria-label="Odeslat" title="Odeslat (Enter)">
                  <svg viewBox="0 0 24 24" className="h-5 w-5" aria-hidden="true">
                    <path d="M12 19V5M5 12l7-7 7 7" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </ComposerPrimitive.Send>
              </ThreadPrimitive.If>
              <ThreadPrimitive.If running>
                <ComposerPrimitive.Cancel className="icon-button btn-secondary" aria-label="Zastavit" title="Zastavit">
                  <svg viewBox="0 0 24 24" className="h-4 w-4" aria-hidden="true">
                    <rect x="6" y="6" width="12" height="12" rx="1.5" fill="currentColor" />
                  </svg>
                </ComposerPrimitive.Cancel>
              </ThreadPrimitive.If>
            </div>
            <Attachments />
          </ComposerPrimitive.Root>
        </ThreadPrimitive.ViewportFooter>
      </ThreadPrimitive.Viewport>
    </ThreadPrimitive.Root>
  );
}
