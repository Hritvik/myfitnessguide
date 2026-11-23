import { useState } from "react";
import type { Writes } from "../hooks";
import type { Tier, TierItem } from "../today";
import { confirmPlan, rejectPlan, undoChangePlan, withdrawPlan } from "../writes";
import { ItemFixer } from "./Fix";
import { HistoryLink } from "./HistoryLink";
import { Text } from "./layout/Text";
import { WriteLine } from "./WriteLine";

const DRAFT_HINT = {
  here: " Is it right?",
  pot: " Confirm or change it on the pot card.",
  owner: " Only the member it's about can confirm it.",
  author: " Only the member it's about can confirm it; you can take it back until they do.",
  redraft: " They changed what you had confirmed: keep their change, or undo it.",
} as const;

export function Tiers({ tiers, writes, online, timeZone, today, onAdd, wide = false }: { tiers: Tier[]; writes: Writes; online: boolean; timeZone: string; today: string; onAdd?: (slot: string, from: HTMLElement) => void; wide?: boolean }) {
  return (
    <ol id="meals" className="tiers" aria-label="Meals">
      {tiers.map((t) => (
        <li key={t.slot} className={`tier ${t.state}`}>
          <header>
            <h2>{t.label}</h2>
            {/* Named, so a test (or a screen reader's list of notes) finds a meal's subtotal by role (e2e F12). */}
            <span role="note" aria-label={`${t.label} subtotal`}>
              {t.meta}
            </span>
          </header>
          {onAdd ? (
            <button type="button" className="btn tier-add" onClick={(e) => onAdd(t.slot, e.currentTarget)}>
              Add to this meal
            </button>
          ) : null}
          {t.waiting.map((w, i) => (
            <p key={i} className="leftnote">
              {w}
            </p>
          ))}
          {t.items.length > 0 ? (
            <ul className="items">
              {t.items.map((i) => (
                <Item key={i.id} item={i} writes={writes} online={online} timeZone={timeZone} today={today} wide={wide} />
              ))}
            </ul>
          ) : null}
        </li>
      ))}
    </ol>
  );
}

function Item({ item, writes, online, timeZone, today, wide }: { item: TierItem; writes: Writes; online: boolean; timeZone: string; today: string; wide: boolean }) {
  const key = `item:${item.id}`;
  const disabled = !online || writes.status(key)?.state === "pending";
  // "Not eaten" asks once, as Remove does on your own rows (click test P2-26): a draft removed is gone for its logger too.
  const [asking, setAsking] = useState(false);
  return (
    <li className={`item${item.draft ? " draft" : ""}`}>
      <span>
        {item.name}
        {item.amount ? <span className="amount"> {item.amount}</span> : null}
      </span>
      {wide ? (
        // A wide tier's numbers (wide-layout spec §5, Today B): shown once the tier is 520 px wide (layout.css).
        <>
          <Text as="span" mode="nowrap" className="num">
            {item.kcal}
          </Text>
          <Text as="span" mode="nowrap" className="num">
            {item.protein}
          </Text>
        </>
      ) : null}
      <span className={`prov${item.estimated ? " est" : ""}`}>{item.provenance}</span>
      <HistoryLink table="intake_item" id={item.id} timeZone={timeZone} />
      {item.fix ? <ItemFixer fix={item.fix} name={item.name} today={today} writes={writes} online={online} /> : null}
      {item.draft || writes.status(key) ? (
        <div className="draftbar">
          {item.draft ? (
            <p>
              Draft, {item.draft.edited ? "edited" : "logged"} by {item.draft.by}.{DRAFT_HINT[item.draft.where]}
            </p>
          ) : null}
          {item.draft?.where === "here" ? (
            <div className="acts l-cluster">
              <button type="button" className="btn primary" disabled={disabled} onClick={() => void writes.run(key, confirmPlan(item.draft!.confirm))}>
                Yes, confirm
              </button>
              <button type="button" className="btn" disabled={disabled} aria-expanded={asking} onClick={() => setAsking(!asking)}>
                Not eaten, remove it
              </button>
            </div>
          ) : null}
          {item.draft?.where === "redraft" ? (
            <div className="acts l-cluster">
              <button type="button" className="btn primary" disabled={disabled} onClick={() => void writes.run(key, confirmPlan(item.draft!.confirm))}>
                Keep their change
              </button>
              <button type="button" className="btn" disabled={disabled} onClick={() => void writes.run(key, undoChangePlan(item.draft!.confirm))}>
                Undo their change
              </button>
            </div>
          ) : null}
          {item.draft?.where === "author" ? (
            <div className="acts l-cluster">
              <button type="button" className="btn" disabled={disabled} aria-expanded={asking} onClick={() => setAsking(!asking)}>
                Take it back
              </button>
            </div>
          ) : null}
          {asking && item.draft?.where === "author" ? (
            <div role="group" aria-label="Take this draft back?">
              <p>
                Take back {item.name}{item.amount ? ` ${item.amount}` : ""}? It goes from their day.
              </p>
              <div className="acts l-cluster">
                <button type="button" className="btn primary" disabled={disabled} onClick={() => void writes.run(key, withdrawPlan(item.draft!.confirm), (o) => o.status.state === "saved" && setAsking(false))}>
                  Take it back
                </button>
                <button type="button" className="btn" disabled={disabled} onClick={() => setAsking(false)}>
                  Keep
                </button>
              </div>
            </div>
          ) : null}
          {asking && item.draft?.where === "here" ? (
            <div role="group" aria-label="Remove this draft?">
              <p>
                Remove {item.name}{item.amount ? ` ${item.amount}` : ""}? {item.draft.by} logged it; it goes for them too.
              </p>
              <div className="acts l-cluster">
                <button type="button" className="btn primary" disabled={disabled} onClick={() => void writes.run(key, rejectPlan(item.draft!.confirm), (o) => o.status.state === "saved" && setAsking(false))}>
                  Remove
                </button>
                <button type="button" className="btn" disabled={disabled} onClick={() => setAsking(false)}>
                  Keep
                </button>
              </div>
            </div>
          ) : null}
          <WriteLine writes={writes} id={key} online={online} />
        </div>
      ) : null}
    </li>
  );
}
