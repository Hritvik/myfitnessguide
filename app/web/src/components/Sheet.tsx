import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { day, slotLabel } from "../format";
import { HeldContext, InFlightContext, SavedContext, SheetContext, useLoad, useOnline, useUnsavedGuard, type WriteSlot } from "../hooks";
import { callTool } from "../api";
import { closedDayNotice } from "../dayClose";
import type { DayMeals } from "../types";
import { isComposing } from "../keys";
import type { Who } from "../load";
import { FoodTab } from "./sheet/FoodTab";
import { ReadingTab } from "./sheet/ReadingTab";
import { SetTab } from "./sheet/SetTab";
import { TextTab } from "./sheet/TextTab";
import { WorkoutTab } from "./sheet/WorkoutTab";
import { questionChoices, type Choice } from "../writes";
import { draftNotice, forChips, forDate, forMember, MEAL_SLOTS, fabHidden, openSheet, ownOnlyNotice, pickOpener, reopenSheet, returnTarget, SHEET_TABS, sheetPlacement, switchTab, type SheetState, type SheetTarget } from "../sheet";

/** Mounts the floating "+" and the sheet over every tab, and tells screens when a Save landed. */
export function SheetHost({ who, date, wide, children }: { who: Who; date: string | null; wide: boolean; children: ReactNode }) {
  const [state, setState] = useState<SheetState | null>(null);
  const [saved, setSaved] = useState(0);
  // What opened the sheet, so closing it gives focus back there (desktop spec §6).
  const opener = useRef<HTMLElement | null>(null);
  const fab = useRef<HTMLButtonElement | null>(null);
  const isOpenRef = useRef(false);
  isOpenRef.current = state !== null;
  // Opened again while the panel is already open (a meal's "Add" beside it): focus goes back into the panel.
  const [again, setAgain] = useState(0);
  // Set by the open sheet: whether a save is going through or a send is held (Esc then leaves it open, and opening again keeps it).
  const guard = useRef<() => boolean>(() => false);
  const busy = useCallback(() => isOpenRef.current && guard.current(), []);
  const open = useCallback(
    (target: SheetTarget, from?: HTMLElement | null) => {
      const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      if (isOpenRef.current) setAgain((n) => n + 1);
      else opener.current = pickOpener(from, active, !!active?.closest(".sheet"), active === document.body);
      // A busy sheet (a held send or plan, a write in flight) keeps its tab and state: only focus goes back into it.
      const held = busy();
      setState((s) => reopenSheet(s, held, openSheet(who, { date }, target)));
    },
    [who, date, busy],
  );
  const close = useCallback(() => setState(null), []);
  // Focus goes back only when a sheet closes, never on the first render (the phone's "+" would load focused, ringed).
  const wasOpen = useRef(false);
  useEffect(() => {
    if (state !== null) {
      wasOpen.current = true;
      return;
    }
    if (!wasOpen.current) return;
    wasOpen.current = false;
    const back = returnTarget(opener.current, fab.current);
    opener.current = null;
    back?.focus();
  }, [state]);
  useEffect(() => {
    if (again > 0) focusCurrentTab(document.querySelector(".sheet"));
  }, [again]);
  const ctx = useMemo(() => ({ open, close, isOpen: state !== null, busy }), [open, close, state, busy]);
  return (
    <SheetContext.Provider value={ctx}>
      <SavedContext.Provider value={saved}>
        {children}
        <button ref={fab} type="button" hidden={fabHidden(wide, state !== null) || undefined} className={wide ? "fab wide" : "fab"} aria-label="Add food, a workout, a set, a reading or free text" onClick={(e) => open({ tab: "food" }, e.currentTarget)}>
          <svg viewBox="0 0 24 24" width="26" height="26" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <path d="M12 5v14M5 12h14" />
          </svg>
        </button>
        {state ? <SheetFrame who={who} state={state} setState={setState} wide={wide} onSaved={() => setSaved((n) => n + 1)} onClose={close} guard={guard} /> : null}
      </SavedContext.Provider>
    </SheetContext.Provider>
  );
}

