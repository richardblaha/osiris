import type { Scope, SecretSummary } from "@osiris/shared";
import { useState, type FormEvent } from "react";
import { api } from "./api.ts";
import { attempt, canEdit, DetailHeader, ErrorNotice, Field, type DetailProps } from "./Scope.tsx";
import { t } from "i18next";
import { Trans } from "react-i18next";

const NAME = /^[A-Z][A-Z0-9_]{0,63}$/;
const parseHosts = (text: string) => text.split(/[\s,]+/).map((h) => h.trim().toLowerCase()).filter(Boolean);

export const secretKey = (s: Pick<SecretSummary, "scope" | "name">) => `${s.scope}:${s.name}`;

export function SecretDetail({ item, scope: tab, isAdmin, onSaved, onDeleted }: DetailProps<SecretSummary>) {
  const [name, setName] = useState(item?.name ?? "");
  const [value, setValue] = useState("");
  const [hosts, setHosts] = useState(item?.allowedHosts.join(", ") ?? "");
  const [description, setDescription] = useState(item?.description ?? "");
  const scope = item?.scope ?? tab;
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
      <DetailHeader title={item?.name ?? t("secrets:new")} scope={scope} canEdit={editable}>
        <Trans ns="secrets" i18nKey="intro" values={{ reference: `{{secret:${name || t("secrets:namePlaceholderShort")}}}` }} components={{ code: <code className="text-fg" /> }} />
      </DetailHeader>

      <form onSubmit={submit} className="mt-6 space-y-4" autoComplete="off">
        <Field label={t("name")}>
          <input
            value={name}
            onChange={(e) => setName(e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, "_"))}
            placeholder={t("secrets:namePlaceholder")}
            pattern={NAME.source}
            readOnly={!!item}
            required
            className="field"
          />
        </Field>
        {editable && (
          <Field label={t("secrets:value")}>
            <input
              type="password"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder={item ? t("secrets:valueKeep") : ""}
              required={!item}
              autoComplete="new-password"
              className="field"
            />
          </Field>
        )}
        <Field label={t("secrets:hosts")}>
          <input
            value={hosts}
            onChange={(e) => setHosts(e.target.value)}
            placeholder={t("secrets:hostsPlaceholder")}
            readOnly={!editable}
            required
            className="field"
          />
        </Field>
        <Field label={t("secrets:purpose")}>
          <input
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder={t("secrets:purposePlaceholder")}
            readOnly={!editable}
            maxLength={300}
            className="field"
          />
        </Field>
        {editable && (
          <div className="flex items-center gap-4">
            <button disabled={busy} className="btn-primary">
              {busy ? t("saving") : item ? t("save") : t("add")}
            </button>
            {item && (
              <button
                type="button"
                disabled={busy}
                onClick={() => attempt(setBusy, setError, async () => (await api.deleteSecret(item.name, item.scope), onDeleted()))}
                className="btn-danger text-sm"
              >
                {t("delete")}
              </button>
            )}
          </div>
        )}
      </form>
      <ErrorNotice error={error} />
    </div>
  );
}
