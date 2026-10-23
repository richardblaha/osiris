import type { Scope, SkillSummary } from "@osiris/shared";
import { useEffect, useState, type FormEvent } from "react";
import { api } from "./api.ts";
import { LazyCodeEditor } from "./LazyCodeEditor.tsx";
import { attempt, canEdit, DetailHeader, ErrorNotice, Field, OwnCopy, ScopeChoice, type DetailProps, Pending } from "./Scope.tsx";
import { t } from "i18next";
import { compareText } from "./i18n.ts";

const NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export const skillKey = (s: Pick<SkillSummary, "source" | "name">) => `${s.source}:${s.name}`;

/** Every layer's skills the viewer sees: bundled, the tenant's and their own (the ones replaced marked `overridden`). */
export async function loadSkills(): Promise<SkillSummary[]> {
  return (await api.skills()).sort((a, b) => compareText(a.name, b.name));
}

const intro = () => t("skills:intro");

/**
 * A skill of one layer. Admins change the tenant's; everyone their own. A skill the viewer may not change can be
 * copied: an admin copies a bundled one to the tenant, anyone else to themselves, and the copy then replaces it.
 */
export function SkillDetail({ item, scope: initial, isAdmin, onSaved, onDeleted }: DetailProps<SkillSummary>) {
  const [name, setName] = useState(item?.name ?? "");
  const [description, setDescription] = useState(item?.description ?? "");
  const [instructions, setInstructions] = useState("");
  const [target, setTarget] = useState<Scope>(initial);
  const own = !!item && item.source !== "bundled" && canEdit(item.source, isAdmin);
  const copyTo: Scope = isAdmin && item?.source === "bundled" ? "tenant" : "personal";
  const [copying, setCopying] = useState(false);
  const editable = !item || own || copying;
  const scope: Scope = !item ? target : own ? (item.source as Scope) : copyTo;
  const [loaded, setLoaded] = useState(!item);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (!item) return;
    api.skill(item.name, item.source).then((s) => {
      setInstructions(s.instructions);
      setLoaded(true);
    }, (e: Error) => setError(e.message));
  }, []);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!instructions.trim()) return setError(t("skills:instructionsRequired"));
    void attempt(setBusy, setError, async () => {
      await api.saveSkill(name, description, instructions, scope);
      onSaved(skillKey({ source: scope, name }));
    });
  };

  return (
    <div className="detail">
      <DetailHeader title={item?.name ?? t("skills:new")} scope={item ? (item.source === "bundled" ? undefined : item.source) : target} canEdit={own} overridden={item?.overridden}>
        {item?.source === "bundled" ? t("skills:bundled") : intro()}
      </DetailHeader>
      {!loaded && <Pending error={error} />}
      {loaded && (
        <form onSubmit={submit} className="mt-6 space-y-4">
          {!item && <ScopeChoice value={target} onChange={setTarget} isAdmin={isAdmin} />}
          <Field label={t("name")}>
            <input
              value={name}
              onChange={(e) => setName(e.target.value.toLowerCase())}
              placeholder={t("skills:namePlaceholder")}
              pattern={NAME.source}
              readOnly={!!item}
              required
              className="field"
            />
          </Field>
          <Field label={t("skills:when")}>
            <input value={description} onChange={(e) => setDescription(e.target.value)} placeholder={t("skills:whenPlaceholder")} required readOnly={!editable} className="field" />
          </Field>
          <div className="space-y-1">
            <span className="section-header block">{t("skills:instructions", { path: `skills/${name || "…"}/SKILL.md` })}</span>
            <LazyCodeEditor path="SKILL.md" value={instructions} readOnly={!editable} onChange={setInstructions} height="50vh" />
          </div>
          {editable ? (
            <div className="flex items-center gap-4">
              <button disabled={busy} className="btn-primary">
                {busy ? t("saving") : !item ? t("add") : own ? t("save") : t("skills:saveCopy")}
              </button>
              {own && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => attempt(setBusy, setError, async () => (await api.deleteSkill(item.name, item.source as Scope), onDeleted()))}
                  className="btn-danger text-sm"
                >
                  {t("delete")}
                </button>
              )}
            </div>
          ) : (
            !item?.overridden && <OwnCopy busy={busy} onClick={() => setCopying(true)} />
          )}
        </form>
      )}
      <ErrorNotice error={error} />
    </div>
  );
}
