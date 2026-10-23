import { fileType, type FileEntry, type FileScope, type FileSearchHit } from "@osiris/shared";
import { useEffect, useRef, useState, type DragEvent, type FormEvent, type ReactNode } from "react";
import { api, saveBlob } from "./api.ts";
import { LazyCodeEditor } from "./LazyCodeEditor.tsx";
import { attempt, ErrorNotice, Loading, Pending } from "./Scope.tsx";
import { t } from "i18next";
import { formatDateTime, formatNumber } from "./i18n.ts";

type Editing = { kind: "mkdir" } | { kind: "newfile" } | { kind: "rename"; entry: FileEntry };
/** A file open on the right: text in the editor (`saved` is what's on disk), an image, or anything else. */
type Open = { path: string; kind: "text"; text: string; saved: string; isNew: boolean } | { path: string; kind: "image"; url: string } | { path: string; kind: "other"; size: number };
/** One file of an upload, with how it went. */
type Upload = { path: string; file: File; state: "waiting" | "uploading" | "done" | "exists" | "error"; error?: string };

const IMAGE = /^image\/(png|jpeg|gif|webp|svg\+xml)$/;
/** Folders with their own views (Dovednosti, Kontroly, Weby): not in Soubory. */
export const OWN_VIEWS = ["skills", "guards", "vitepress", "www"];

/** A size in the reader's number format, with its unit (B, kB, MB). */
export const fileSize = (n: number) =>
  n < 1024
    ? formatNumber(n, { style: "unit", unit: "byte" })
    : n < 1024 * 1024
      ? formatNumber(Math.round(n / 1024), { style: "unit", unit: "kilobyte" })
      : formatNumber(n / 1024 / 1024, { style: "unit", unit: "megabyte", minimumFractionDigits: 1, maximumFractionDigits: 1 });

const join = (dir: string, name: string) => (dir ? `${dir}/${name}` : name);
const nameOf = (path: string) => path.split("/").at(-1) ?? path;

/** Files of a drop, folders included (read through the entries API), with their paths relative to the drop. */
async function droppedFiles(e: DragEvent): Promise<{ path: string; file: File }[]> {
  const entries = [...e.dataTransfer.items].map((i) => i.webkitGetAsEntry?.()).filter((x): x is FileSystemEntry => !!x);
  if (!entries.length) return [...e.dataTransfer.files].map((file) => ({ path: file.name, file }));
  const out: { path: string; file: File }[] = [];
  const walk = async (entry: FileSystemEntry, prefix: string): Promise<void> => {
    if (entry.isFile) {
      const file = await new Promise<File>((ok, fail) => (entry as FileSystemFileEntry).file(ok, fail));
      out.push({ path: join(prefix, entry.name), file });
    } else if (entry.isDirectory && !entry.name.startsWith(".")) {
      const reader = (entry as FileSystemDirectoryEntry).createReader();
      // readEntries returns a batch at a time, until an empty one.
      for (;;) {
        const batch = await new Promise<FileSystemEntry[]>((ok, fail) => reader.readEntries(ok, fail));
        if (!batch.length) break;
        for (const child of batch) await walk(child, join(prefix, entry.name));
      }
    }
  };
  for (const entry of entries) await walk(entry, "");
  return out;
}

function Icon({ entry }: { entry: Pick<FileEntry, "type" | "name"> }) {
  const type = entry.type === "file" ? fileType(entry.name) : undefined;
  const d =
    entry.type === "dir"
      ? "M2 4h4l1.5 1.5H14V13H2z"
      : IMAGE.test(type?.mime ?? "")
        ? "M2.5 2.5h11v11h-11zM2.5 11l3.5-3.5 3 3 2-2 2.5 2.5M10 5.5h.01"
        : type?.text
          ? "M4 1.5h5.5L12.5 4.5V14.5H4zM9.5 1.5v3h3M6 8h5M6 10.5h5M6 13h3"
          : "M4 1.5h5.5L12.5 4.5V14.5H4zM9.5 1.5v3h3";
  return (
    <svg viewBox="0 0 16 16" className={`h-4 w-4 shrink-0 ${entry.type === "dir" ? "text-primary" : "text-fg-muted"}`} aria-hidden="true">
      <path d={d} fill="none" stroke="currentColor" strokeWidth="1.2" />
    </svg>
  );
}

