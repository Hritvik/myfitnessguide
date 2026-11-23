import { useEffect, useRef, useState, type ReactNode } from "react";
import { callTool } from "../api";
import { askedFor, foodCheck, oneAtATime } from "../food";
import { useUnsavedGuard, type Writes } from "../hooks";
import { slotLabel } from "../format";
import { editAmountCheck, editItemPlan, editReadingPlan, editSetPlan, optionUnit, removeItemPlan, removeReadingPlan, removeSetPlan, SET_LOAD_NOTE, switchItemMeasure, type ItemEditDraft, type ItemFix, type ReadingFix, type SetFix } from "../fixes";
import { MEAL_SLOTS } from "../sheet";
import { editCardioPlan, removeCardioPlan, type CardioFix } from "../train";
import { clearsOnLeave, closeOnSaved, confirmPlan, questionChoices, type Plan } from "../writes";
import type { RecentItems, RecordRef, WhatIf } from "../types";
import { WriteLine } from "./WriteLine";

type Open = "none" | "remove" | "edit";

/**
 * Edit and Remove on your own confirmed row (ticket 61): two quiet links
 * beside "history", Remove asking once, Edit an inline form. Each write is a
 * held plan under its own key (`fix:` remove, `fix-edit:` edit), so "Try
 * again" resends the same keys and its post-save step closes the form
 * (decision 74). A row that goes when its write lands takes its status with it.
 */