export interface TabProps {
  who: Who;
  state: SheetState;
  setState: (s: SheetState) => void;
  onSaved: () => void;
  online: boolean;
  /** The Tell Claude box, kept in the sheet so leaving the tab keeps what was typed. */
  draft: string;
  setDraft: (text: string) => void;
  /** A send is held for "Try again": the tabs and the for/day/meal controls wait, so a resend is the same write. */
  holdSend: (held: boolean) => void;
}

export function SheetFrame({ who, state, setState, onSaved, onClose, wide, guard }: { who: Who; state: SheetState; setState: (s: SheetState) => void; onSaved: () => void; onClose: () => void; wide: boolean; guard?: { current: () => boolean } }) {
  const placement = sheetPlacement(wide);
  const ref = useRef<HTMLElement>(null);
  // Focus moves into the sheet when it opens, unless a tab already put it in its own field (Food's search).
  // It lands on the current tab rather than the section (no tabindex), so the phone's markup is unchanged.
  useEffect(() => {
    const el = ref.current;
    if (el && !el.contains(document.activeElement)) focusCurrentTab(el);
  }, []);
  const online = useOnline();
  const [draft, setDraft] = useState("");
  const [held, holdSend] = useState(false);
  // Writes started in the sheet and not yet answered, even if their tab has since been left.
  const [inFlight, setInFlight] = useState(0);
  const report = useCallback((d: 1 | -1) => setInFlight((n) => Math.max(0, n + d)), []);
  // Saves held for "Try again" in any form of the sheet (a failed food Save, a set, a reading).
  const [heldWrites, setHeldWrites] = useState(0);
  const reportHeld = useCallback((d: number) => setHeldWrites((n) => Math.max(0, n + d)), []);
  const notice = draftNotice(who, state);
  // Logging into a closed day says so (click test P2-12): the food and Tell Claude tabs, which log into a meal.
  const meals = state.tab === "food" || state.tab === "text";
  const dayRead = useLoad(
    () => (meals ? callTool<DayMeals>("day_meals", { member: state.forMember, date: state.date }) : Promise.resolve({ kind: "ok" as const, data: null })),
    `sheet-day|${meals ? `${state.forMember}|${state.date}` : "-"}`,
  );
  const closed = dayRead.state.kind === "ready" && dayRead.state.data ? closedDayNotice(dayRead.state.data.day_status, state.date, state.forMember, who.member) : null;
  const privateNote = ownOnlyNotice(state);
  const props: TabProps = { who, state, setState, onSaved, online, draft, setDraft, holdSend };
  // Esc never throws away a save going through (on any tab, the one left included) or a send held for Try again.
  const busy = () => held || inFlight > 0 || heldWrites > 0;
  // A reload with text typed for Claude, or a Save going through or held, asks first.
  useUnsavedGuard(draft.trim() !== "" || held || inFlight > 0 || heldWrites > 0);
  if (guard) guard.current = busy;
  return (
    <div className={placement.scrim} role="presentation" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <section
        ref={ref}
        className="sheet"
        role="dialog"
        aria-modal={placement.modal}
        aria-label="Add"
        onKeyDown={(e) => {
          if (e.key !== "Escape" || isComposing(e.nativeEvent)) return;
          e.stopPropagation();
          if (!busy()) onClose();
        }}
      >
        <header className="sheet-head">
          <div className="sheet-tabs" role="tablist" aria-label="What to add">
            {SHEET_TABS.map((t) => (
              <button key={t.tab} type="button" role="tab" aria-selected={state.tab === t.tab} disabled={held && state.tab !== t.tab} onClick={() => setState(switchTab(who, state, t.tab))}>
                {t.label}
              </button>
            ))}
          </div>
          <button type="button" className="btn" onClick={onClose}>
            Close
          </button>
        </header>
        <div className="sheet-context">
          {privateNote ? (
            <p className="sheet-notice">{privateNote}</p>
          ) : (
            <div className="chips" role="group" aria-label="For">
              {forChips(who, state).map((c) => (
                <button key={c.name} type="button" className={`chip${c.you ? " you" : ""}`} aria-pressed={c.selected} disabled={held} onClick={() => setState(forMember(state, c.name))}>
                  {c.name}
                  {c.you ? <span className="visually-hidden"> (you)</span> : null}
                </button>
              ))}
            </div>
          )}
          <label className="field">
            <span>Day</span>
            <input type="date" disabled={held} value={state.date} max={who.today} onChange={(e) => e.target.value && setState(forDate(state, e.target.value))} />
          </label>
          {state.tab === "food" || state.tab === "text" ? (
            <label className="field">
              <span>Meal</span>
              <select disabled={held} value={state.slot} onChange={(e) => setState({ ...state, slot: e.target.value as SheetState["slot"] })}>
                {MEAL_SLOTS.map((s) => (
                  <option key={s} value={s}>
                    {slotLabel(s)}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          <p className="sheet-day">{day(state.date)}</p>
          {notice ? <p className="sheet-notice">{notice}</p> : null}
          {closed ? <p className="sheet-notice">{closed}</p> : null}
        </div>
        <div className="sheet-body">
          <InFlightContext.Provider value={report}>
            <HeldContext.Provider value={reportHeld}>
              <TabBody {...props} />
            </HeldContext.Provider>
          </InFlightContext.Provider>
        </div>
      </section>
    </div>
  );
}

function TabBody(props: TabProps) {
  switch (props.state.tab) {
    case "food":
      return <FoodTab {...props} />;
    case "workout":
      return <WorkoutTab {...props} />;
    case "set":
      return <SetTab {...props} />;
    case "reading":
      return <ReadingTab {...props} />;
    case "text":
      return <TextTab {...props} />;
  }
}

/** The sheet's sign-out handler for useWrites: keep the entry (spec §10); SaveLine offers "Sign in again". */
export const KEEP_ENTRY = () => {};

export { closeOnSaved } from "../writes";

/** A Save's status next to its button: saving, saved, a question, or failed with what to do next and "Try again". */
export function SaveLine({ write, online }: { write: WriteSlot; online: boolean }) {
  const s = write.status;
  return (
    <div className={`status ${s?.state ?? ""}`} role="status" aria-live="polite">
      {s ? s.message : null}
      {s?.state === "signed_out" ? " This entry stays here." : null}
      {write.canRetry ? (
        <>
          {" "}
          <button type="button" className="btn" onClick={() => void write.retry()} disabled={!online}>
            Try again
          </button>
        </>
      ) : null}
      {s?.state === "signed_out" ? (
        <>
          {" "}
          <a className="btn" href="/" target="_blank" rel="noreferrer">
            Sign in again
          </a>
        </>
      ) : null}
    </div>
  );
}

/** A preview line the Save has just asked as its question: shown once, by the Save (SaveLine), not twice. */
export const asked = (write: WriteSlot, line: string): boolean => write.status?.state === "question" && write.status.message === line;

/**
 * A question answered in one tap: its options as chips under it, each
 * sending the asked Save again with that answer at the question's path and
 * the same keys (writeBook's `answer`), so its after-save runs as the Save's
 * own would have. "Which gym are you at?" (ticket 63) and "Which cable?"
 * (click test P1-6) alike; `onAnswer` lets the form keep the answer for its
 * next Save.
 */
export function QuestionAnswer({ write, tool, online, current, onAnswer }: { write: WriteSlot; tool: string; online: boolean; current: Record<string, unknown> | null; onAnswer?: (c: Choice) => void }) {
  const asking = write.status?.state === "question";
  // Once the form no longer holds the entry that was asked about, the question is gone: an answer
  // would send the older entry (review round). The next Save asks afresh if it needs to.
  const stale = asking && !write.matches(tool, current);
  useEffect(() => {
    if (stale) write.clear();
    // Only a change of staleness clears; write is a new object each render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stale]);
  const choices = stale ? [] : questionChoices(write.status);
  if (choices.length === 0) return null;
  const gym = write.status?.state === "question" && write.status.reason === "gym_needed";
  return (
    <div className="chips" role="group" aria-label={gym ? "Which gym" : "Answers"}>
      {choices.map((c) => (
        <button key={c.label} type="button" className="chip" disabled={!online || write.busy} onClick={() => {
            onAnswer?.(c);
            void write.answer(tool, c.path, c.value, current);
          }}>
          {c.label}
        </button>
      ))}
    </div>
  );
}

/** Focus the selected tab (no tabindex on the section, so the phone's markup is unchanged). */
function focusCurrentTab(sheet: Element | null) {
  sheet?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')?.focus();
}
