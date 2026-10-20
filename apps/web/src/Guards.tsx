import { GUARD_NAME, type Guard, type Guards as GuardList } from "@osiris/shared";
import { useEffect, useState, type FormEvent } from "react";
import { api } from "./api.ts";
import { MasterDetail, type PanelGroup } from "./MasterDetail.tsx";
import { attempt, ErrorNotice, Field } from "./Scope.tsx";

type Level = "system" | "tenant" | "user" | "assistant";
interface Place {
  level: Level;
  assistant?: string;
}

const keyOf = (p: Place, name: string) => [p.level, p.assistant ?? "", name].join(":");
const LEVEL_LABEL: Record<Level, string> = { system: "Systém", tenant: "Firma", user: "Moje", assistant: "Asistent" };

/**
 * Guards by level: the system's (system admins), the tenant's and its public assistants' (tenant admins) and the
 * user's own. Each is a rule the assistant keeps to and every message and answer is checked against.
 */
export function Guards({ isAdmin, systemAdmin }: { isAdmin: boolean; systemAdmin: boolean }) {
  const [list, setList] = useState<GuardList>();
  const [selected, setSelected] = useState<string | null>();
  const [error, setError] = useState<string>();
  const load = () => api.guards().then(setList, (e: Error) => setError(e.message));
  useEffect(() => void load(), []);

  const places: { place: Place; title: string; guards: Guard[]; editable: boolean }[] = list
    ? [
        { place: { level: "system" }, title: "Systém (všichni tenanti)", guards: list.system, editable: systemAdmin },
        { place: { level: "tenant" }, title: "Firma", guards: list.tenant, editable: isAdmin },
        { place: { level: "user" }, title: "Moje", guards: list.user, editable: true },
        ...Object.entries(list.assistants ?? {}).map(([name, guards]) => ({
          place: { level: "assistant" as const, assistant: name },
          title: `Asistent ${name}`,
          guards,
          editable: isAdmin,
        })),
      ]
    : [];
  const groups: PanelGroup[] = places.map((p) => ({
    title: p.title,
    items: p.guards.map((g) => ({ key: keyOf(p.place, g.name), label: g.name, hint: g.description || g.rule })),
    empty: "Žádná.",
  }));
  const open = places.flatMap((p) => p.guards.map((g) => ({ ...p, guard: g }))).find((x) => keyOf(x.place, x.guard.name) === selected);
  const targets = places.filter((p) => p.editable);

  return (
    <MasterDetail
      title="Kontroly"
      top={<p className="px-2 text-xs text-fg-muted">Pravidla, která asistent musí dodržet. Každá zpráva i odpověď se proti nim kontroluje.</p>}
      groups={groups}
      selected={selected}
      onSelect={setSelected}
      add={{ label: "Přidat kontrolu", onClick: () => setSelected(null) }}
      placeholder="Vyber kontrolu vlevo."
    >
      {error ? (
        <div className="detail">
          <ErrorNotice error={error} />
        </div>
      ) : selected === null && list ? (
        <GuardForm key="new" targets={targets} systemAdmin={systemAdmin} onSaved={(p, name) => void load().then(() => setSelected(keyOf(p, name)))} />
      ) : open ? (
        <GuardForm
          key={selected}
          targets={[open]}
          guard={open.guard}
          editable={open.editable}
          systemAdmin={systemAdmin}
          onSaved={() => void load()}
          onDeleted={() => void load().then(() => setSelected(undefined))}
        />
      ) : undefined}
    </MasterDetail>
  );
}

const save = (p: Place, g: Guard) => (p.level === "system" ? api.admin.saveGuard(g) : api.saveGuard(p.level, g, p.assistant));
const remove = (p: Place, name: string) => (p.level === "system" ? api.admin.deleteGuard(name) : api.deleteGuard(p.level, name, p.assistant));

function GuardForm(props: {
  targets: { place: Place; title: string }[];
  guard?: Guard;
  editable?: boolean;
  systemAdmin: boolean;
  onSaved: (p: Place, name: string) => void;
  onDeleted?: () => void;
}) {
  const editable = props.editable ?? true;
  const [target, setTarget] = useState(0);
  const [name, setName] = useState(props.guard?.name ?? "");
  const [description, setDescription] = useState(props.guard?.description ?? "");
  const [rule, setRule] = useState(props.guard?.rule ?? "");
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const place = props.targets[target]?.place;
  if (!place) return <p className="detail text-sm text-fg-muted">Nemáš kam kontrolu přidat.</p>;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setSaved(false);
    void attempt(setBusy, setError, async () => {
      await save(place, { name, description, rule });
      setSaved(true);
      props.onSaved(place, name);
    });
  };
  const del = () =>
    window.confirm(`Smazat kontrolu ${name}?`) && void attempt(setBusy, setError, async () => (await remove(place, name), props.onDeleted?.()));

  return (
    <form onSubmit={submit} className="detail space-y-4">
      <h1 className="text-lg font-semibold">{props.guard ? props.guard.name : "Nová kontrola"}</h1>
      {props.guard ? (
        <p className="text-sm text-fg-secondary">
          {LEVEL_LABEL[place.level]}
          {place.assistant && ` ${place.assistant}`}
          {!editable && (place.level === "system" ? " · mění ho jen správce systému" : " · mění ho jen správce tenanta")}
        </p>
      ) : (
        <Field label="Pro koho platí">
          <select value={target} onChange={(e) => setTarget(Number(e.target.value))} className="field w-auto">
            {props.targets.map((t, i) => (
              <option key={t.title} value={i}>
                {t.title}
              </option>
            ))}
          </select>
        </Field>
      )}
      {!props.guard && (
        <Field label="Název (malá písmena, číslice, pomlčky)">
          <input
            value={name}
            onChange={(e) => setName(e.target.value.trim().toLowerCase())}
            required
            maxLength={60}
            pattern={GUARD_NAME.source}
            placeholder="např. bez-politiky"
            className="field"
          />
        </Field>
      )}
      <Field label="Popis">
        <input value={description} onChange={(e) => setDescription(e.target.value)} maxLength={300} disabled={!editable} className="field" />
      </Field>
      <Field label="Pravidlo">
        <textarea
          value={rule}
          onChange={(e) => setRule(e.target.value)}
          required
          maxLength={4000}
          rows={6}
          disabled={!editable}
          placeholder="např. Nemluv o politice ani o konkurenci."
          className="field"
        />
      </Field>
      <ErrorNotice error={error} />
      {editable && (
        <div className="flex items-center gap-3">
          <button disabled={busy} className="btn-primary">
            Uložit
          </button>
          {saved && <span className="text-sm text-success">Uloženo.{place.level === "system" && " Projeví se do půl minuty."}</span>}
          <span className="flex-1" />
          {props.guard && (
            <button type="button" disabled={busy} onClick={del} className="btn-danger text-sm">
              Smazat
            </button>
          )}
        </div>
      )}
    </form>
  );
}
