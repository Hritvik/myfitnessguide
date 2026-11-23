import type { ReactNode } from "react";
import type { Pill, Sidebar } from "../shell";
import { Link, MemberBar } from "./Shell";

/**
 * The wide layout's sidebar (desktop spec §2): the top menu at the top,
 * the four sections, the catalogue's five panes, and the member pills at
 * the foot. The phone keeps its top bar and tab bar.
 */
export function DesktopShell({ sidebar, pills, go, menu }: { sidebar: Sidebar; pills: Pill[]; go: (href: string) => void; menu: ReactNode }) {
  return (
    <aside className="sidebar">
      <div className="sidebar-top">
        <b>Household</b>
        {menu}
      </div>
      <nav aria-label="Sections">
        {sidebar.main.map((l) => (
          <Link key={l.key} href={l.href} go={go} current={l.active}>
            {l.label}
          </Link>
        ))}
      </nav>
      <h2>Catalogue</h2>
      <nav aria-label="Catalogue">
        {sidebar.catalogue.map((l) => (
          <Link key={l.key} href={l.href} go={go} current={l.active}>
            {l.label}
          </Link>
        ))}
      </nav>
      <MemberBar pills={pills} go={go} />
      <p className="keyhint">
        <kbd>N</kbd> log · <kbd>/</kbd> search · <kbd>?</kbd> keys
      </p>
    </aside>
  );
}
