import { useState, type FormEvent } from "react";
import { attempt, ErrorNotice } from "./Scope.tsx";

type Invite = { email: string; firstName: string; lastName: string; role: "admin" | "member" };

/** Adds a person by email: an existing PocketID user joins, a new one is created (and gets a sign-in link). */
export function InviteForm({ onInvite }: { onInvite: (body: Invite) => Promise<void> }) {
  const [form, setForm] = useState<Invite>({ email: "", firstName: "", lastName: "", role: "member" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const submit = (e: FormEvent) => {
    e.preventDefault();
    void attempt(setBusy, setError, async () => {
      await onInvite(form);
      setForm({ email: "", firstName: "", lastName: "", role: "member" });
    });
  };
  return (
    <form onSubmit={submit} className="mt-3 flex flex-wrap gap-2">
      <input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} placeholder="e-mail" required className="field min-w-0 flex-[2]" />
      <input value={form.firstName} onChange={(e) => setForm({ ...form, firstName: e.target.value })} placeholder="jméno" required className="field min-w-0 flex-1" />
      <input value={form.lastName} onChange={(e) => setForm({ ...form, lastName: e.target.value })} placeholder="příjmení" className="field min-w-0 flex-1" />
      <select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value as Invite["role"] })} className="field w-auto">
        <option value="member">uživatel</option>
        <option value="admin">správce</option>
      </select>
      <button disabled={busy} className="btn-primary">
        Pozvat
      </button>
      <ErrorNotice error={error} />
    </form>
  );
}
