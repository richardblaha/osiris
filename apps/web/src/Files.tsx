import { fileType, type FileEntry, type FileSearchHit } from "@osiris/shared";
import { useEffect, useRef, useState, type DragEvent, type FormEvent, type ReactNode } from "react";
import { api, saveBlob } from "./api.ts";
import { LazyCodeEditor } from "./LazyCodeEditor.tsx";
import { attempt, ErrorNotice } from "./Scope.tsx";

type Editing = { kind: "mkdir" } | { kind: "newfile" } | { kind: "rename"; entry: FileEntry };
/** A file open on the right: text in the editor (`saved` is what's on disk), an image, or anything else. */
type Open = { path: string; kind: "text"; text: string; saved: string; isNew: boolean } | { path: string; kind: "image"; url: string } | { path: string; kind: "other"; size: number };
/** One file of an upload, with how it went. */
type Upload = { path: string; file: File; state: "waiting" | "uploading" | "done" | "exists" | "error"; error?: string };

const IMAGE = /^image\/(png|jpeg|gif|webp|svg\+xml)$/;
/** Folders with their own views (Dovednosti, Kontroly, Weby): not in Soubory. */
export const OWN_VIEWS = ["skills", "guards", "vitepress", "www"];

export const fileSize = (n: number) =>
  n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${Math.round(n / 1024)} kB` : `${(n / 1024 / 1024).toFixed(1)} MB`;

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
 * The tenant's files, folder by folder; everyone in the tenant may change them. `root` limits the view to one folder
 * (a website's template), `hide` leaves out top-level folders that have views of their own.
 */
export function Files({ root = "", title = "Soubory", intro, hide = [] }: { root?: string; title?: string; intro?: ReactNode; hide?: string[] }) {
  const tab = "tenant";
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
    api.files(tab, dir).then(
      (list) => setEntries(dir === "" ? list.filter((e) => !hide.includes(e.name)) : list),
      (e: Error) => setError(e.message),
    );
  useEffect(() => {
    setEntries(undefined);
    setEditing(undefined);
    void load();
  }, [dir]);
  useEffect(() => () => void (open?.kind === "image" && URL.revokeObjectURL(open.url)), [open]);

  /** Text files open in the editor, images in the preview, anything else with its download. */
  const openPath = (path: string, size = 0) =>
    attempt(setBusy, setError, async () => {
      if (open?.kind === "text" && open.text !== open.saved && !window.confirm("Zavřít bez uložení změn?")) return;
      const type = fileType(path);
      if (type?.text) {
        const text = await (await api.downloadFile({ scope: tab, path })).text();
        setOpen({ path, kind: "text", text, saved: text, isNew: false });
      } else if (IMAGE.test(type?.mime ?? "")) setOpen({ path, kind: "image", url: URL.createObjectURL(await api.downloadFile({ scope: tab, path })) });
      else setOpen({ path, kind: "other", size });
    });
  const openEntry = (e: FileEntry) => (e.type === "dir" ? setDir(e.path) : void openPath(e.path, e.size));
  const download = (path: string) => attempt(setBusy, setError, async () => saveBlob(await api.downloadFile({ scope: tab, path }), nameOf(path)));

  const saveDoc = () =>
    attempt(setBusy, setError, async () => {
      if (open?.kind !== "text") return;
      await api.uploadFile({ scope: tab, path: open.path }, new Blob([open.text], { type: fileType(open.path)?.mime ?? "text/plain" }), !open.isNew);
      setOpen({ ...open, saved: open.text, isNew: false });
      await load();
    });
  const close = () => {
    if (open?.kind !== "text" || open.text === open.saved || window.confirm("Zavřít bez uložení změn?")) setOpen(undefined);
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
        await api.uploadFile({ scope: tab, path: queue[i]!.path }, queue[i]!.file, overwrite);
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
    if (existing.length && window.confirm(existing.length === 1 ? `Soubor ${nameOf(queue[existing[0]!]!.path)} už existuje. Přepsat?` : `${existing.length} souborů už existuje. Přepsat je?`)) {
      for (const i of existing) await send(i, true);
    }
    await load();
  };
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    void droppedFiles(e).then(upload, (err: Error) => setError(err.message));
  };
  // Pasted images and files (Ctrl+V) go into the current folder; text pasted into fields stays there.
  useEffect(() => {
    const paste = (e: ClipboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target?.closest("input, textarea, [contenteditable], .monaco-editor")) return;
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
      setHits((await api.searchFiles(search, tab)).filter((h) => (root ? h.path.startsWith(`${root}/`) : !hide.includes(h.path.split("/")[0]!)))),
    );
  };

  const remove = (e: FileEntry) => {
    const what = e.type === "dir" ? `složku ${e.name} i se vším, co obsahuje` : `soubor ${e.name}`;
    if (!window.confirm(`Opravdu smazat ${what}?`)) return;
    void attempt(setBusy, setError, async () => {
      await api.deleteFile({ scope: tab, path: e.path });
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
        if (!fileType(path)?.text) throw new Error("Nový soubor musí být textový (např. .md, .txt, .html, .css, .json)");
        setOpen({ path, kind: "text", text: "", saved: "", isNew: true });
      } else if (editing.kind === "mkdir") await api.makeDir({ scope: tab, path: join(dir, name) });
      else await api.moveFile({ scope: tab, path: editing.entry.path }, { scope: tab, path: join(dir, name) });
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
      onDragOver={(e) => {
        if (![...e.dataTransfer.types].includes("Files")) return;
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={(e) => !e.currentTarget.contains(e.relatedTarget as Node) && setDragging(false)}
      onDrop={onDrop}
    >
      {dragging && (
        <div className="pointer-events-none absolute inset-2 z-20 flex items-center justify-center rounded-md border-2 border-dashed border-primary bg-[var(--accent-primary-soft)] text-sm font-medium text-primary">
          Pusťte soubory nebo složky sem, nahrají se do {crumbs.length ? crumbs.join("/") : title}
        </div>
      )}
      <div className={`min-w-0 overflow-y-auto p-6 ${open ? "w-[28rem] shrink-0 border-r border-line" : "flex-1"}`}>
        <div className={open ? "" : "mx-auto max-w-4xl"}>
          <h1 className="text-lg font-semibold">{title}</h1>
          {intro && <p className="mt-1 text-sm text-fg-secondary">{intro}</p>}

          <div className="mt-3 flex flex-wrap gap-2">
            <button onClick={() => pickFiles.current?.click()} disabled={busy} className="btn-primary text-sm">
              Nahrát soubory
            </button>
            <button onClick={() => pickFolder.current?.click()} disabled={busy} className="btn-secondary text-sm">
              Nahrát složku
            </button>
            <button onClick={() => startEdit({ kind: "newfile" })} disabled={busy} className="btn-secondary text-sm">
              Nový soubor
            </button>
            <button onClick={() => startEdit({ kind: "mkdir" })} disabled={busy} className="btn-secondary text-sm">
              Nová složka
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
          <p className="mt-1 text-xs text-fg-muted">Soubory i celé složky můžete sem přetáhnout, obrázek vložit ze schránky (Ctrl+V).</p>

          {editing && (
            <form onSubmit={submitEdit} className="mt-3 flex gap-2">
              <input
                autoFocus
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={editing.kind === "mkdir" ? "Název složky" : editing.kind === "newfile" ? "Název souboru, např. poznamky.md" : "Nový název"}
                required
                className="field"
              />
              <button disabled={busy} className="btn-primary text-sm">
                {editing.kind === "rename" ? "Přejmenovat" : "Vytvořit"}
              </button>
              <button type="button" onClick={() => setEditing(undefined)} className="btn-secondary text-sm">
                Zrušit
              </button>
            </form>
          )}

          {uploads.length > 0 && (
            <div className="notice mt-3 px-3 py-2 text-sm">
              <div className="flex items-center gap-2">
                <span className="flex-1">
                  {finished < uploads.length && !uploads.every((u) => u.state !== "waiting" && u.state !== "uploading")
                    ? `Nahrávám ${finished + 1} z ${uploads.length}…`
                    : `Nahráno ${finished} z ${uploads.length}${failed.length ? `, ${failed.length} se nepodařilo` : ""}.`}
                </span>
                {uploads.every((u) => u.state !== "waiting" && u.state !== "uploading") && (
                  <button onClick={() => setUploads([])} className="btn-link text-xs">
                    Skrýt
                  </button>
                )}
              </div>
              <div className="mt-1 h-1 overflow-hidden rounded bg-line">
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

          <form onSubmit={runSearch} className="mt-4 flex gap-2">
            <input
              type="search"
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                if (!e.target.value) setHits(undefined);
              }}
              placeholder="Hledat v textu souborů"
              className="field"
            />
            <button disabled={busy} className="btn-secondary text-sm">
              Hledat
            </button>
          </form>
          {hits && (
            <ul className="mt-2 text-sm">
              {hits.map((h) => (
                <li key={h.path}>
                  <button onClick={() => void openPath(h.path)} className="list-row block w-full px-2 py-1.5 text-left">
                    <code className="text-xs">{h.path.slice(root ? root.length + 1 : 0)}</code>
                    <span className="block truncate text-xs text-fg-secondary">{highlight(h.snippet)}</span>
                  </button>
                </li>
              ))}
              {!hits.length && <li className="px-2 py-1.5 text-fg-muted">Nic nenalezeno.</li>}
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
                <button onClick={() => setDir(dir.slice(0, Math.max(dir.lastIndexOf("/"), 0)))} className="list-row flex w-full items-center gap-2 px-2 py-1.5 text-left text-fg-secondary">
                  <span className="w-4 text-center">↑</span> ..
                </button>
              </li>
            )}
            {entries?.map((e) => (
              <li key={e.path} data-active={open?.path === e.path} className="list-row group flex items-center gap-2 px-2">
                <button onClick={() => openEntry(e)} className="flex min-w-0 flex-1 items-center gap-2 py-1.5 text-left">
                  <Icon entry={e} />
                  <span className={`truncate ${e.type === "dir" ? "font-medium" : ""}`}>{e.name}</span>
                </button>
                {!open && (
                  <>
                    <span className="w-20 shrink-0 text-right text-xs text-fg-muted">{e.type === "file" && fileSize(e.size)}</span>
                    <span className="hidden w-36 shrink-0 text-xs text-fg-muted md:block">{new Date(e.modifiedAt).toLocaleString("cs-CZ")}</span>
                  </>
                )}
                <span className="flex shrink-0 gap-2 text-xs opacity-0 group-hover:opacity-100 focus-within:opacity-100">
                  {e.type === "file" && (
                    <button onClick={() => void download(e.path)} className="btn-link">
                      Stáhnout
                    </button>
                  )}
                  <button onClick={() => startEdit({ kind: "rename", entry: e })} className="btn-link">
                    Přejmenovat
                  </button>
                  <button onClick={() => remove(e)} className="btn-danger">
                    Smazat
                  </button>
                </span>
              </li>
            ))}
          </ul>
          {entries && !entries.length && <p className="px-2 py-3 text-sm text-fg-muted">Prázdná složka. Přetáhněte sem soubory.</p>}
          {!entries && !error && <p className="py-3 text-sm text-fg-muted">Načítám…</p>}
        </div>
      </div>

      {open && (
        <section className="flex min-w-0 flex-1 flex-col p-6">
          <div className="mb-2 flex items-center gap-2 text-sm">
            <code className="min-w-0 flex-1 truncate">{open.path.slice(root ? root.length + 1 : 0)}</code>
            {open.kind === "text" && open.text !== open.saved && <span className="text-xs text-warning">neuloženo</span>}
            {open.kind === "text" && (
              <button onClick={() => void saveDoc()} disabled={busy || (open.text === open.saved && !open.isNew)} className="btn-primary text-sm">
                Uložit
              </button>
            )}
            {!(open.kind === "text" && open.isNew) && (
              <button onClick={() => void download(open.path)} className="btn-secondary text-sm">
                Stáhnout
              </button>
            )}
            <button onClick={close} className="btn-secondary text-sm" aria-label="Zavřít">
              Zavřít
            </button>
          </div>
          <div className="min-h-0 flex-1">
            {open.kind === "text" ? (
              <LazyCodeEditor key={open.path} path={open.path} value={open.text} onChange={(text) => setOpen({ ...open, text })} height="100%" />
            ) : open.kind === "image" ? (
              <img src={open.url} alt={open.path} className="max-h-full max-w-full object-contain" />
            ) : (
              <p className="text-sm text-fg-muted">
                {fileType(open.path)?.mime ?? "Soubor"} · {fileSize(open.size)}. Náhled tu není, soubor si můžete stáhnout.
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