/**
 * Files folder by folder: the project's by default, or another `location` (a chat's scratchpad). `root` limits the
 * view to one folder (a website's template), `hide` leaves out top-level folders that have views of their own.
 */
export function Files({ root = "", title = t("app:nav.files"), intro, hide = [], location = { scope: "project" }, readOnly = false }: {
  root?: string;
  title?: string;
  intro?: ReactNode;
  hide?: string[];
  location?: { scope: FileScope; thread?: string };
  /** The project's files for a member: read, downloaded and copied to their own, never changed. */
  readOnly?: boolean;
}) {
  const loc = location;
  // Search covers the indexed files; a chat's scratchpad isn't indexed.
  const searchable = loc.scope !== "temp";
  const [dir, setDir] = useState(root);
  const [entries, setEntries] = useState<FileEntry[]>();
  const [editing, setEditing] = useState<Editing>();
  const [name, setName] = useState("");
  const [open, setOpen] = useState<Open>();
  const [uploads, setUploads] = useState<Upload[]>([]);
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const pickFiles = useRef<HTMLInputElement>(null);
  const pickFolder = useRef<HTMLInputElement>(null);
  const [search, setSearch] = useState("");
  const [hits, setHits] = useState<FileSearchHit[]>();
  const dirRef = useRef(dir);
  dirRef.current = dir;

  const load = () =>
    api.files(loc.scope, dir, loc.thread).then(
      (list) => setEntries(dir === "" ? list.filter((e) => !hide.includes(e.name)) : list),
      (e: Error) => setError(e.message),
    );
  useEffect(() => {
    setEntries(undefined);
    setEditing(undefined);
    void load();
  }, [dir]);
  // A file on its way into the editor or the preview.
  const [opening, setOpening] = useState(false);
  useEffect(() => () => void (open?.kind === "image" && URL.revokeObjectURL(open.url)), [open]);

  /** Text files open in the editor, images in the preview, anything else with its download. */
  const openPath = (path: string, size = 0) =>
    attempt((b) => (setBusy(b), setOpening(b)), setError, async () => {
      if (open?.kind === "text" && open.text !== open.saved && !window.confirm(t("files:closeUnsaved"))) return;
      const type = fileType(path);
      if (type?.text) {
        const text = await (await api.downloadFile({ ...loc, path })).text();
        setOpen({ path, kind: "text", text, saved: text, isNew: false });
      } else if (IMAGE.test(type?.mime ?? "")) setOpen({ path, kind: "image", url: URL.createObjectURL(await api.downloadFile({ ...loc, path })) });
      else setOpen({ path, kind: "other", size });
    });
  const openEntry = (e: FileEntry) => (e.type === "dir" ? setDir(e.path) : void openPath(e.path, e.size));
  const download = (path: string) => attempt(setBusy, setError, async () => saveBlob(await api.downloadFile({ ...loc, path }), nameOf(path)));

  const saveDoc = () =>
    attempt(setBusy, setError, async () => {
      if (open?.kind !== "text") return;
      await api.uploadFile({ ...loc, path: open.path }, new Blob([open.text], { type: fileType(open.path)?.mime ?? "text/plain" }), !open.isNew);
      setOpen({ ...open, saved: open.text, isNew: false });
      await load();
    });
  const close = () => {
    if (open?.kind !== "text" || open.text === open.saved || window.confirm(t("files:closeUnsaved"))) setOpen(undefined);
  };

  /** Uploads into the current folder one by one; files that exist are asked about once, at the end. */
  const upload = async (files: { path: string; file: File }[]) => {
    if (!files.length) return;
    const into = dirRef.current;
    const queue: Upload[] = files.map((f) => ({ ...f, path: join(into, f.path), state: "waiting" }));
    setUploads(queue);
    const update = (i: number, change: Partial<Upload>) => setUploads((u) => u.map((x, j) => (j === i ? { ...x, ...change } : x)));
    const send = async (i: number, overwrite: boolean) => {
      update(i, { state: "uploading" });
      try {
        await api.uploadFile({ ...loc, path: queue[i]!.path }, queue[i]!.file, overwrite);
        update(i, { state: "done" });
        return "done";
      } catch (err) {
        const exists = (err as { status?: number }).status === 409;
        update(i, exists ? { state: "exists" } : { state: "error", error: (err as Error).message });
        return exists ? "exists" : "error";
      }
    };
    const existing: number[] = [];
    for (let i = 0; i < queue.length; i++) if ((await send(i, false)) === "exists") existing.push(i);
    if (existing.length && window.confirm(existing.length === 1 ? t("files:overwriteOne", { name: nameOf(queue[existing[0]!]!.path) }) : t("files:overwriteMany", { count: existing.length }))) {
      for (const i of existing) await send(i, true);
    }
    await load();
  };
  /** The viewer's own copy at the same path among their files, where it replaces the project's for them. */
  const copyOwn = (path: string) =>
    attempt(setBusy, setError, async () => {
      const data = await api.downloadFile({ ...loc, path });
      try {
        await api.uploadFile({ scope: "personal", path }, data);
      } catch (err) {
        if ((err as { status?: number }).status !== 409 || !window.confirm(t("files:overwriteOne", { name: nameOf(path) }))) throw err;
        await api.uploadFile({ scope: "personal", path }, data, true);
      }
      setCopied(path);
    });
  const [copied, setCopied] = useState<string>();
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    if (readOnly) return;
    void droppedFiles(e).then(upload, (err: Error) => setError(err.message));
  };
  // Pasted images and files (Ctrl+V) go into the current folder; text pasted into fields stays there.
  useEffect(() => {
    const paste = (e: ClipboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (readOnly || target?.closest("input, textarea, [contenteditable], .monaco-editor")) return;
      const files = [...(e.clipboardData?.files ?? [])];
      if (!files.length) return;
      e.preventDefault();
      const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
      void upload(files.map((f, i) => ({ path: f.name && f.name !== "image.png" ? f.name : `vlozeno-${stamp}${i ? `-${i}` : ""}.${f.type.split("/")[1] ?? "png"}`, file: f })));
    };
    window.addEventListener("paste", paste);
    return () => window.removeEventListener("paste", paste);
  }, []);

  const runSearch = (ev: FormEvent) => {
    ev.preventDefault();
    if (!search.trim()) return setHits(undefined);
    void attempt(setBusy, setError, async () =>
      setHits((await api.searchFiles(search, loc.scope)).filter((h) => (root ? h.path.startsWith(`${root}/`) : !hide.includes(h.path.split("/")[0]!)))),
    );
  };

  const remove = (e: FileEntry) => {
    if (!window.confirm(e.type === "dir" ? t("files:confirmDeleteDir", { name: e.name }) : t("files:confirmDeleteFile", { name: e.name }))) return;
    void attempt(setBusy, setError, async () => {
      await api.deleteFile({ ...loc, path: e.path });
      if (open && (open.path === e.path || open.path.startsWith(`${e.path}/`))) setOpen(undefined);
      await load();
    });
  };

  const submitEdit = (ev: FormEvent) => {
    ev.preventDefault();
    if (!editing) return;
    void attempt(setBusy, setError, async () => {
      if (editing.kind === "newfile") {
        const path = join(dir, name.includes(".") ? name : `${name}.md`);
        if (!fileType(path)?.text) throw new Error(t("files:newMustBeText"));
        setOpen({ path, kind: "text", text: "", saved: "", isNew: true });
      } else if (editing.kind === "mkdir") await api.makeDir({ ...loc, path: join(dir, name) });
      else await api.moveFile({ ...loc, path: editing.entry.path }, { ...loc, path: join(dir, name) });
      setEditing(undefined);
      await load();
    });
  };
  const startEdit = (next: Editing) => {
    setEditing(next);
    setName(next.kind === "rename" ? next.entry.name : "");
  };

  const crumbs = dir.slice(root.length).split("/").filter(Boolean);
  const finished = uploads.filter((u) => u.state === "done").length;
  const failed = uploads.filter((u) => u.state === "error");

  return (
    <div
      className="relative flex h-full"
      aria-busy={opening}
      onDragOver={(e) => {
        if (readOnly || ![...e.dataTransfer.types].includes("Files")) return;
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={(e) => !e.currentTarget.contains(e.relatedTarget as Node) && setDragging(false)}
      onDrop={onDrop}
    >
      <Loading show={opening} />
      {dragging && (
        <div className="pointer-events-none absolute inset-2 z-20 flex items-center justify-center rounded-md border-2 border-dashed border-primary bg-[var(--accent-primary-soft)] text-sm font-medium text-primary">
          {t("files:dropHere", { folder: crumbs.length ? crumbs.join("/") : title })}
        </div>
      )}
      <div className={`min-w-0 overflow-y-auto p-6 ${open ? "w-[28rem] shrink-0 border-e border-line" : "flex-1"}`}>
        <div className={open ? "" : "mx-auto max-w-4xl"}>
          <h1 className="text-lg font-semibold">{title}</h1>
          {intro && <p className="mt-1 text-sm text-fg-secondary">{intro}</p>}


          <p className="mt-1 text-xs text-fg-muted">{readOnly ? t("files:readOnlyHint") : t("files:dragHint")}</p>
          {copied && <p className="notice mt-3 px-3 py-2 text-sm">{t("files:copied", { path: copied })}</p>}

          {editing && (
            <form onSubmit={submitEdit} className="mt-3 flex gap-2">
              <input
                autoFocus
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={editing.kind === "mkdir" ? t("files:folderName") : editing.kind === "newfile" ? t("files:fileName") : t("files:newName")}
                required
                className="field"
              />
              <button disabled={busy} className="btn-primary text-sm">
                {editing.kind === "rename" ? t("projects:rename") : t("files:create")}
              </button>
              <button type="button" onClick={() => setEditing(undefined)} className="btn-secondary text-sm">
                {t("cancel")}
              </button>
            </form>
          )}

          {uploads.length > 0 && (
            <div className="notice mt-3 px-3 py-2 text-sm">
              <div className="flex items-center gap-2">
                <span className="flex-1">
                  {finished < uploads.length && !uploads.every((u) => u.state !== "waiting" && u.state !== "uploading")
                    ? t("files:uploading", { current: finished + 1, total: uploads.length })
                    : failed.length
                      ? t("files:uploadedFailed", { done: finished, total: uploads.length, count: failed.length })
                      : t("files:uploaded", { done: finished, total: uploads.length })}
                </span>
                {uploads.every((u) => u.state !== "waiting" && u.state !== "uploading") && (
                  <button onClick={() => setUploads([])} className="btn-link text-xs">
                    {t("files:hide")}
                  </button>
                )}
              </div>
              <div className="mt-1 h-1 overflow-hidden rounded-md bg-line">
                <div className="h-full bg-primary transition-all" style={{ width: `${(finished / uploads.length) * 100}%` }} />
              </div>
              {failed.map((u) => (
                <p key={u.path} className="mt-1 text-xs text-error">
                  {u.path.slice(root ? root.length + 1 : 0)}: {u.error}
                </p>
              ))}
            </div>
          )}

          <ErrorNotice error={error} />

          {searchable && <form onSubmit={runSearch} className="mt-4 flex gap-2">
            <input
              type="search"
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                if (!e.target.value) setHits(undefined);
              }}
              placeholder={t("files:searchPlaceholder")}
              className="field"
            />
            <button disabled={busy} className="btn-secondary text-sm">
              {t("files:search")}
            </button>
          </form>}
          {hits && (
            <ul className="mt-2 text-sm">
              {hits.map((h) => (
                <li key={h.path}>
                  <button onClick={() => void openPath(h.path)} className="list-row block w-full px-2 py-1.5 text-start">
                    <code className="text-xs">{h.path.slice(root ? root.length + 1 : 0)}</code>
                    <span className="block truncate text-xs text-fg-secondary">{highlight(h.snippet)}</span>
                  </button>
                </li>
              ))}
              {!hits.length && <li className="px-2 py-1.5 text-fg-muted">{t("nothingFound")}</li>}
            </ul>
          )}

          <nav className="mt-4 flex flex-wrap items-center gap-1 text-sm">
            <button onClick={() => setDir(root)} className="btn-link">
              {title}
            </button>
            {crumbs.map((c, i) => (
              <span key={i} className="flex items-center gap-1">
                <span className="text-fg-muted">/</span>
                <button onClick={() => setDir(join(root, crumbs.slice(0, i + 1).join("/")))} className="btn-link">
                  {c}
                </button>
              </span>
            ))}
          </nav>

          <ul className="mt-2 text-sm">
            {dir !== root && (
              <li>
                <button onClick={() => setDir(dir.slice(0, Math.max(dir.lastIndexOf("/"), 0)))} className="list-row flex w-full items-center gap-2 px-2 py-1.5 text-start text-fg-secondary">
                  <span className="w-4 text-center">↑</span> ..
                </button>
              </li>
            )}
            {entries?.map((e) => (
              <li key={e.path} data-active={open?.path === e.path} className="list-row group flex items-center gap-2 px-2">
                <button onClick={() => openEntry(e)} className="flex min-w-0 flex-1 items-center gap-2 py-1.5 text-start">
                  <Icon entry={e} />
                  <span className={`truncate ${e.type === "dir" ? "font-medium" : ""}`}>{e.name}</span>
                </button>
                {!open && (
                  <>
                    <span className="w-20 shrink-0 text-end text-xs text-fg-muted">{e.type === "file" && fileSize(e.size)}</span>
                    <span className="hidden w-36 shrink-0 text-xs text-fg-muted md:block">{formatDateTime(e.modifiedAt)}</span>
                  </>
                )}
                <span className="flex shrink-0 gap-2 text-xs opacity-0 group-hover:opacity-100 focus-within:opacity-100">
                  {e.type === "file" && (
                    <button onClick={() => void download(e.path)} className="btn-link">
                      {t("download")}
                    </button>
                  )}
                  {readOnly ? (
                    e.type === "file" && (
                      <button onClick={() => void copyOwn(e.path)} className="btn-link">
                        {t("files:copyOwn")}
                      </button>
                    )
                  ) : (
                    <>
                      <button onClick={() => startEdit({ kind: "rename", entry: e })} className="btn-link">
                        {t("projects:rename")}
                      </button>
                      <button onClick={() => remove(e)} className="btn-danger">
                        {t("delete")}
                      </button>
                    </>
                  )}
                </span>
              </li>
            ))}
          </ul>
          {entries && !entries.length && <p className="px-2 py-3 text-sm text-fg-muted">{t("files:emptyFolder")}</p>}
          {!entries && !error && <Pending />}
          <div className={`mt-3 flex flex-wrap gap-2 ${readOnly ? "hidden" : ""}`}>
            <button onClick={() => pickFiles.current?.click()} disabled={busy} className="btn-primary text-sm">
              {t("files:uploadFiles")}
            </button>
            <button onClick={() => pickFolder.current?.click()} disabled={busy} className="btn-secondary text-sm">
              {t("files:uploadFolder")}
            </button>
            <button onClick={() => startEdit({ kind: "newfile" })} disabled={busy} className="btn-secondary text-sm">
              {t("files:newFile")}
            </button>
            <button onClick={() => startEdit({ kind: "mkdir" })} disabled={busy} className="btn-secondary text-sm">
              {t("files:newFolder")}
            </button>
            <input ref={pickFiles} type="file" multiple hidden onChange={(e) => void upload([...(e.target.files ?? [])].map((file) => ({ path: file.name, file }))).finally(() => (e.target.value = ""))} />
            <input
              ref={pickFolder}
              type="file"
              hidden
              {...{ webkitdirectory: "" }}
              onChange={(e) =>
                void upload([...(e.target.files ?? [])].filter((f) => !f.webkitRelativePath.split("/").some((s) => s.startsWith("."))).map((file) => ({ path: file.webkitRelativePath || file.name, file }))).finally(
                  () => (e.target.value = ""),
                )
              }
            />
          </div>
        </div>
      </div>

      {open && (
        <section className="flex min-w-0 flex-1 flex-col p-6">
          <div className="mb-2 flex items-center gap-2 text-sm">
            <code className="min-w-0 flex-1 truncate">{open.path.slice(root ? root.length + 1 : 0)}</code>
            {open.kind === "text" && open.text !== open.saved && <span className="text-xs text-warning">{t("unsaved")}</span>}
            {open.kind === "text" && !readOnly && (
              <button onClick={() => void saveDoc()} disabled={busy || (open.text === open.saved && !open.isNew)} className="btn-primary text-sm">
                {t("save")}
              </button>
            )}
            {readOnly && (
              <button onClick={() => void copyOwn(open.path)} disabled={busy} className="btn-secondary text-sm">
                {t("files:copyOwn")}
              </button>
            )}
            {!(open.kind === "text" && open.isNew) && (
              <button onClick={() => void download(open.path)} className="btn-secondary text-sm">
                {t("download")}
              </button>
            )}
            <button onClick={close} className="btn-secondary text-sm" aria-label={t("close")}>
              {t("close")}
            </button>
          </div>
          <div className="min-h-0 flex-1">
            {open.kind === "text" ? (
              <LazyCodeEditor key={open.path} path={open.path} value={open.text} readOnly={readOnly} onChange={(text) => setOpen({ ...open, text })} height="100%" />
            ) : open.kind === "image" ? (
              <img src={open.url} alt={open.path} className="max-h-full max-w-full object-contain" />
            ) : (
              <p className="text-sm text-fg-muted">
                {t("files:noPreview", { type: fileType(open.path)?.mime ?? t("files:file"), size: fileSize(open.size) })}
              </p>
            )}
          </div>
        </section>
      )}
    </div>
  );
}

