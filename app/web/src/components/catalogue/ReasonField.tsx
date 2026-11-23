/** The reason every catalogue write needs: empty until the member writes one, never pre-filled (desktop spec §5). */
export function ReasonField({ value, onChange, label = "Why?", disabled = false }: { value: string; onChange: (v: string) => void; label?: string; disabled?: boolean }) {
  return (
    <label className="field wide">
      <span>{label}</span>
      <input value={value} autoComplete="off" disabled={disabled} onChange={(e) => onChange(e.target.value)} />
    </label>
  );
}
