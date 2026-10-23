import type { DocumentSummary, Scope } from "@osiris/shared";
import { useEffect, useState, type FormEvent } from "react";
import { api } from "./api.ts";
import { LazyCodeEditor } from "./LazyCodeEditor.tsx";
import { attempt, canEdit, DetailHeader, ErrorNotice, Field, OwnCopy, ScopeChoice, type DetailProps, Pending } from "./Scope.tsx";
import { t } from "i18next";
import { formatDateTime } from "./i18n.ts";

export const documentKey = (d: Pick<DocumentSummary, "scope" | "id">) => `${d.scope}:${d.id}`;

const intro = () => t("knowledge:intro");

/**
 * A document of the knowledge base, the tenant's or the viewer's own: kept in the tenant's database and indexed as
 * it's saved. A member reads the tenant's and may make their own copy of one, which replaces it for them.
 */
export function KnowledgeDetail({ item, scope, isAdmin, onSaved, onDeleted }: DetailProps<DocumentSummary>) {
  const [target, setTarget] = useState<Scope>(scope);
  const [title, setTitle] = useState(item?.title ?? "");
  const [folder, setFolder] = useState("");
  const [content, setContent] = useState(item ? undefined : "");
  const [saved, setSaved] = useState<{ title: string; content: string }>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (!item) return;
    api.document(item.id, item.scope).then(
      (d) => (setTitle(d.title), setContent(d.content), setSaved({ title: d.title, content: d.content })),
      (e: Error) => setError(e.message),
    );
  }, []);

  if (item) {
    const editable = canEdit(item.scope, isAdmin);
    const dirty = !!saved && (title !== saved.title || content !== saved.content);
    const save = () =>
      attempt(setBusy, setError, async () => {
        await api.saveDocument(item.id, title, content ?? "", item.scope);
        setSaved({ title, content: content ?? "" });
        onSaved(documentKey(item));
      });
    const copy = () =>
      attempt(setBusy, setError, async () =>
        onSaved(documentKey(await api.addDocument({ title, content: content ?? "", scope: "personal", id: item.id }))),
      );
    return (
      <div className="detail max-w-4xl">
        <DetailHeader title={item.title} scope={item.scope} canEdit={editable} overridden={item.overridden}>
          {intro()}
        </DetailHeader>
        <p className="mt-2 text-xs text-fg-muted">
          <code>{item.id}</code> · {t("knowledge:chunks", { count: item.chunks })} · {t("knowledge:changed", { time: formatDateTime(item.createdAt) })}
        </p>
        <Field label={t("name")}>
          <input value={title} onChange={(e) => setTitle(e.target.value)} readOnly={!editable} required maxLength={200} className="field mt-1" />
        </Field>
        <div className="mt-4">
          {content === undefined ? (
            <Pending error={error} className="relative h-[60vh] rounded-md border border-line" />
          ) : (
            <LazyCodeEditor path={item.id.endsWith(".md") ? item.id : `${item.id}.md`} value={content} readOnly={!editable} onChange={setContent} />
          )}
        </div>
        {!editable && !item.overridden && content !== undefined && <OwnCopy busy={busy} onClick={() => void copy()} />}
        <div className={`mt-4 flex items-center gap-4 ${editable ? "" : "hidden"}`}>
          <button disabled={busy || !dirty || !title.trim() || !content?.trim()} onClick={() => void save()} className="btn-primary">
            {busy ? t("saving") : t("save")}
          </button>
          {dirty && <span className="text-xs text-warning">{t("unsaved")}</span>}
          <span className="flex-1" />
          <button
            disabled={busy}
            onClick={() => window.confirm(t("knowledge:confirmDelete", { title: item.title })) && void attempt(setBusy, setError, async () => (await api.deleteDocument(item.id, item.scope), onDeleted()))}
            className="btn-danger text-sm"
          >
            {t("knowledge:delete")}
          </button>
        </div>
        <ErrorNotice error={error} />
      </div>
    );
  }

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!content?.trim()) return setError(t("knowledge:textRequired"));
    void attempt(setBusy, setError, async () => onSaved(documentKey(await api.addDocument({ title, content, folder: folder.trim() || undefined, scope: target }))));
  };

  return (
    <div className="detail max-w-4xl">
      <DetailHeader title={t("knowledge:new")} scope={target} canEdit>
        {intro()}
      </DetailHeader>
      <form onSubmit={submit} className="mt-6 space-y-4">
        <ScopeChoice value={target} onChange={setTarget} isAdmin={isAdmin} />
        <div className="grid gap-3 sm:grid-cols-[2fr_1fr]">
          <Field label={t("name")}>
            <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder={t("knowledge:titlePlaceholder")} required className="field" />
          </Field>
          <Field label={t("knowledge:folder")}>
            <input value={folder} onChange={(e) => setFolder(e.target.value)} placeholder="public" className="field" />
          </Field>
        </div>
        <div className="space-y-1">
          <span className="section-header block">{t("knowledge:text")}</span>
          <LazyCodeEditor path="novy.md" value={content ?? ""} onChange={setContent} height="50vh" />
        </div>
        <button disabled={busy} className="btn-primary">
          {busy ? t("saving") : t("add")}
        </button>
      </form>
      <ErrorNotice error={error} />
    </div>
  );
}
