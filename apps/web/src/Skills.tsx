import type { Scope, SkillSummary } from "@osiris/shared";
import { useEffect, useState, type FormEvent } from "react";
import { api } from "./api.ts";
import { attempt, canEdit, DetailHeader, ErrorNotice, Field, type DetailProps } from "./Scope.tsx";

const NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export const skillKey = (s: Pick<SkillSummary, "source" | "name">) => `${s.source}:${s.name}`;

/**
 * Every skill the user can see: their own, the tenant's and the bundled ones not replaced by the tenant.
 * A personal skill shadows a tenant skill of the same name for the user, but both are listed.
 */
export async function loadSkills(): Promise<SkillSummary[]> {
  const [personal, tenant] = await Promise.all([api.skills("personal"), api.skills("tenant")]);
  return [...personal.filter((s) => s.source === "personal"), ...tenant].sort((a, b) => a.name.localeCompare(b.name));
}

const INTRO =
  "Postupy, podle kterých asistent pracuje (např. jak sestavit nabídku). Osobní dovednost má přednost před dovedností tenanta a ta před výchozí se stejným názvem.";

export function SkillDetail({ item, scope: tab, isAdmin, onSaved, onDeleted }: DetailProps<SkillSummary>) {
  const [name, setName] = useState(item?.name ?? "");
  const [description, setDescription] = useState(item?.description ?? "");
  const [instructions, setInstructions] = useState("");
  /** A bundled skill, or a tenant one for a member, is changed by saving a copy at a scope the user may write. */
  const own = item && item.source !== "bundled" && canEdit(item.source, isAdmin);
  // A copy goes to the tab's scope when the user may write there, otherwise to their own skills.
  const scope: Scope = own ? (item.source as Scope) : tab === "tenant" && isAdmin ? "tenant" : "personal";
  const [loaded, setLoaded] = useState(!item);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (!item) return;
    api.skill(item.name, item.source === "personal" ? "personal" : "tenant").then((s) => {
      setInstructions(s.instructions);
      setLoaded(true);
    }, (e: Error) => setError(e.message));
  }, []);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    void attempt(setBusy, setError, async () => {
      await api.saveSkill(name, description, instructions, scope);
      onSaved(skillKey({ source: scope, name }));
    });
  };

  return (
    <div className="detail">
      <DetailHeader title={item?.name ?? "Nová dovednost"} scope={item ? (item.source === "bundled" ? undefined : item.source) : scope} canEdit={!!own}>
        {item?.source === "bundled" ? "Výchozí dovednost, která je součástí aplikace. Změníš ji uložením kopie se stejným názvem." : INTRO}
      </DetailHeader>
      {loaded && (
        <form onSubmit={submit} className="mt-6 space-y-4">
          <Field label="Název">
            <input
              value={name}
              onChange={(e) => setName(e.target.value.toLowerCase())}
              placeholder="malá písmena a pomlčky, např. revize-elektro"
              pattern={NAME.source}
              readOnly={!!item}
              required
              className="field"
            />
          </Field>
          <Field label="Kdy ji použít">
            <input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="jedna věta" required className="field" />
          </Field>
          <Field label="Postup">
            <textarea value={instructions} onChange={(e) => setInstructions(e.target.value)} placeholder="krok za krokem" required rows={16} className="field text-sm" />
          </Field>
          <div className="flex items-center gap-4">
            <button disabled={busy} className="btn-primary">
              {busy ? "Ukládám…" : !item ? "Přidat" : own ? "Uložit" : "Uložit kopii"}
            </button>
            {own && (
              <button
                type="button"
                disabled={busy}
                onClick={() => attempt(setBusy, setError, async () => (await api.deleteSkill(item.name, item.source as Scope), onDeleted()))}
                className="btn-danger text-sm"
              >
                Smazat
              </button>
            )}
          </div>
        </form>
      )}
      <ErrorNotice error={error} />
    </div>
  );
}
