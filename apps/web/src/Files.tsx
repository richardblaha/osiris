import { fileType, type FileEntry, type FileSearchHit, type Scope } from "@osiris/shared";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { api, saveBlob } from "./api.ts";
import { LazyCodeEditor } from "./LazyCodeEditor.tsx";
import { attempt, ErrorNotice } from "./Scope.tsx";

type Editing = { kind: "mkdir" } | { kind: "newfile" } | { kind: "rename"; entry: FileEntry };
/** A text file open in the editor; `saved` is what's on disk, so unsaved changes show. */
type Doc = { path: string; text: string; saved: string; isNew: boolean };

const IMAGE = /^image\/(png|jpeg|gif|webp)$/;

export const fileSize = (n: number) =>
  n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${Math.round(n / 1024)} kB` : `${(n / 1024 / 1024).toFixed(1)} MB`;

const join = (dir: string, name: string) => (dir ? `${dir}/${name}` : name);

/** The user's own files or the tenant's shared ones (members read, admins write), by the sidebar's tab, folder by folder. */
export function Files({ scope: tab, isAdmin }: { scope: Scope; isAdmin: boolean }) {
  const [dir, setDir] = useState("");
  const [entries, setEntries] = useState<FileEntry[]>();
  const [editing, setEditing] = useState<Editing>();
  const [name, setName] = useState("");
  const [preview, setPreview] = useState<{ path: string; url: string }>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const upload = useRef<HTMLInputElement>(null);
  const [doc, setDoc] = useState<Doc>();
  const [search, setSearch] = useState("");
  const [hits, setHits] = useState<FileSearchHit[]>();
  const editable = tab === "personal" || isAdmin;

  const load = () => api.files(tab, dir).then(setEntries, (e: Error) => setError(e.message));
  useEffect(() => {
    setEntries(undefined);
    setEditing(undefined);
    void load();
  }, [tab, dir]);
  useEffect(() => () => preview && URL.revokeObjectURL(preview.url), [preview]);

  /** Text files open in the editor, images in a preview, anything else downloads. */
  const openPath = (path: string, name = path.split("/").at(-1) ?? path) =>
    attempt(setBusy, setError, async () => {
      const blob = await api.downloadFile({ scope: tab, path });
      const type = fileType(path);
      if (type?.text) {
        const text = await blob.text();
        setDoc({ path, text, saved: text, isNew: false });
      } else if (IMAGE.test(type?.mime ?? "")) setPreview({ path, url: URL.createObjectURL(blob) });
      else saveBlob(blob, name);
    });
  const open = (e: FileEntry) => (e.type === "dir" ? setDir(e.path) : void openPath(e.path, e.name));

  const saveDoc = () =>
    attempt(setBusy, setError, async () => {
      if (!doc) return;
      await api.uploadFile({ scope: tab, path: doc.path }, new Blob([doc.text], { type: fileType(doc.path)?.mime ?? "text/plain" }), !doc.isNew);
      setDoc({ ...doc, saved: doc.text, isNew: false });
      await load();
    });
  const closeDoc = () => {
    if (!doc || doc.text === doc.saved || window.confirm("Zavřít bez uložení změn?")) setDoc(undefined);
  };

  const runSearch = (ev: FormEvent) => {
    ev.preventDefault();
    if (!search.trim()) return setHits(undefined);
    void attempt(setBusy, setError, async () => setHits(await api.searchFiles(search, tab)));
  };

  const uploadFiles = (files: FileList | null) => {
    if (!files?.length) return;
    void attempt(setBusy, setError, async () => {
      for (const file of Array.from(files)) {
        const exists = entries?.some((e) => e.name === file.name);
        if (exists && !window.confirm(`Soubor ${file.name} už existuje. Přepsat?`)) continue;
        await api.uploadFile({ scope: tab, path: join(dir, file.name) }, file, exists);
      }
      await load();
    }).finally(() => {
      if (upload.current) upload.current.value = "";
    });
  };

  const remove = (e: FileEntry) => {
    const what = e.type === "dir" ? `složku ${e.name} i se vším, co obsahuje` : `soubor ${e.name}`;
    if (!window.confirm(`Opravdu smazat ${what}?`)) return;
    void attempt(setBusy, setError, async () => {
      await api.deleteFile({ scope: tab, path: e.path });
      if (preview?.path === e.path) setPreview(undefined);
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
        setDoc({ path, text: "", saved: "", isNew: true });
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

  const crumbs = dir ? dir.split("/") : [];

  return (
    <div className="detail max-w-4xl">
      <h1 className="text-lg font-semibold">Soubory</h1>
      <p className="mt-1 text-sm text-fg-secondary">
        Šablony, obrázky a dokumenty, se kterými asistent pracuje. Šablony dokumentů patří do složky <code>sablony</code>.
      </p>

      {tab === "tenant" && !isAdmin && <p className="mt-2 text-xs text-fg-muted">Firemní soubory může měnit jen správce tenanta.</p>}

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <nav className="flex min-w-0 flex-1 flex-wrap items-center gap-1 text-sm">
          <button onClick={() => setDir("")} className="btn-link">
            {tab === "personal" ? "Moje soubory" : "Firemní"}
          </button>
          {crumbs.map((c, i) => (
            <span key={i} className="flex items-center gap-1">
              <span className="text-fg-muted">/</span>
              <button onClick={() => setDir(crumbs.slice(0, i + 1).join("/"))} className="btn-link">
                {c}
              </button>
            </span>
          ))}
        </nav>
        {editable && (
          <>
            <button onClick={() => startEdit({ kind: "newfile" })} disabled={busy} className="btn-secondary text-sm">
              Nový soubor
            </button>
            <button onClick={() => startEdit({ kind: "mkdir" })} disabled={busy} className="btn-secondary text-sm">
              Nová složka
            </button>
            <button onClick={() => upload.current?.click()} disabled={busy} className="btn-primary text-sm">
              {busy ? "Pracuji…" : "Nahrát"}
            </button>
            <input ref={upload} type="file" multiple hidden onChange={(e) => uploadFiles(e.target.files)} />
          </>
        )}
      </div>

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

      <ErrorNotice error={error} />

      {doc && (
        <section className="mt-4">
          <div className="mb-2 flex items-center gap-2 text-sm">
            <code className="min-w-0 flex-1 truncate">{doc.path}</code>
            {doc.text !== doc.saved && <span className="text-xs text-warning">neuloženo</span>}
            {editable && (
              <button onClick={() => void saveDoc()} disabled={busy || (doc.text === doc.saved && !doc.isNew)} className="btn-primary text-sm">
                Uložit
              </button>
            )}
            <button onClick={closeDoc} className="btn-secondary text-sm">
              Zavřít
            </button>
          </div>
          <LazyCodeEditor key={doc.path} path={doc.path} value={doc.text} readOnly={!editable} onChange={(text) => setDoc({ ...doc, text })} />
        </section>
      )}

      <form onSubmit={runSearch} className="mt-4 flex gap-2">
        <input
          type="search"
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            if (!e.target.value) setHits(undefined);
          }}
          placeholder={`Hledat v textu souborů (${tab === "personal" ? "moje" : "firemní"})`}
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
                <code className="text-xs">{h.path}</code>
                <span className="block truncate text-xs text-fg-secondary">{highlight(h.snippet)}</span>
              </button>
            </li>
          ))}
          {!hits.length && <li className="px-2 py-1.5 text-fg-muted">Nic nenalezeno.</li>}
        </ul>
      )}

      <div className="mt-3 overflow-x-auto">
        <table className="w-full text-sm">
          <tbody>
            {entries?.map((e) => (
              <tr key={e.path} className="list-row group border-b border-line">
                <td className="py-1.5 pr-2">
                  <button onClick={() => open(e)} className="flex items-center gap-2 text-left">
                    <span aria-hidden="true" className="text-fg-muted">
                      {e.type === "dir" ? "▸" : "·"}
                    </span>
                    <span className={e.type === "dir" ? "font-medium" : ""}>{e.name}</span>
                  </button>
                </td>
                <td className="w-24 py-1.5 pr-2 text-right text-fg-muted">{e.type === "file" && fileSize(e.size)}</td>
                <td className="hidden w-40 py-1.5 pr-2 text-fg-muted sm:table-cell">{new Date(e.modifiedAt).toLocaleString("cs-CZ")}</td>
                <td className="w-48 py-1.5 text-right whitespace-nowrap">
                  {e.type === "file" && (
                    <button
                      onClick={() => void attempt(setBusy, setError, async () => saveBlob(await api.downloadFile({ scope: tab, path: e.path }), e.name))}
                      className="btn-link mr-3"
                    >
                      Stáhnout
                    </button>
                  )}
                  {editable && (
                    <>
                      <button onClick={() => startEdit({ kind: "rename", entry: e })} className="btn-link mr-3">
                        Přejmenovat
                      </button>
                      <button onClick={() => remove(e)} className="btn-danger">
                        Smazat
                      </button>
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {entries && !entries.length && <p className="py-3 text-sm text-fg-muted">Prázdná složka.</p>}
        {!entries && !error && <p className="py-3 text-sm text-fg-muted">Načítám…</p>}
      </div>

      {preview && (
        <figure className="notice mt-4 p-3">
          <img src={preview.url} alt={preview.path} className="max-h-96 max-w-full" />
          <figcaption className="mt-2 flex justify-between text-xs text-fg-muted">
            {preview.path}
            <button onClick={() => setPreview(undefined)} className="btn-link">
              Zavřít
            </button>
          </figcaption>
        </figure>
      )}
    </div>
  );
}

/** A search snippet with its matches (marked « and » by the index) in bold. */
function highlight(snippet: string) {
  return snippet.split(/(«[^»]*»)/).map((part, i) => (part.startsWith("«") ? <strong key={i}>{part.slice(1, -1)}</strong> : part));
}
