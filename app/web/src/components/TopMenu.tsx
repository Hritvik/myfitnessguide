import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { FEEDBACK_TYPES, feedbackContext, feedbackPlan, type FeedbackType } from "../feedback";
import { useWrites } from "../hooks";
import { isComposing, trapIndex } from "../keys";
import type { RouteMemory } from "../route";
import { topMenuLinks } from "../shell";
import { KEEP_ENTRY, SaveLine } from "./Sheet";

export function TopMenu({ date, go, memory, wide }: { date: string | null; go: (href: string) => void; memory: RouteMemory; wide: boolean }) {
  const [open, setOpen] = useState<"menu" | "feedback" | null>(null);
  const more = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  // An open menu takes focus on its first item (desktop spec §6).
  useEffect(() => {
    if (open === "menu") menu.current?.querySelector<HTMLElement>("[role=menuitem]")?.focus();
  }, [open]);
  // Closing the menu or the feedback sheet gives focus back to "More".
  const close = () => {
    setOpen(null);
    more.current?.focus();
  };
  const onMenuKey = (e: KeyboardEvent) => {
    if (isComposing(e.nativeEvent)) return;
    if (e.key === "Escape") {
      e.stopPropagation();
      close();
      return;
    }
    if (e.key !== "Tab" && e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const items = [...(menu.current?.querySelectorAll<HTMLElement>("[role=menuitem]") ?? [])];
    const at = items.findIndex((x) => x === document.activeElement);
    items[trapIndex(at, items.length, e.key === "ArrowUp" || (e.key === "Tab" && e.shiftKey))]?.focus();
  };
  return (
    <>
      <button ref={more} type="button" className="btn more" aria-haspopup="menu" aria-expanded={open === "menu"} onClick={() => setOpen(open === "menu" ? null : "menu")} onKeyDown={(e) => {
        // Esc on "More" itself (the menu opened by mouse, focus left here) closes it too.
        if (e.key !== "Escape" || open !== "menu" || isComposing(e.nativeEvent)) return;
        e.stopPropagation();
        setOpen(null);
      }}>More</button>
      {open === "menu" ? (
        <div ref={menu} className="menu" role="menu" onKeyDown={onMenuKey}>
          {topMenuLinks(memory).filter((l) => !(wide && l.label === "Catalogue")).map((l) => (
            <a
              key={l.label}
              role="menuitem"
              href={l.href}
              onClick={(e) => {
                if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
                e.preventDefault();
                setOpen(null);
                go(l.href);
              }}
            >
              {l.label}
            </a>
          ))}
          <button type="button" role="menuitem" onClick={() => setOpen("feedback")}>Send feedback</button>
        </div>
      ) : null}
      {open === "feedback" ? <FeedbackSheet date={date} onClose={close} /> : null}
    </>
  );
}

function SheetShell({ title, onClose, busy, children }: { title: string; onClose: () => void; busy: boolean; children: ReactNode }) {
  const ref = useRef<HTMLElement>(null);
  // Opened from the menu, focus moves into the sheet: to its text box, else its first control.
  useEffect(() => {
    (ref.current?.querySelector<HTMLElement>("textarea") ?? ref.current?.querySelector<HTMLElement>("input, select, button"))?.focus();
  }, []);
  return (
    <div className="sheet-scrim" role="presentation" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <section
        ref={ref}
        className="sheet"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onKeyDown={(e) => {
          // Esc closes it, except while the feedback is going through.
          if (e.key !== "Escape" || isComposing(e.nativeEvent)) return;
          e.stopPropagation();
          if (!busy) onClose();
        }}
      >
        <header className="sheet-head"><h2>{title}</h2><button type="button" className="btn" onClick={onClose}>Close</button></header>
        <div className="sheet-body">{children}</div>
      </section>
    </div>
  );
}

function FeedbackSheet({ date, onClose }: { date: string | null; onClose: () => void }) {
  const [type, setType] = useState<FeedbackType>("confusing");
  const [text, setText] = useState("");
  const write = useWrites(() => {}, KEEP_ENTRY).slot("feedback");
  // The plan (and its idempotency key) is made once per Send; "Try again" resends that same plan.
  const send = () => {
    const plan = feedbackPlan(type, text, feedbackContext({ path: location.pathname, search: location.search, date, version: __APP_VERSION__, width: innerWidth, now: new Date() }));
    if ("steps" in plan) void write.run(plan, (o) => o.status.state === "saved" && setText(""));
  };
  return (
    <SheetShell title="Send feedback" onClose={onClose} busy={write.busy}>
      <div className="chips" role="group" aria-label="Kind">
        {FEEDBACK_TYPES.map((t) => <button key={t.type} type="button" className="chip" aria-pressed={type === t.type} onClick={() => setType(t.type)}>{t.label}</button>)}
      </div>
      <label className="field wide"><span>What happened, or what you'd like</span><textarea rows={4} value={text} onChange={(e) => setText(e.target.value)} /></label>
      <p className="hint">The screen you're on, the day, the app version and the time go with it. No screenshot.</p>
      <button type="button" className="btn primary" disabled={!text.trim() || write.busy} onClick={send}>Send</button>
      <SaveLine write={write} online={true} />
    </SheetShell>
  );
}
