/**
 * The overflow rules (web decision 82), read from the stylesheet and the
 * screens' source: layout itself is checked by `scripts/sweep-layout.ts`,
 * but the rules that keep long text inside its column can be pinned here.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { cssRules, selectors } from "./css";
import { sourceFiles } from "./layout-lint";

const src = join(import.meta.dirname, "..", "src");

/** Every rule of the stylesheet, at-rule blocks flattened (test/css.ts, the one CSS reader). */
const rules = cssRules(readFileSync(join(src, "styles.css"), "utf8"));
const rule = (selector: string) => rules.filter((r) => selectors(r).includes(selector));
const declares = (selector: string, decl: RegExp) => rule(selector).some((r) => decl.test(r.body));
/** layout.css's rules: a prescription card is an .l-stack and the Train cue a .t-clamp at every width (web decision 122). */
const layoutRules = cssRules(readFileSync(join(src, "components", "layout", "layout.css"), "utf8"));
const lays = (selector: string, decl: RegExp) => layoutRules.some((r) => selectors(r).includes(selector) && decl.test(r.body));

/**
 * The pick buttons in a source whose first child is not a truncating <Text>: each `className="pick"` button's
 * body, from its opening tag to `</button>`, read whole (an `onClick={() => …}` arrow can't end the tag early).
 */
function rawPickNames(source: string): string[] {
  const out: string[] = [];
  for (const m of source.matchAll(/<button\b[^]*?className="pick"[^]*?<\/button>/g)) {
    const button = m[0].slice(m[0].lastIndexOf("<button"));
    const open = button.search(/\}>|">/);
    const body = button.slice(open + 2).trimStart();
    if (!body.startsWith('<Text mode="truncate"')) out.push(button);
  }
  return out;
}

