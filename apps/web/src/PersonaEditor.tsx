/** A single description field, usable as a prompt or edited directly. */
export function PersonaEditor({ value, onChange, onGenerate, busy, disabled = false }: {
  value: string;
  onChange: (value: string) => void;
  onGenerate: () => void;
  busy: boolean;
  disabled?: boolean;
}) {
  return (
    <div className="relative mt-2">
      <textarea
        aria-label="Popis persony"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Popiš, jak má asistent vystupovat, třeba stručně a s humorem jako Sherlock Holmes. Text můžeš upravit pomocí AI."
        maxLength={2000}
        rows={7}
        disabled={disabled || busy}
        className="field pb-14"
      />
      {!disabled && (
        <button type="button" disabled={busy || !value.trim()} onClick={onGenerate} className="btn-secondary absolute bottom-3 right-3 text-sm">
          {busy ? "Připravuji…" : "Upravit pomocí AI"}
        </button>
      )}
    </div>
  );
}
