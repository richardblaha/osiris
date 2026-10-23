import type { Memory, Scope } from "@osiris/shared";
import { useState, type FormEvent } from "react";
import { api } from "./api.ts";
import { attempt, canEdit, DetailHeader, ErrorNotice, Field, OwnCopy, ScopeChoice, type DetailProps } from "./Scope.tsx";
import { t } from "i18next";
import { formatDateTime } from "./i18n.ts";

export const memoryKey = (m: Memory) => m.id;

const intro = () => t("memory:intro");

/**
 * A memory, the project's or the viewer's own. A member may write their own version of a project memory, which
 * replaces it for them.
 */
export function MemoryDetail({ item, scope, isAdmin, onSaved, onDeleted }: DetailProps<Memory>) {
  const [target, setTarget] = useState<Scope>(scope);
  const [content, setContent] = useState("");
  // Writing the viewer's own version of a project memory.
  const [copying, setCopying] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const form = (submit: (e: FormEvent) => void, label: string) => (
    <form onSubmit={submit} className="mt-6 space-y-4">
      <Field label={t("memory:what")}>
        <textarea
          value={content}
          onChange={(e) => setContent(e.target.value)}
          placeholder={t("memory:placeholder")}
          maxLength={500}
          rows={4}
          required
          className="field"
        />
      </Field>
      <button disabled={busy} className="btn-primary">
        {busy ? t("saving") : label}
      </button>
    </form>
  );

  if (item) {
    const editable = canEdit(item.scope, isAdmin);
    const copy = (e: FormEvent) => {
      e.preventDefault();
      void attempt(setBusy, setError, async () => onSaved(memoryKey(await api.addMemory(content, "personal", item.id))));
    };
    return (
      <div className="detail">
        <DetailHeader title={t("memory:item")} scope={item.scope} canEdit={editable} overridden={item.overridden}>
          {intro()}
        </DetailHeader>
        <p className="notice mt-6 px-3 py-2 whitespace-pre-wrap">{item.content}</p>
        <p className="mt-1 text-xs text-fg-muted">
          {t("memory:saved", { time: formatDateTime(item.createdAt) })}
          {item.overrides && ` · ${t("memory:replaces")}`}
        </p>
        {editable && (
          <button
            disabled={busy}
            onClick={() => attempt(setBusy, setError, async () => (await api.deleteMemory(item.id, item.scope), onDeleted()))}
            className="btn-danger mt-6 text-sm"
          >
            {t("memory:forget")}
          </button>
        )}
        {!editable && !item.overridden && !copying && <OwnCopy busy={busy} onClick={() => (setContent(item.content), setCopying(true))} />}
        {copying && form(copy, t("memory:saveOwn"))}
        <ErrorNotice error={error} />
      </div>
    );
  }

  const submit = (e: FormEvent) => {
    e.preventDefault();
    void attempt(setBusy, setError, async () => onSaved(memoryKey(await api.addMemory(content, target))));
  };

  return (
    <div className="detail">
      <DetailHeader title={t("memory:new")} scope={target} canEdit>
        {intro()}
      </DetailHeader>
      <div className="mt-6">
        <ScopeChoice value={target} onChange={setTarget} isAdmin={isAdmin} />
      </div>
      {form(submit, t("add"))}
      <ErrorNotice error={error} />
    </div>
  );
}
