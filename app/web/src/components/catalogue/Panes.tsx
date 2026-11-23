import type { ReactNode } from "react";
import type { Loaded } from "../../hooks";
import { CATALOGUE, CATALOGUE_PARTS } from "../../layout";
import { cataloguePath, type CatalogueView } from "../../route";
import { CATALOGUE_LINKS, paneHome } from "../../shell";
import { Link } from "../Shell";
import { Split } from "../Split";

export type Go = (href: string) => void;

/**
 * A catalogue pane (desktop spec §2; wide-layout spec §5, Catalogue A): on a
 * wide screen the list then the record, through Split's catalogue layout
 * (Words keeps two columns); on the phone one at a time, the five panes as pills at
 * the top, and a record with a back link to its list.
 */
export function Panes({ wide, pane, go, list, record, back }: { wide: boolean; pane: CatalogueView["pane"]; go: Go; list: ReactNode; record: ReactNode | null; back: string }) {
  if (wide) {
    return (
      <main className="screen catalogue">
        <Split
          wide
          specs={CATALOGUE_PARTS}
          layout={CATALOGUE}
          className={pane === "words" ? "words-cols" : undefined}
          nodes={{ list, record: record ?? <p className="leftnote">Pick one from the list.</p> }}
        />
      </main>
    );
  }
  return (
    <main className="screen catalogue">
      <nav className="memberbar catalogue-nav" aria-label="Catalogue">
        {CATALOGUE_LINKS.map((c) => (
          <Link key={c.pane} className="pill" href={cataloguePath(paneHome(c.pane))} go={go} current={c.pane === pane}>
            {c.label}
          </Link>
        ))}
      </nav>
      {record ? (
        <>
          <Link className="back" href={cataloguePath(paneHome(pane))} go={go}>
            ‹ {back}
          </Link>
          {record}
        </>
      ) : (
        list
      )}
    </main>
  );
}

/** A record that isn't ready: loading, offline, signed out or failed, in a line, inside the pane. */
export function RecordState({ state, what, retry }: { state: Exclude<Loaded<unknown>, { kind: "ready" }>; what: string; retry: () => void }) {
  if (state.kind === "loading") return <p className="leftnote">Loading…</p>;
  if (state.kind === "signed_out") return <p className="leftnote">Your sign-in has expired. Reload the page to sign in again.</p>;
  return (
    <p className="leftnote">
      {state.kind === "offline" ? `${what} needs a connection.` : `${what} didn't load.`}{" "}
      <button type="button" className="btn" onClick={retry}>
        Try again
      </button>
    </p>
  );
}
