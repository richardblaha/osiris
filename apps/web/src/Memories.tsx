import type { Memory, Scope } from "@osiris/shared";
import { useState, type FormEvent } from "react";
import { api } from "./api.ts";
import { attempt, canEdit, DetailHeader, ErrorNotice, Field, ScopePicker, type DetailProps } from "./Scope.tsx";

export const memoryKey = (m: Memory) => m.id;

const INTRO = "Fakta, která si asistent pamatuje mezi konverzacemi. Ukládá si je i sám, když mu něco řekneš.";

export function MemoryDetail({ item, isAdmin, onSaved, onDeleted }: DetailProps<Memory>) {
  const [content, setContent] = useState("");
  const [scope, setScope] = useState<Scope>("personal");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  if (item) {
    const editable = canEdit(item.scope, isAdmin);
    return (
      <div className="detail">
        <DetailHeader title="Záznam v paměti" scope={item.scope} canEdit={editable}>
          {INTRO}
        </DetailHeader>
        <p className="notice mt-6 px-3 py-2 whitespace-pre-wrap">{item.content}</p>
        <p className="mt-1 text-xs text-fg-muted">Uloženo {new Date(item.createdAt).toLocaleString("cs-CZ")}</p>
        {editable && (
          <button
            disabled={busy}
            onClick={() => attempt(setBusy, setError, async () => (await api.deleteMemory(item.id, item.scope), onDeleted()))}
            className="btn-danger mt-6 text-sm"
          >
            Zapomenout
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
      <DetailHeader title="Nový záznam v paměti" canEdit>
        {INTRO}
      </DetailHeader>
      <form onSubmit={submit} className="mt-6 space-y-4">
        <ScopePicker value={scope} onChange={setScope} isAdmin={isAdmin} />
        <Field label="Co si má pamatovat">
          <textarea
            value={content}
            onChange={(e) => setContent(e.target.value)}
            placeholder="Např. Nejsem plátce DPH. Zálohy chci 50 % předem."
            maxLength={500}
            rows={4}
            required
            className="field"
          />
        </Field>
        <button disabled={busy} className="btn-primary">
          {busy ? "Ukládám…" : "Přidat"}
        </button>
      </form>
      <ErrorNotice error={error} />
    </div>
  );
}
