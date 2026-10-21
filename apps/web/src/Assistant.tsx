import type { AssistantProfile, AssistantProfiles, Scope } from "@osiris/shared";
import { useEffect, useState, type FormEvent } from "react";
import { api } from "./api.ts";
import { attempt, ErrorNotice, Field, Pending } from "./Scope.tsx";

/**
 * The assistant's persona at one level (the tenant's, the user's own or a public assistant's). A persona is written
 * by the model from a character and the work it comes from, then edited before saving. Rules are guards (Guards.tsx).
 */
export function AssistantSettings({ scope, editable, assistant }: { scope: "personal" | "public"; editable: boolean; assistant?: string }) {
  const [all, setAll] = useState<AssistantProfiles>();
  const [error, setError] = useState<string>();
  useEffect(() => void api.assistant(assistant).then(setAll, (e: Error) => setError(e.message)), []);
  if (!all) return <Pending error={error} />;
  const own = (scope === "public" ? all.public : all.personal) ?? { persona: null };
  return (
    <ProfileForm
      key={scope}
      scope={scope}
      profile={own}
      editable={editable}
      inherited={all}
      assistant={assistant}
      onSaved={(p) => setAll({ ...all, [scope]: p })}
    />
  );
}

function ProfileForm({
  scope,
  profile,
  editable,
  inherited,
  assistant,
  onSaved,
}: {
  scope: Scope | "public";
  profile: AssistantProfile;
  editable: boolean;
  inherited: AssistantProfiles;
  assistant?: string;
  onSaved: (p: AssistantProfile) => void;
}) {
  const [character, setCharacter] = useState(profile.persona?.character ?? "");
  const [source, setSource] = useState(profile.persona?.source ?? "");
  const [description, setDescription] = useState(profile.persona?.description ?? "");
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const generate = () =>
    attempt(setBusy, setError, async () => setDescription((await api.generatePersona(character, source)).description));
  const submit = (e: FormEvent) => {
    e.preventDefault();
    setSaved(false);
    const next: AssistantProfile = { persona: description.trim() ? { character: character.trim() || "Vlastní", source: source.trim(), description } : null };
    void attempt(setBusy, setError, async () => {
      onSaved(await api.saveAssistant(scope, next, assistant));
      setSaved(true);
    });
  };

  return (
    <form onSubmit={submit} className="mt-4 space-y-4">
      <div>
        <span className="section-header block">Persona</span>
        <p className="mt-1 text-xs text-fg-muted">
          Jak má asistent komunikovat. Zadej postavu a knihu nebo film, asistent z nich připraví popis, který můžeš upravit.
          {scope === "public" && " Platí jen pro tohoto asistenta pro zákazníky."}
        </p>
        <div className="mt-2 flex flex-wrap items-end gap-3">
          <Field label="Postava">
            <input value={character} onChange={(e) => setCharacter(e.target.value)} placeholder="např. Sherlock Holmes" disabled={!editable} className="field w-56" />
          </Field>
          <Field label="Z knihy nebo filmu">
            <input value={source} onChange={(e) => setSource(e.target.value)} placeholder="např. Pes baskervillský" disabled={!editable} className="field w-64" />
          </Field>
          {editable && (
            <button type="button" disabled={busy || !character.trim()} onClick={() => void generate()} className="btn-secondary">
              {busy ? "Připravuji…" : "Nastavit"}
            </button>
          )}
        </div>
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Popis persony (vygeneruje se tlačítkem Nastavit, nebo ho napiš sám)"
          maxLength={2000}
          rows={5}
          disabled={!editable}
          className="field mt-2"
        />
      </div>

      <ErrorNotice error={error} />
      {editable && (
        <div className="flex items-center gap-3">
          <button disabled={busy} className="btn-primary">
            Uložit personu
          </button>
          {saved && <span className="text-sm text-success">Uloženo.</span>}
        </div>
      )}
    </form>
  );
}
