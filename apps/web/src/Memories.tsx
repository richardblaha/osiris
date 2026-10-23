import type { Memory, Scope } from "@osiris/shared";
import { useState, type FormEvent } from "react";
import { api } from "./api.ts";
import { attempt, DetailHeader, ErrorNotice, Field, type DetailProps } from "./Scope.tsx";
import { t } from "i18next";
import { formatDateTime } from "./i18n.ts";

export const memoryKey = (m: Memory) => m.id;

const intro = () => t("memory:intro");

export function MemoryDetail({ item, scope, isAdmin, onSaved, onDeleted }: DetailProps<Memory>) {
  const [content, setContent] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  if (item) {
    const editable = true;
    return (
      <div className="detail">
        <DetailHeader title={t("memory:item")} scope={item.scope} canEdit={editable}>
          {intro()}
        </DetailHeader>
        <p className="notice mt-6 px-3 py-2 whitespace-pre-wrap">{item.content}</p>
        <p className="mt-1 text-xs text-fg-muted">{t("memory:saved", { time: formatDateTime(item.createdAt) })}</p>
        {editable && (
          <button
            disabled={busy}
            onClick={() => attempt(setBusy, setError, async () => (await api.deleteMemory(item.id, item.scope), onDeleted()))}
            className="btn-danger mt-6 text-sm"
          >
            {t("memory:forget")}
          </button>
        )}
        <ErrorNotice error={error} />
      </div>
    );
  }

  const submit = (e: FormEvent) => {
    e.preventDefault();
    void attempt(setBusy, setError, async () => onSaved(memoryKey(await api.addMemory(content, scope))));
  };

  return (
    <div className="detail">
      <DetailHeader title={t("memory:new")} scope={scope} canEdit>
        {intro()}
      </DetailHeader>
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
          {busy ? t("saving") : t("add")}
        </button>
      </form>
      <ErrorNotice error={error} />
    </div>
  );
}
