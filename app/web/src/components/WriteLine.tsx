import type { Writes } from "../hooks";

/** The write status next to the thing written: saving, saved, a question, or failed with what to do next. */
export function WriteLine({ writes, id, online }: { writes: Writes; id: string; online: boolean }) {
  const s = writes.status(id);
  return (
    <div className={`status ${s?.state ?? ""}`} role="status" aria-live="polite">
      {s ? (
        <>
          {s.message}
          {s.state === "failed" && writes.canRetry(id) ? (
            <>
              {" "}
              <button type="button" className="btn" onClick={() => void writes.retry(id)} disabled={!online}>
                Try again
              </button>
            </>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