/** A search snippet with its matches (marked « and » by the index) in bold. */
function highlight(snippet: string) {
  return snippet.split(/(«[^»]*»)/).map((part, i) => (part.startsWith("«") ? <strong key={i}>{part.slice(1, -1)}</strong> : part));
}

/**
 * Soubory: the project's files and the viewer's own, as two tabs. Members read the project's and copy a file to their own,
 * where it replaces the project's for them (the assistant reads their copy).
 */
export function LayeredFiles({ isAdmin, ...props }: { isAdmin: boolean; hide?: string[]; intro?: ReactNode }) {
  const [tab, setTab] = useState<"project" | "personal">("project");
  return (
    <div className="flex h-full flex-col">
      <nav aria-label={t("app:nav.files")} className="flex shrink-0 items-center gap-2 border-b border-line px-6 py-3">
        {(["project", "personal"] as const).map((s) => (
          <button key={s} type="button" aria-current={tab === s ? "page" : undefined} data-active={tab === s} onClick={() => setTab(s)} className="list-row rounded px-3 py-1.5 text-sm">
            {t(`files:tabs.${s}`)}
          </button>
        ))}
      </nav>
      <div className="min-h-0 flex-1">
        <Files
          key={tab}
          {...props}
          title={t(`files:tabs.${tab}`)}
          location={{ scope: tab }}
          readOnly={tab === "project" && !isAdmin}
          hide={tab === "project" ? props.hide : undefined}
        />
      </div>
    </div>
  );
}
