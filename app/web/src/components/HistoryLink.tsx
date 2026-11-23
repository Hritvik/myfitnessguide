import { useRef, useState } from "react";
import { callTool } from "../api";
import { auditLines, type AuditLine } from "../history";
import type { HistoryVersion } from "../types";

/** A quiet "history" link that opens the record's audit trail in place. */
export function HistoryLink({ table, id, timeZone }: { table: string; id: number; timeZone: string }) {
  const [lines, setLines] = useState<AuditLine[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const loading = useRef(false);
  async function toggle() {
    if (open) return setOpen(false);
    setOpen(true);
    if (lines || loading.current) return;
    loading.current = true;
    setError(null);
    try {
      const out = await callTool<{ versions: HistoryVersion[] }>("history", { table, id });
      if (out.kind === "ok") setLines(auditLines(out.data.versions, timeZone));
      else setError(out.kind === "offline" ? "History needs a connection." : "History didn't load.");
    } finally {
      loading.current = false;
    }
  }
  return (
    <span className="history-link">
      <button type="button" className="link" aria-expanded={open} onClick={() => void toggle()}>
        history
      </button>
      {open ? (
        error ? (
          <span className="error-text">{error}</span>
        ) : lines ? (
          <ol className="audit">
            {lines.map((l, i) => (
              <li key={i}>
                <span className="when">{l.when}</span> {l.who} {l.what}
                {l.why ? <span className="why">: {l.why}</span> : null}
              </li>
            ))}
          </ol>
        ) : (
          <span role="status">Loading…</span>
        )
      ) : null}
    </span>
  );
}