function Fixer({
  id, name, ask, writes, online, removePlan, editForm, answers = false,
}: {
  id: string;
  name: string;
  ask: string;
  writes: Writes;
  online: boolean;
  removePlan: () => Plan;
  /**
   * `close` after a Save lands; `leave` for Cancel, which also clears what the form's last Save said;
   * `report` gives the Fixer what the form would send now (its amend's input), for an answer chip.
   */
  editForm: (close: () => void, key: string, leave: () => void, report: (current: Record<string, unknown> | null) => void) => ReactNode;
  /** The Edit's question answered in one tap under it (an implausible reading's "Yes, it's right"). */
  answers?: boolean;
}) {
  const [open, setOpen] = useState<Open>("none");
  const removeKey = `fix:${id}`;
  const editKey = `fix-edit:${id}`;
  const busy = writes.status(removeKey)?.state === "pending" || writes.status(editKey)?.state === "pending";
  const held = writes.canRetry(removeKey) || writes.canRetry(editKey);
  // Moving on (Cancel, Keep, or opening Edit or Remove again) clears a status that has said its piece (click test P2-7).
  const tidy = () => {
    for (const k of [removeKey, editKey]) if (clearsOnLeave(writes.status(k))) writes.clear(k);
  };
  const close = () => setOpen("none");
  // What the Edit form would send now (its amend's input): the question is answered only while it is
  // still the entry asked about; once the form changes the question is cleared (review round).
  const [current, setCurrent] = useState<Record<string, unknown> | null>(null);
  const stale = answers && writes.status(editKey)?.state === "question" && !writes.matches(editKey, "amend", current);
  useEffect(() => {
    if (stale) writes.clear(editKey);
    // Only a change of staleness clears.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stale]);
  const leave = () => {
    tidy();
    close();
  };
  const toggle = (which: Open) => {
    tidy();
    setOpen(open === which ? "none" : which);
  };
  return (
    <>
      <span className="fix-links">
        <button type="button" className="link" aria-label={`Edit ${name}`} aria-expanded={open === "edit"} disabled={busy || held} onClick={() => toggle("edit")}>
          Edit
        </button>
        <button type="button" className="link" aria-label={`Remove ${name}`} aria-expanded={open === "remove"} disabled={busy || held} onClick={() => toggle("remove")}>
          Remove
        </button>
      </span>
      {open === "remove" ? (
        <div className="draftbar">
          <p>{ask}</p>
          <div className="acts l-cluster">
            <button type="button" className="btn primary" disabled={!online || busy || held} onClick={() => void writes.run(removeKey, removePlan(), closeOnSaved(close))}>
              Remove
            </button>
            <button type="button" className="btn" disabled={busy} onClick={leave}>
              Keep
            </button>
          </div>
        </div>
      ) : null}
      {open === "edit" ? editForm(close, editKey, leave, setCurrent) : null}
      {writes.status(removeKey) || writes.status(editKey) ? (
        <div className="draftbar">
          <WriteLine writes={writes} id={removeKey} online={online} />
          <WriteLine writes={writes} id={editKey} online={online} />
          {answers && open === "edit" && !stale ? (
            <div className="acts l-cluster">
              {questionChoices(writes.status(editKey)).map((c) => (
                <button key={c.label} type="button" className="btn" disabled={!online || busy} onClick={() => void writes.answer(editKey, "amend", c.path, c.value, current)}>
                  {c.label}
                </button>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
    </label>
  );
}

/** A food row's fix: its amount (where it lives), meal and day; a leftover helping can only be removed and logged again. */
export function ItemFixer({ fix, name, today, writes, online }: { fix: ItemFix; name: string; today: string; writes: Writes; online: boolean }) {
  return (
    <Fixer
      id={`item:${fix.remove.table}:${fix.remove.id}`}
      name={name}
      ask={fix.ask}
      writes={writes}
      online={online}
      removePlan={() => removeItemPlan(fix.remove)}
      editForm={(close, key, leave) =>
        fix.edit === "leftover" ? (
          <div className="draftbar">
            <p>A leftover helping can't be changed. Remove it and log it again.</p>
            <div className="acts l-cluster">
              <button type="button" className="btn" onClick={leave}>
                Close
              </button>
            </div>
          </div>
        ) : (
          <ItemEditForm edit={fix.edit} today={today} writes={writes} online={online} close={close} leave={leave} wkey={key} />
        )
      }
    />
  );
}

function ItemEditForm({ edit, today, writes, online, close, leave, wkey }: { edit: Exclude<ItemFix["edit"], "leftover">; today: string; writes: Writes; online: boolean; close: () => void; leave: () => void; wkey: string }) {
  const [d, setD] = useState<ItemEditDraft>({ amount: edit.amount?.value ?? "", slot: edit.slot, date: edit.date, option: edit.amount?.current });
  // A reload with this edit changed and not saved asks first (click test P2-27).
  useUnsavedGuard(d.amount !== (edit.amount?.value ?? "") || d.slot !== edit.slot || d.date !== edit.date || d.option !== edit.amount?.current);
  const options = edit.amount?.options;
  const chosen = options && d.option !== undefined ? options[d.option] : undefined;
  const [error, setError] = useState<string | null>(null);
  const busy = writes.status(wkey)?.state === "pending";
  const held = writes.canRetry(wkey);
  // A new amount asks first when it is implausible, as the Food tab's does (click test P1-1, review P2):
  // the question holds only while the form still holds the amount it asked about, and "Save anyway"
  // sends that amount (decision 83).
  const checked = editAmountCheck(edit, d);
  const itemKey = checked ? JSON.stringify(checked.item) : "";
  const [accepted, setAccepted] = useState<string | null>(null);
  const [asking, setAsking] = useState<{ key: string; text: string } | null>(null);
  const question = checked ? askedFor(asking, itemKey) : null;
  const send = () => {
    const plan = editItemPlan(edit, d, today);
    if ("error" in plan) return setError(plan.error);
    setError(null);
    void writes.run(wkey, plan, closeOnSaved(close));
  };
  const check = async () => {
    const plan = editItemPlan(edit, d, today);
    if ("error" in plan) return setError(plan.error);
    if (!checked || accepted === itemKey || !edit.member || !online) return send();
    const [w, recent] = await Promise.all([
      callTool<WhatIf>("what_if", { member: edit.member, date: d.date, items: [checked.item] }),
      callTool<RecentItems>("recent_items", { member: edit.member }),
    ]);
    const kcal = w.kind === "ok" ? (w.data.items[0]?.nutrients?.kcal?.value ?? null) : null;
    const usual = recent.kind === "ok" ? (recent.data.items.find((r) => r.kind === "food_source" && r.ref === checked.ref)?.usual ?? null) : null;
    const text = foodCheck(kcal, checked.draft, usual && "value" in usual ? usual : null);
    if (text) setAsking({ key: itemKey, text });
    else send();
  };
  // One check at a time: a double tap while what_if answers sends one plan (as the Food tab).
  const [checking, setChecking] = useState(false);
  const latest = useRef(check);
  latest.current = check;
  const guard = useRef<ReturnType<typeof oneAtATime> | null>(null);
  guard.current ??= oneAtATime(async () => {
    setChecking(true);
    try {
      await latest.current();
    } finally {
      setChecking(false);
    }
  });
  const save = () => void guard.current?.run();
  return (
    <form className="draftbar fix-form" aria-label="Edit this item" onSubmit={(e) => (e.preventDefault(), save())}>
      {edit.amount ? (
        <Field label={`How much (${chosen ? optionUnit(chosen) : edit.amount.unit})`}>
          <input inputMode="decimal" value={d.amount} disabled={held} onChange={(e) => setD({ ...d, amount: e.target.value })} />
        </Field>
      ) : null}
      {edit.amount && options ? (
        <Field label="Measure">
          <select value={d.option} disabled={held} onChange={(e) => edit.amount && setD(switchItemMeasure(edit.amount, d, Number(e.target.value)))}>
            {options.map((o, i) => (
              <option key={o.label} value={i}>
                {o.label}
              </option>
            ))}
          </select>
        </Field>
      ) : edit.amount?.field === "amount_value" ? (
        <p className="fix-note">To change the measure, remove it and log it again.</p>
      ) : null}
      <Field label="Meal">
        <select value={d.slot} disabled={held} onChange={(e) => setD({ ...d, slot: e.target.value })}>
          {MEAL_SLOTS.map((s) => (
            <option key={s} value={s}>
              {slotLabel(s)}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Day">
        <input type="date" value={d.date} max={today} disabled={held} onChange={(e) => setD({ ...d, date: e.target.value })} />
      </Field>
      {error ? <p className="error-text">{error}</p> : null}
      {question ? (
        <div className="status question" role="status">
          {question}{" "}
          <button type="button" className="btn" disabled={!online || busy || held} onClick={() => {
              setAccepted(itemKey);
              setAsking(null);
              send();
            }}>
            Save anyway
          </button>
        </div>
      ) : null}
      <div className="acts l-cluster">
        <button type="submit" className="btn primary" disabled={!online || busy || held || question !== null || checking}>
          Save
        </button>
        <button type="button" className="btn" disabled={busy} onClick={leave}>
          Cancel
        </button>
      </div>
    </form>
  );
}

/** A set row's fix: reps and RIR, checked as the Set form checks them; a load is changed by removing the set and logging it again. */
export function SetFixer({ fix, name, mode, writes, online }: { fix: SetFix; name: string; mode: "prescribed" | "record_only"; writes: Writes; online: boolean }) {
  return (
    <Fixer
      id={`set:${fix.edit.id}`}
      name={name}
      ask={fix.ask}
      writes={writes}
      online={online}
      removePlan={() => removeSetPlan(fix.edit.id)}
      editForm={(close, key, leave) => <SetEditForm fix={fix} mode={mode} writes={writes} online={online} close={close} leave={leave} wkey={key} />}
    />
  );
}

function SetEditForm({ fix, mode, writes, online, close, leave, wkey }: { fix: SetFix; mode: "prescribed" | "record_only"; writes: Writes; online: boolean; close: () => void; leave: () => void; wkey: string }) {
  const e0 = fix.edit;
  const [d, setD] = useState({ reps: e0.reps, rir: e0.rir, secs: e0.secs ?? "" });
  useUnsavedGuard(d.reps !== e0.reps || d.rir !== e0.rir || d.secs !== (e0.secs ?? ""));
  const [error, setError] = useState<string | null>(null);
  const busy = writes.status(wkey)?.state === "pending";
  const held = writes.canRetry(wkey);
  const save = () => {
    const plan = editSetPlan(e0, d, mode);
    if ("error" in plan) return setError(plan.error);
    setError(null);
    void writes.run(wkey, plan, closeOnSaved(close));
  };
  // A set not counted in reps (a hold, a carry) is never asked its RIR (Worker decision 144).
  const rirOptional = !(mode === "prescribed" && e0.setType === "working") || e0.counted !== undefined;
  return (
    <form className="draftbar fix-form" aria-label="Edit this set" onSubmit={(e) => (e.preventDefault(), save())}>
      {e0.counted === "seconds" ? (
        <Field label="Seconds">
          <input inputMode="numeric" value={d.secs} disabled={held} onChange={(e) => setD({ ...d, secs: e.target.value })} />
        </Field>
      ) : e0.counted === undefined ? (
        <Field label="Reps">
          <input inputMode="numeric" value={d.reps} disabled={held} onChange={(e) => setD({ ...d, reps: e.target.value })} />
        </Field>
      ) : null}
      <Field label={`RIR${rirOptional ? " (optional)" : ""}`}>
        <input inputMode="numeric" value={d.rir} placeholder="2 or 1-2" disabled={held} onChange={(e) => setD({ ...d, rir: e.target.value })} />
      </Field>
      <p className="fix-note">{SET_LOAD_NOTE}</p>
      {error ? <p className="error-text">{error}</p> : null}
      <div className="acts l-cluster">
        <button type="submit" className="btn primary" disabled={!online || busy || held}>
          Save
        </button>
        <button type="button" className="btn" disabled={busy} onClick={leave}>
          Cancel
        </button>
      </div>
    </form>
  );
}

/** A cardio session's fix (click test P2-20): a lone block's minutes, or Remove for every block; a session of several blocks is removed and logged again. */
export function CardioFixer({ id, fix, name, writes, online }: { id: number; fix: CardioFix; name: string; writes: Writes; online: boolean }) {
  return (
    <Fixer
      id={`cardio:${id}`}
      name={name}
      ask={fix.ask}
      writes={writes}
      online={online}
      removePlan={() => removeCardioPlan(fix.remove, fix.session)}
      editForm={(close, key, leave) =>
        fix.edit ? (
          <CardioEditForm edit={fix.edit} writes={writes} online={online} close={close} leave={leave} wkey={key} />
        ) : (
          <div className="draftbar">
            <p>A session of several blocks can't be changed here. Remove it and log it again.</p>
            <div className="acts l-cluster">
              <button type="button" className="btn" onClick={leave}>
                Close
              </button>
            </div>
          </div>
        )
      }
    />
  );
}

function CardioEditForm({ edit, writes, online, close, leave, wkey }: { edit: { id: number; minutes: string }; writes: Writes; online: boolean; close: () => void; leave: () => void; wkey: string }) {
  const [minutes, setMinutes] = useState(edit.minutes);
  const [error, setError] = useState<string | null>(null);
  useUnsavedGuard(minutes !== edit.minutes);
  const busy = writes.status(wkey)?.state === "pending";
  const held = writes.canRetry(wkey);
  const save = () => {
    const plan = editCardioPlan(edit, minutes);
    if ("error" in plan) return setError(plan.error);
    setError(null);
    void writes.run(wkey, plan, closeOnSaved(close));
  };
  return (
    <form className="draftbar fix-form" aria-label="Edit this cardio" onSubmit={(e) => (e.preventDefault(), save())}>
      <Field label="Minutes">
        <input inputMode="decimal" value={minutes} disabled={held} onChange={(e) => setMinutes(e.target.value)} />
      </Field>
      {error ? <p className="error-text">{error}</p> : null}
      <div className="acts l-cluster">
        <button type="submit" className="btn primary" disabled={!online || busy || held}>
          Save
        </button>
        <button type="button" className="btn" disabled={busy} onClick={leave}>
          Cancel
        </button>
      </div>
    </form>
  );
}

/** A reading row's fix (click test P1-3): its value, unit and day; an implausible change is asked about first, as a new reading's is. */
export function ReadingFixer({ fix, today, writes, online }: { fix: ReadingFix; today: string; writes: Writes; online: boolean }) {
  return (
    <Fixer
      id={`reading:${fix.id}`}
      name={fix.text}
      ask={fix.ask}
      writes={writes}
      online={online}
      removePlan={() => removeReadingPlan(fix.id)}
      editForm={(close, key, leave, report) => <ReadingEditForm fix={fix} today={today} writes={writes} online={online} close={close} leave={leave} wkey={key} report={report} />}
      answers
    />
  );
}

function ReadingEditForm({ fix, today, writes, online, close, leave, wkey, report }: { fix: ReadingFix; today: string; writes: Writes; online: boolean; close: () => void; leave: () => void; wkey: string; report: (current: Record<string, unknown> | null) => void }) {
  const e0 = fix.edit;
  const [d, setD] = useState({ value: e0.value, unit: e0.unit, date: e0.date });
  useUnsavedGuard(d.value !== e0.value || d.unit !== e0.unit || d.date !== e0.date);
  // The amend this form would send now, for the Fixer's question (only its answer chip reads it).
  const now = editReadingPlan(e0, d, today);
  const nowKey = "steps" in now ? JSON.stringify(now.steps[0]?.input.changes ?? null) : "";
  useEffect(() => {
    report("steps" in now ? (now.steps[0]?.input ?? null) : null);
    // nowKey stands for the entry; the plan's fresh idempotency key doesn't matter (sameInput ignores it).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nowKey]);
  const [error, setError] = useState<string | null>(null);
  const status = writes.status(wkey);
  const busy = status?.state === "pending";
  const held = writes.canRetry(wkey);
  const save = () => {
    const plan = editReadingPlan(e0, d, today);
    if ("error" in plan) return setError(plan.error);
    setError(null);
    void writes.run(wkey, plan, closeOnSaved(close));
  };
  return (
    <form className="draftbar fix-form" aria-label="Edit this reading" onSubmit={(e) => (e.preventDefault(), save())}>
      <Field label={`Value, in ${d.unit}`}>
        <input inputMode="decimal" value={d.value} disabled={held} onChange={(e) => setD({ ...d, value: e.target.value })} />
      </Field>
      <Field label="Unit">
        <select value={d.unit} disabled={held} onChange={(e) => setD({ ...d, unit: e.target.value })}>
          {e0.units.map((u) => (
            <option key={u} value={u}>
              {u}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Day">
        <input type="date" value={d.date} max={today} disabled={held} onChange={(e) => setD({ ...d, date: e.target.value })} />
      </Field>
      {error ? <p className="error-text">{error}</p> : null}
      <div className="acts l-cluster">
        <button type="submit" className="btn primary" disabled={!online || busy || held}>
          Save
        </button>
        <button type="button" className="btn" disabled={busy} onClick={leave}>
          Cancel
        </button>
      </div>
    </form>
  );
}

/**
 * Your own draft set, confirmed where it is shown (click test P1-5): a set
 * whose load isn't on the gym's list went in as a draft, and Train is where
 * the "drafts about you" card sends you. One `confirm` under its own key;
 * a refusal (a prescribed set still without RIR) says why.
 */
export function ConfirmDraft({ id, records, writes, online }: { id: string; records: RecordRef[]; writes: Writes; online: boolean }) {
  const key = `confirm:${id}`;
  const busy = writes.status(key)?.state === "pending";
  const held = writes.canRetry(key);
  return (
    <div className="draftbar">
      <p>A draft, not confirmed yet.</p>
      <div className="acts l-cluster">
        <button type="button" className="btn primary" disabled={!online || busy || held} onClick={() => void writes.run(key, confirmPlan(records))}>
          Yes, confirm
        </button>
      </div>
      <WriteLine writes={writes} id={key} online={online} />
    </div>
  );
}
