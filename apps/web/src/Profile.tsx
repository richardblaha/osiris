import type { MeResponse, UserSettings } from "@osiris/shared";
import { useEffect, useState, type FormEvent } from "react";
import { api } from "./api.ts";

export function Profile({ me }: { me: MeResponse }) {
  const [settings, setSettings] = useState<UserSettings>();
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => void api.settings().then(setSettings, (e: Error) => setError(e.message)), []);

  const set = <K extends keyof UserSettings>(key: K, value: UserSettings[K]) => {
    setSaved(false);
    setSettings((s) => s && { ...s, [key]: value });
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!settings) return;
    setBusy(true);
    setError(undefined);
    try {
      setSettings(await api.saveSettings(settings));
      setSaved(true);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto h-full max-w-3xl overflow-y-auto p-6">
      <h1 className="section-header text-[13px]">Můj profil</h1>
      <p className="mt-1 text-sm text-fg-secondary">Jak s tebou má asistent jednat. Platí jen pro tebe.</p>

      <dl className="notice mt-6 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 px-3 py-2 text-sm">
        <dt className="text-fg-secondary">Jméno</dt>
        <dd>{me.user.name ?? "—"}</dd>
        <dt className="text-fg-secondary">E-mail</dt>
        <dd>{me.user.email ?? "—"}</dd>
        <dt className="text-fg-secondary">Telefon</dt>
        <dd>{me.user.phone ?? "—"}</dd>
      </dl>
      <p className="mt-1 text-xs text-fg-muted">Jméno, e-mail a telefon se mění v účtu na auth.k6labs.cz.</p>

      {settings && (
        <form onSubmit={submit} className="mt-6 space-y-4">
          <div className="flex flex-wrap gap-6">
            <label className="space-y-1">
              <span className="section-header block">Oslovení</span>
              <select value={settings.address} onChange={(e) => set("address", e.target.value as UserSettings["address"])} className="field w-auto">
                <option value="auto">podle mě</option>
                <option value="ty">tykání</option>
                <option value="vy">vykání</option>
              </select>
            </label>
            <label className="space-y-1">
              <span className="section-header block">Jazyk odpovědí</span>
              <select value={settings.language} onChange={(e) => set("language", e.target.value as UserSettings["language"])} className="field w-auto">
                <option value="auto">podle mě</option>
                <option value="cs">čeština</option>
                <option value="sk">slovenčina</option>
              </select>
            </label>
          </div>
          <label className="block space-y-1">
            <span className="section-header block">Podpis</span>
            <textarea
              value={settings.signature}
              onChange={(e) => set("signature", e.target.value)}
              placeholder={"Do e-mailů, nabídek a dalších textů psaných tvým jménem, např.\nJan Novák, elektro Novák, 777 123 456"}
              maxLength={1000}
              rows={3}
              className="field"
            />
          </label>
          <label className="block space-y-1">
            <span className="section-header block">Vlastní pokyny pro asistenta</span>
            <textarea
              value={settings.instructions}
              onChange={(e) => set("instructions", e.target.value)}
              placeholder="Např. Ceny uváděj vždy s DPH. Termíny navrhuj jen ve všední dny."
              maxLength={4000}
              rows={5}
              className="field"
            />
          </label>
          <div className="flex items-center gap-3">
            <button disabled={busy} className="btn-primary">
              {busy ? "Ukládám…" : "Uložit"}
            </button>
            {saved && <span className="text-sm text-success">Uloženo.</span>}
          </div>
        </form>
      )}
      {error && <p className="notice notice-error mt-3 px-3 py-2 text-sm">{error}</p>}
    </div>
  );
}