describe("long text stays in its column", () => {
  it("the screen, a wide column, a prescription card and a catalogue record size their one track with minmax(0, 1fr)", () => {
    for (const s of [".screen", ".col", ".record"]) expect(declares(s, /grid-template-columns:\s*minmax\(0,\s*1fr\)/), s).toBe(true);
    expect(lays(".l-stack", /grid-template-columns:\s*minmax\(0,\s*1fr\)/), ".l-stack (.rx)").toBe(true);
  });

  it("a collapsed summary is clamped to two lines with an ellipsis and breaks long words; opened, it shows everything", () => {
    expect(lays(".t-clamp", /-webkit-line-clamp:\s*2/)).toBe(true);
    expect(lays(".t-clamp", /overflow:\s*hidden/)).toBe(true);
    expect(lays(".t-clamp", /overflow-wrap:\s*anywhere/)).toBe(true);
    expect(lays("details[open] > .t-clamp", /-webkit-line-clamp:\s*none/)).toBe(true);
    expect(readFileSync(join(src, "screens", "TrainScreen.tsx"), "utf8")).toContain('<summary className="t-clamp">{row.cue}</summary>');
  });

  it("no rule keeps text on one line without an ellipsis, except the listed short labels", () => {
    // Short, fixed labels the app writes itself: a key in the "?" list, a tab name, screen-reader text.
    const allowed = new Set([".visually-hidden", ".sheet-tabs button", ".keyhelp tbody th"]);
    const nowrap = rules.filter((r) => /white-space:\s*nowrap/.test(r.body));
    const bare = nowrap.filter((r) => !/text-overflow:\s*ellipsis/.test(r.body) && !allowed.has(r.selector));
    expect(bare.map((r) => r.selector)).toEqual([]);
  });

  it("the + sheet and its stacks size their one track with minmax(0, 1fr), so a long name cannot widen the sheet and carry every input past the edge", () => {
    for (const s of [".sheet", ".sheet-body", ".sheet .pick-list"]) expect(declares(s, /grid-template-columns:\s*minmax\(0,\s*1fr\)/), s).toBe(true);
  });

  it("every pick row in the + sheet truncates its name through <Text> and keeps it whole in a title", () => {
    const tab = (f: string) => readFileSync(join(src, "components", "sheet", f), "utf8");
    expect(tab("FoodTab.tsx")).toContain('<Text mode="truncate" reach="title">{r.label}</Text>');
    expect(tab("SetTab.tsx")).toContain('<Text mode="truncate" reach="title">{c.name}</Text>');
    expect(tab("WorkoutTab.tsx")).toContain('<Text mode="truncate" reach="title">{w.name}</Text>');
    expect(tab("WorkoutTab.tsx")).toContain('<Text mode="truncate" reach="title">{`Next: ${');
    expect(tab("MealPanel.tsx")).toContain('<Text mode="truncate" reach="title">{foodLabel(h.name, h.state)}</Text>');
    // No pick row's name is a raw span any more: every pick button's first child is a truncating <Text>.
    for (const f of ["FoodTab.tsx", "SetTab.tsx", "WorkoutTab.tsx", "MealPanel.tsx"]) expect(rawPickNames(tab(f)), f).toEqual([]);
  });

  it("the raw-pick-name check can fail: it finds a raw <span> name after an onClick arrow (review P2-5)", () => {
    const probe = `<button type="button" className="pick" onClick={() => choose(h.ref)}>\n  <span>{h.name}</span>\n</button>`;
    expect(rawPickNames(probe)).toHaveLength(1);
    const fine = `<button type="button" className="pick" onClick={() => choose(h.ref)}><Text mode="truncate" reach="title">{h.name}</Text></button>`;
    expect(rawPickNames(fine)).toEqual([]);
  });

  it("a pick row's short detail keeps its line beside the name, and is truncated with a title past 60%", () => {
    expect(declares(".sheet .pick small", /flex:\s*none/)).toBe(true);
    expect(declares(".sheet .pick small", /max-width:\s*60%/)).toBe(true);
    const food = readFileSync(join(src, "components", "sheet", "FoodTab.tsx"), "utf8");
    expect(food).toContain('<small><Text mode="truncate" reach="title">{r.detail}</Text></small>');
  });

  it("a word longer than its line breaks rather than overflowing", () => {
    expect(declares("body", /overflow-wrap:\s*break-word/)).toBe(true);
  });

  it("the page leaves room for the floating + below the last row", () => {
    expect(declares(".app", /padding-bottom:\s*calc\(140px/)).toBe(true);
    expect(declares(".app.wide > .screen", /padding:\s*20px 24px 104px/)).toBe(true);
  });

  it("no component writes white-space: nowrap inline", () => {
    for (const f of sourceFiles(src, ".tsx")) expect(readFileSync(f, "utf8"), f).not.toMatch(/whiteSpace:\s*["']nowrap/);
  });

  it("the wide screen has no 1,180 px cap: it fills the window up to 2,400 px, and is the container its templates query", () => {
    expect(declares(".app.wide > .screen", /max-width:\s*1180px/)).toBe(false);
    expect(declares(".app.wide > .screen", /max-width:\s*2400px/)).toBe(true);
    expect(declares(".app.wide > .screen", /container:\s*screen\s*\/\s*inline-size/)).toBe(true);
  });

  it("from a 1,920 px window the gutter is 32 px and parts sit 20 px apart; type and padding above and below don't change", () => {
    const veryWide = rules.filter((r) => r.at === "@media (min-width: 1920px)");
    const body = (selector: string) => veryWide.filter((r) => selectors(r).includes(selector)).map((r) => r.body).join(";");
    expect(body(".app.wide > .screen")).toMatch(/padding:\s*20px 32px 104px/);
    expect(body(".app.wide > .screen")).toMatch(/gap:\s*var\(--gap-20\)/);
    expect(body(".app.wide .col:not(.l-grid)")).toMatch(/gap:\s*var\(--gap-20\)/);
    expect(veryWide.some((r) => /font-size/.test(r.body))).toBe(false);
  });

  it("analytics screens use the available desktop canvas instead of leaving an empty trailing half", () => {
    for (const s of [".app.wide > .screen.progress", ".app.wide > .screen.health"]) {
      expect(rules.some((r) => r.at === null && selectors(r).includes(s) && /max-width:\s*1180px/.test(r.body)), s).toBe(false);
    }
  });
});
