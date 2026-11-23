import { useState } from "react";
import { useSheet, type Writes } from "../hooks";
import type { Strip } from "../strip";
import { leftoverPlan } from "../writes";
import { Link } from "./Shell";
import { WriteLine } from "./WriteLine";

export function NeedsStrip({ strip, writes, online, go }: { strip: Strip; writes: Writes; online: boolean; go: (href: string) => void }) {
  const sheet = useSheet();
  const [all, setAll] = useState(false);
  const shown = all ? strip.cards : strip.cards.slice(0, 3);
  return (
    <section className="strip" aria-label="Needs you">
      <ul>
        {shown.map((c) => {
          const key = `strip:${c.key}`;
          const a = c.action;
          return (
            <li key={c.key} className="needs">
              <p>{c.text}</p>
              {a.kind === "leftover" ? (
                <>
                  <button type="button" className="btn" disabled={!online || writes.status(key)?.state === "pending"} onClick={() => void writes.run(key, leftoverPlan(a.componentId))}>
                    {a.label}
                  </button>
                  <WriteLine writes={writes} id={key} online={online} />
                </>
              ) : a.kind === "reading" ? (
                <button type="button" className="btn" onClick={(e) => sheet.open({ tab: "reading", metric: a.metric, ...(a.bodyState ? { bodyState: a.bodyState } : {}) }, e.currentTarget)}>
                  {a.label}
                </button>
              ) : a.href.startsWith("#") ? (
                <a className="btn" href={a.href}>
                  {a.label}
                </a>
              ) : (
                <Link className="btn" href={a.href} go={go}>
                  {a.label}
                </Link>
              )}
            </li>
          );
        })}
      </ul>
      {strip.hidden > 0 && !all ? (
        <button type="button" className="btn" onClick={() => setAll(true)}>
          +{strip.hidden} more
        </button>
      ) : null}
    </section>
  );
}
