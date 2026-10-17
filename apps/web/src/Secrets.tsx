import type { Scope, SecretSummary } from "@osiris/shared";
import { useState, type FormEvent } from "react";
import { api } from "./api.ts";
import { attempt, canEdit, DetailHeader, ErrorNotice, Field, ScopePicker, type DetailProps } from "./Scope.tsx";

const NAME = /^[A-Z][A-Z0-9_]{0,63}$/;
const parseHosts = (text: string) => text.split(/[\s,]+/).map((h) => h.trim().toLowerCase()).filter(Boolean);

export const secretKey = (s: Pick<SecretSummary, "scope" | "name">) => `${s.scope}:${s.name}`;

export function SecretDetail({ item, isAdmin, onSaved, onDeleted }: DetailProps<SecretSummary>) {
  const [name, setName] = useState(item?.name ?? "");
  const [value, setValue] = useState("");
  const [hosts, setHosts] = useState(item?.allowedHosts.join(", ") ?? "");
  const [description, setDescription] = useState(item?.description ?? "");
  const [scope, setScope] = useState<Scope>(item?.scope ?? "personal");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const editable = !item || canEdit(item.scope, isAdmin);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    void attempt(setBusy, setError, async () => {
      // When editing, an empty value keeps the stored one.
      await api.saveSecret(name, { value: value || undefined, allowedHosts: parseHosts(hosts), description, scope });
      onSaved(secretKey({ scope, name }));
    });
  };

  return (
    <div className="detail">
      <DetailHeader title={item?.name ?? "Nový klíč"} scope={item?.scope} canEdit={editable}>
        API klíč nebo token pro MCP servery a webová API. Ukládá se šifrovaně a po uložení už ho nikdo neuvidí, ani ty.
        Používá se jako <code className="text-fg">{`{{secret:${name || "NÁZEV"}}}`}</code> a odešle se jen na povolené domény.
      </DetailHeader>

      <form onSubmit={submit} className="mt-6 space-y-4" autoComplete="off">
        {!item && <ScopePicker value={scope} onChange={setScope} isAdmin={isAdmin} />}
        <Field label="Název">
          <input
            value={name}
            onChange={(e) => setName(e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, "_"))}
            placeholder="např. FAKTUROID_TOKEN"
            pattern={NAME.source}
            readOnly={!!item}
            required
            className="field"
          />
        </Field>
        {editable && (
          <Field label="Hodnota">
            <input
              type="password"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder={item ? "Nová hodnota (prázdné = beze změny)" : ""}
              required={!item}
              autoComplete="new-password"
              className="field"
            />
          </Field>
        )}
        <Field label="Povolené domény">
          <input
            value={hosts}
            onChange={(e) => setHosts(e.target.value)}
            placeholder="např. api.fakturoid.cz, *.example.com"
            readOnly={!editable}
            required
            className="field"
          />
        </Field>
        <Field label="K čemu slouží">
          <input
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="vidí ho i asistent"
            readOnly={!editable}
            maxLength={300}
            className="field"
          />
        </Field>
        {editable && (
          <div className="flex items-center gap-4">
            <button disabled={busy} className="btn-primary">
              {busy ? "Ukládám…" : item ? "Uložit" : "Přidat"}
            </button>
            {item && (
              <button
                type="button"
                disabled={busy}
                onClick={() => attempt(setBusy, setError, async () => (await api.deleteSecret(item.name, item.scope), onDeleted()))}
                className="btn-danger text-sm"
              >
                Smazat
              </button>
            )}
          </div>
        )}
      </form>
      <ErrorNotice error={error} />
    </div>
  );
}
