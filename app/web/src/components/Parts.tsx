import type { ReactNode } from "react";
import { Link } from "./Shell";
import type { FooterRow, MacroColumn, TodayView } from "../today";

export function LeftLine({ left, notes }: { left: TodayView["left"]; notes: TodayView["notes"] }) {
  return (
    <div className="left">
      <p className="leftline">{left.parts.map((p, i) => (p.strong ? <b key={i}>{p.text}</b> : <span key={i}>{p.text}</span>))}</p>
      {left.note ? <p className="leftnote">{left.note}</p> : null}
      {notes.map((t) => (
        <p key={t} className="leftnote">
          {t}
        </p>
      ))}
    </div>
  );
}

export function Macros({ macros }: { macros: MacroColumn[] }) {
  return (
    <ul className="macros" aria-label="Left of each target">
      {macros.map((m) => (
        <li key={m.key} className={`macro${m.over ? " over" : ""}`}>
          <span>{m.label}</span>
          <span className="amount">
            {m.over ? <small className="overby">over by </small> : null}
            {m.amount}
            {m.unit ? <small> {m.unit}</small> : null}
          </span>
          {m.fill !== null ? (
            <span className="track" aria-hidden="true">
              <span style={{ width: `${(m.fill * 100).toFixed(1)}%` }} />
            </span>
          ) : null}
          <span>{m.caption}</span>
          {m.note ? <span>{m.note}</span> : null}
        </li>
      ))}
    </ul>
  );
}

export function Footer({ rows, go }: { rows: FooterRow[]; go: (href: string) => void }) {
  if (rows.length === 0) return null;
  return (
    <dl className="foot" aria-label="Also today">
      {rows.map((r) => (
        <div key={`${r.label}|${r.value}`}>
          <dt>{r.label}</dt>
          <dd>
            <Link href={r.href} go={go}>
              {r.value}
            </Link>
          </dd>
        </div>
      ))}
    </dl>
  );
}

/** The loading state, in the shape of the screen it becomes. */
export function Skeleton() {
  return (
    <main className="screen" aria-busy="true">
      <p className="visually-hidden" role="status">
        Loading today
      </p>
      <div className="top" aria-hidden="true">
        <div className="sk sk-title" />
        <div className="who">
          <div className="sk sk-pill" />
          <div className="sk sk-pill" />
          <div className="sk sk-pill" />
        </div>
      </div>
      <div className="left" aria-hidden="true">
        <div className="sk sk-line" style={{ width: "92%" }} />
        <div className="sk sk-line" style={{ width: "60%" }} />
      </div>
      <div className="macros" aria-hidden="true">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="sk sk-macro" />
        ))}
      </div>
      <div className="sk-pot" aria-hidden="true" />
      <div className="tiers" aria-hidden="true">
        <div className="sk sk-tier" style={{ borderRadius: "16px 16px 12px 12px" }} />
        <div className="sk sk-tier" />
        <div className="sk sk-tier" />
      </div>
    </main>
  );
}

export function StateScreen({ title, children, action }: { title: string; children: ReactNode; action?: { label: string; onClick: () => void } }) {
  return (
    <main className="screen">
      <div className="state">
        <h1>{title}</h1>
        {children}
        {action ? (
          <button type="button" className="btn primary" onClick={action.onClick}>
            {action.label}
          </button>
        ) : null}
      </div>
    </main>
  );
}
