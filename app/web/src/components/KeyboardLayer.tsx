import { useEffect, useRef, useState } from "react";
import { useSheet } from "../hooks";
import { chordAlive, escapeStep, isComposing, isTyping, KEY_HELP, keyAction, nextRow, trapIndex, waitsBehind, type Cover } from "../keys";
import type { Section } from "../route";

/** The "+" sheet's panel (not the list of keys or the feedback sheet, which share its class). */
const ADD_SHEET = 'section.sheet[aria-label="Add"]';

/** Any open modal dialog or menu but the "+" sheet covers the screen; the phone's modal "+" sheet does too. */
function cover(): Cover {
  if (document.querySelector(`[aria-modal="true"]:not(${ADD_SHEET}), [role="menu"]`)) return "other";
  return document.querySelector(`${ADD_SHEET}[aria-modal="true"]`) ? "sheet" : "none";
}

/**
 * The keyboard on both layouts (desktop spec §6): one document listener,
 * inside SheetHost so it can open and close the sheet. Rows, the search,
 * Edit and Cancel are found by their data attributes in the screen
 * (`main`), so every screen takes part by marking them. While something
 * covers the screen (the phone's modal sheet, the feedback sheet, the More
 * menu, the list of keys), the screen's keys wait (see waitsBehind).
 */
export function KeyboardLayer({ hrefs, go }: { hrefs: Record<Section, string>; go: (href: string) => void }) {
  const sheet = useSheet();
  const [help, setHelp] = useState(false);
  // A pressed G and when: the chord is dropped after CHORD_MS, on a click or tap, and when the window loses focus.
  const pending = useRef<{ key: "g"; at: number } | null>(null);
  const latest = useRef({ sheet, hrefs, go, help });
  latest.current = { sheet, hrefs, go, help };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target instanceof HTMLElement ? e.target : null;
      const waiting = pending.current && chordAlive(pending.current.at, Date.now()) ? "g" : null;
      const { action, pending: next } = keyAction({ key: e.key, shift: e.shiftKey, ctrl: e.ctrlKey, meta: e.metaKey, alt: e.altKey, typing: isTyping(t), composing: isComposing(e) }, waiting);
      pending.current = next ? { key: next, at: Date.now() } : null;
      if (!action) return;
      const now = latest.current;
      // The list of keys is a dialog: only Esc (and "?") act while it is open.
      if (now.help && action.kind !== "escape" && action.kind !== "help") return;
      if (waitsBehind(action.kind, cover())) return;
      switch (action.kind) {
        case "open-sheet":
          e.preventDefault();
          now.sheet.open({ tab: action.tab });
          return;
        case "focus-search": {
          const el = now.sheet.isOpen ? document.querySelector<HTMLElement>(`${ADD_SHEET} [data-search]`) : document.querySelector<HTMLElement>("main [data-search]");
          if (!el) return;
          e.preventDefault();
          el.focus();
          return;
        }
        case "row": {
          const rows = [...document.querySelectorAll<HTMLElement>("main [data-row]")];
          const active = document.activeElement;
          const at = rows.findIndex((r) => r === active || r.contains(active));
          const to = nextRow(at, rows.length, action.dir);
          if (to < 0) return;
          e.preventDefault();
          rows[to]?.focus();
          rows[to]?.scrollIntoView?.({ block: "nearest" });
          return;
        }
        case "edit": {
          const button = document.querySelector<HTMLButtonElement>("main [data-edit]");
          if (!button || button.disabled) return;
          e.preventDefault();
          button.click();
          return;
        }
        case "escape": {
          const cancel = document.querySelector<HTMLButtonElement>("main [data-cancel]");
          const step = escapeStep({
            help: now.help,
            sheet: !now.sheet.isOpen ? "closed" : now.sheet.busy() ? "busy" : "open",
            edit: !cancel ? "none" : cancel.disabled ? "busy" : "open",
            search: document.activeElement instanceof HTMLElement && document.activeElement.matches("main [data-search]"),
          });
          if (step === "close-help") setHelp(false);
          else if (step === "close-sheet") now.sheet.close();
          else if (step === "cancel-edit") cancel?.click();
          else if (step === "leave-search") (document.activeElement as HTMLElement).blur();
          return;
        }
        case "go":
          e.preventDefault();
          now.go(now.hrefs[action.section]);
          return;
        case "help":
          e.preventDefault();
          setHelp(true);
          return;
      }
    };
    const drop = () => {
      pending.current = null;
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", drop, true);
    addEventListener("blur", drop);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", drop, true);
      removeEventListener("blur", drop);
    };
  }, []);
  return help ? <KeyHelp onClose={() => setHelp(false)} /> : null;
}

/** The list of keys: a dialog that takes focus and gives it back to where it was. */
function KeyHelp({ onClose }: { onClose: () => void }) {
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    const back = document.activeElement;
    ref.current?.focus();
    return () => {
      if (back instanceof HTMLElement && back.isConnected) back.focus();
    };
  }, []);
  return (
    <div className="sheet-scrim" role="presentation" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <section
        ref={ref}
        tabIndex={-1}
        className="sheet keyhelp"
        role="dialog"
        aria-modal="true"
        aria-label="Keyboard shortcuts"
        onKeyDown={(e) => {
          if (isComposing(e.nativeEvent)) return;
          if (e.key === "Tab") {
            // Tab stays inside the list (its only control is Close).
            e.preventDefault();
            const items = [...(ref.current?.querySelectorAll<HTMLElement>("button, [href], input, select, textarea") ?? [])];
            items[trapIndex(items.indexOf(document.activeElement as HTMLElement), items.length, e.shiftKey)]?.focus();
            return;
          }
          if (e.key !== "Escape") return;
          e.stopPropagation();
          onClose();
        }}
      >
        <header className="sheet-head">
          <h2>Keyboard shortcuts</h2>
          <button type="button" className="btn" onClick={onClose}>
            Close
          </button>
        </header>
        <table className="wide-table">
          <tbody>
            {KEY_HELP.map((k) => (
              <tr key={k.keys}>
                <th scope="row">
                  <kbd>{k.keys}</kbd>
                </th>
                <td>{k.does}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="leftnote">Keys do nothing while you type in a field, except Esc.</p>
      </section>
    </div>
  );
}
