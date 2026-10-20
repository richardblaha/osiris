import type { AssistantProfile, AssistantProfiles, Scope } from "@osiris/shared";
import { useEffect, useState, type FormEvent } from "react";
import { api } from "./api.ts";
import { attempt, ErrorNotice, Field } from "./Scope.tsx";

/**
 * The assistant's persona and rules at one level (the tenant's or the user's own), with what applies from the levels
 * above. A persona is written by the model from a character and the work it comes from, then edited before saving.
 */
export function AssistantSettings({ scope, editable }: { scope: Scope | "public"; editable: boolean }) {
  const [all, setAll] = useState<AssistantProfiles>();
  const [error, setError] = useState<string>();
  useEffect(() => void api.assistant().then(setAll, (e: Error) => setError(e.message)), []);
  if (!all) return <ErrorNotice error={error} />;
  const own = (scope === "public" ? all.public : scope === "tenant" ? all.tenant : all.personal) ?? { persona: null, guards: "" };
  return (
    <ProfileForm
      key={scope}
      scope={scope}
      profile={own}
      editable={editable}
      inherited={all}
      onSaved={(p) => setAll({ ...all, [scope]: p })}
    />
  );
}

function ProfileForm({
  scope,
  profile,
  editable,
  inherited,
  onSaved,
}: {
  scope: Scope | "public";
  profile: AssistantProfile;
  editable: boolean;
  inherited: AssistantProfiles;
  onSaved: (p: AssistantProfile) => void;
}) {
  const [character, setCharacter] = useState(profile.persona?.character ?? "");
  const [source, setSource] = useState(profile.persona?.source ?? "");
  const [description, setDescription] = useState(profile.persona?.description ?? "");
  const [guards, setGuards] = useState(profile.guards);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const generate = () =>
    attempt(setBusy, setError, async () => setDescription((await api.generatePersona(character, source)).description));
  const submit = (e: FormEvent) => {
    e.preventDefault();
    setSaved(false);
    const next: AssistantProfile = { persona: description.trim() ? { character: character.trim() || "Vlastní", source: source.trim(), description } : null, guards };
    void attempt(setBusy, setError, async () => {
      onSaved(await api.saveAssistant(scope, next));
      setSaved(true);
    });
  };

  const above = [
    ["Pravidla systému", inherited.system.guards],
    ...(scope !== "tenant" ? [["Pravidla firmy", inherited.tenant.guards]] : []),
  ].filter(([, text]) => text!.trim());
  const tenantPersona = scope === "personal" ? inherited.tenant.persona : null;

  return (
    <form onSubmit={submit} className="mt-4 space-y-4">
      <div>
        <span className="section-header block">Persona</span>
        <p className="mt-1 text-xs text-fg-muted">
          Jak má asistent komunikovat. Zadej postavu a knihu nebo film, asistent z nich připraví popis, který můžeš upravit.
          {tenantPersona && ` Bez vlastní persony platí firemní: ${tenantPersona.character}.`}
          {scope === "tenant" && " Uživatelé si ji mohou přepsat vlastní."}
          {scope === "public" && " Platí jen pro asistenta, se kterým mluví zákazníci."}
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

      {scope !== "personal" && (
      <div>
        <span className="section-header block">Pravidla (guardy)</span>
        <p className="mt-1 text-xs text-fg-muted">
          Co asistent musí nebo nesmí, jedno pravidlo na řádek. Mají přednost před personou i pokyny a každá zpráva i odpověď se proti nim kontroluje.
        </p>
        {above.map(([title, text]) => (
          <div key={title} className="notice mt-2 px-3 py-2 text-xs">
            <span className="font-medium">{title}</span> (platí vždy)
            <p className="mt-1 whitespace-pre-wrap text-fg-secondary">{text}</p>
          </div>
        ))}
        <textarea
          value={guards}
          onChange={(e) => setGuards(e.target.value)}
          placeholder={"např.\nNeslibuj termíny dřív než za tři pracovní dny.\nNikdy neuváděj ceny bez DPH."}
          maxLength={4000}
          rows={4}
          disabled={!editable}
          className="field mt-2"
        />
      </div>
      )}

      <ErrorNotice error={error} />
      {editable && (
        <div className="flex items-center gap-3">
          <button disabled={busy} className="btn-primary">
            {scope === "personal" ? "Uložit personu" : "Uložit personu a pravidla"}
          </button>
          {saved && <span className="text-sm text-success">Uloženo.</span>}
        </div>
      )}
    </form>
  );
}

/** The rules every tenant's assistant keeps to, above the tenants' and the users' own (system admins). */
export function SystemGuards() {
  const [guards, setGuards] = useState<string>();
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  useEffect(() => void api.admin.guards().then((g) => setGuards(g.guards), (e: Error) => setError(e.message)), []);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    setSaved(false);
    void attempt(setBusy, setError, async () => (await api.admin.saveGuards(guards ?? ""), setSaved(true)));
  };
  return (
    <form onSubmit={submit} className="detail space-y-4">
      <h1 className="text-lg font-semibold">Pravidla systému</h1>
      <p className="text-sm text-fg-secondary">
        Guardy pro asistenta ve všech tenantech, jedno pravidlo na řádek. Mají přednost před pravidly firem i uživatelů; každá zpráva i odpověď se proti nim kontroluje.
      </p>
      <textarea value={guards ?? ""} onChange={(e) => setGuards(e.target.value)} maxLength={4000} rows={10} disabled={guards === undefined} className="field" />
      <ErrorNotice error={error} />
      <div className="flex items-center gap-3">
        <button disabled={busy || guards === undefined} className="btn-primary">
          Uložit
        </button>
        {saved && <span className="text-sm text-success">Uloženo. Projeví se do půl minuty.</span>}
      </div>
    </form>
  );
}
