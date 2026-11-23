import type { ReactNode } from "react";
import { addDays } from "../dates";
import type { Loaded } from "../hooks";
import type { Pill, TabLink } from "../shell";
import type { Tab } from "../route";
import { Skeleton, StateScreen } from "./Parts";

type Go = (href: string) => void;

/** An in-app link: a real href (so it can be opened or copied) that navigates without a reload. `row` marks it as a list row for J and K. */
export function Link({ href, go, children, className, current, row }: { href: string; go: Go; children: ReactNode; className?: string; current?: boolean; row?: boolean }) {
  return (
    <a
      href={href}
      className={className}
      aria-current={current ? "page" : undefined}
      data-row={row ? "" : undefined}
      onClick={(e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
        e.preventDefault();
        go(href);
      }}
    >
      {children}
    </a>
  );
}

export function MemberBar({ pills, go }: { pills: Pill[]; go: Go }) {
  return (
    <nav className="memberbar" aria-label="Whose view">
      {pills.map((p) => (
        <Link key={p.name} href={p.href} go={go} className="pill" current={p.selected}>
          {p.name}
          {p.isMe ? <span className="visually-hidden"> (you)</span> : null}
        </Link>
      ))}
    </nav>
  );
}

/** One stroke set, 24 px grid, 1.75 px strokes in currentColor. */
const ICONS: Record<Tab, ReactNode> = {
  today: <path d="M4 9h16M7 4v3m10-3v3M5 6h14v14H5z" />,
  train: <path d="M3 12h18M6 8v8M3 10v4m15-6v8m3-6v4" />,
  progress: <path d="M4 19h16M5 16l4-5 4 3 6-8" />,
  household: <path d="M4 11l8-6 8 6M6 10v9h12v-9M10 19v-5h4v5" />,
};

export function TabBar({ tabs, go }: { tabs: TabLink[]; go: Go }) {
  return (
    <nav className="tabbar" aria-label="Sections">
      {tabs.map((t) => (
        <Link key={t.tab} href={t.href} go={go} current={t.active}>
          <svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
            {ICONS[t.tab]}
          </svg>
          <span>{t.label}</span>
        </Link>
      ))}
    </nav>
  );
}

/** Previous and next day, and a date picker. Never past `today` (the household's, from whoami). */
export function DayNav({ date, today, onDate }: { date: string; today: string; onDate: (date: string) => void }) {
  return (
    <div className="daynav" role="group" aria-label="Day">
      <button type="button" className="btn" onClick={() => onDate(addDays(date, -1))} aria-label="Previous day">
        ‹
      </button>
      <label>
        <span className="visually-hidden">Pick a day</span>
        <input type="date" value={date} max={today} onChange={(e) => e.target.value && onDate(e.target.value)} />
      </label>
      <button type="button" className="btn" onClick={() => onDate(addDays(date, 1))} disabled={date >= today} aria-label="Next day">
        ›
      </button>
    </div>
  );
}

/** The whole-screen states every screen shares: loading, signed out, offline, failed. */
export function LoadState({ state, what, retry }: { state: Exclude<Loaded<unknown>, { kind: "ready" }>; what: string; retry: () => void }) {
  if (state.kind === "loading") return <Skeleton />;
  if (state.kind === "signed_out") {
    return (
      <StateScreen title="Sign in again" action={{ label: "Sign in again", onClick: () => location.reload() }}>
        <p>Your sign-in has expired, or this account isn't one of the household's members. Signing in again opens the household's sign-in page.</p>
      </StateScreen>
    );
  }
  if (state.kind === "offline") {
    return (
      <StateScreen title="You're offline" action={{ label: "Try again", onClick: retry }}>
        <p>{what} needs a connection to load. It loads by itself when the phone is back online.</p>
      </StateScreen>
    );
  }
  return (
    <StateScreen title={`${what} didn't load`} action={{ label: "Try again", onClick: retry }}>
      <p className="error-text">{state.message}</p>
      <p>If it keeps failing, the API may be down; the agent can still log in chat.</p>
    </StateScreen>
  );
}
