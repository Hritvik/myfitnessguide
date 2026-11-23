// The Tiers item's draft actions, rendered to markup (ticket 69): which
// buttons a draft, a re-draft and your own draft on another day offer.
// Invented data only.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PotCard } from "../src/components/PotCard";
import { Tiers } from "../src/components/Tiers";
import type { Writes } from "../src/hooks";
import { buildToday, type Tier, type TierItem } from "../src/today";
import { dalCook, item, meals, today } from "./fixtures";

const writes = { status: () => null, run: async () => ({}), retry: async () => null, answer: async () => null, matches: () => false, canRetry: () => false, clear: () => {}, slot: () => ({}), busy: false } as unknown as Writes;

function render(draft: TierItem["draft"]): string {
  const tier: Tier = { slot: "snack", label: "Snack", state: "eaten", meta: "", waiting: [], items: [{ id: 5, name: "Invented yogurt", amount: "100 g", provenance: "weighed", estimated: false, kcal: "190 kcal", protein: "P 7 g", draft }] };
  return renderToStaticMarkup(createElement(Tiers, { tiers: [tier], writes, online: true, timeZone: "Asia/Kolkata", today: "2026-10-06" }));
}

/** The draft bar's buttons (the row's own history button aside). */
const buttons = (html: string) => [...html.matchAll(/<button[^>]*>([^<]*)<\/button>/g)].map((m) => m[1]).filter((b) => b !== "history");
const ref = [{ table: "intake_item", id: 5 }];

describe("a draft item's actions", () => {
  it("a plain draft about you: confirm, or not eaten", () => {
    const html = render({ by: "Kabir", confirm: ref, where: "here", edited: false });
    expect(html).toContain("Draft, logged by Kabir.");
    expect(buttons(html)).toEqual(["Yes, confirm", "Not eaten, remove it"]);
  });

  it("a re-draft of your record: keep or undo their change, edited by them", () => {
    const html = render({ by: "Kabir", confirm: ref, where: "redraft", edited: true });
    expect(html).toContain("Draft, edited by Kabir.");
    expect(buttons(html)).toEqual(["Keep their change", "Undo their change"]);
  });

  it("your own draft on another member's day: take it back", () => {
    const html = render({ by: "Asha", confirm: ref, where: "author", edited: false });
    expect(buttons(html)).toEqual(["Take it back"]);
  });

  it("anyone else's draft on another member's day: nothing to press", () => {
    expect(buttons(render({ by: "Noor", confirm: ref, where: "owner", edited: false }))).toEqual([]);
  });
});

describe("a pot card's draft share", () => {
  const pot = (over: Record<string, unknown>) => {
    const base = dalCook();
    const view = buildToday(today({ cooks: { member: "Asha", date: "2026-10-06", cooks: [dalCook({ ask: { ...base.ask!, ...over } })] } }));
    return renderToStaticMarkup(createElement(PotCard, { pot: view.pots[0]!, writes, online: true }));
  };

  it("a plain draft share: confirm, change, or mark the rest leftover", () => {
    expect(buttons(pot({}))).toEqual(["Yes, confirm", "Change my share", "Mark the rest leftover"]);
  });

  it("a re-drafted share: keep or undo their change, edited by them", () => {
    const html = pot({ ever_confirmed: true, edited_by: { kind: "member", name: "Kabir" } });
    expect(html).toContain("Edited by Kabir");
    expect(buttons(html)).toEqual(["Keep their change", "Undo their change", "Change my share"]);
  });
});

describe("a wide tier's numbers (wide-layout spec §5, Today B; review #8)", () => {
  // One item nobody measured, one measured at zero: the view model words both, the wide tier draws them.
  const tiers = buildToday(
    today({
      meals: meals({
        slots: [
          {
            slot: "dinner",
            state: "eaten",
            totals: { kcal: null, protein: null },
            items: [item({ id: 1, name: "Invented tofu", kcal: null, protein: null }), item({ id: 2, name: "Black coffee", kcal: 0, protein: 0 })],
          },
        ],
      }),
    }),
  ).tiers;
  const draw = (wide: boolean) => renderToStaticMarkup(createElement(Tiers, { tiers, writes, online: true, timeZone: "Asia/Kolkata", today: "2026-10-06", wide }));
  const nums = (html: string) => [...html.matchAll(/<span class="[^"]*\bnum\b[^"]*">([^<]*)<\/span>/g)].map((m) => m[1]);

  it("draws each item's kcal and protein as .num spans on a wide screen: unknown as unknown, a measured zero as 0", () => {
    expect(nums(draw(true))).toEqual(["kcal unknown", "P unknown", "0 kcal", "P 0 g"]);
  });

  it("draws no .num span on the phone", () => {
    const html = draw(false);
    expect(nums(html)).toEqual([]);
    // No element carries the class token num, whatever else its class list or text says.
    expect(html).not.toMatch(/class="(?:[^"]*\s)?num(?:\s[^"]*)?"/);
  });
});
