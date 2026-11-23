/**
 * The layout system (wide-layout spec §3, §4): the primitives' markup on the
 * phone and on a wide screen, the CSS that only a wide screen can match, and
 * the converted ADOPTED selectors. Components are rendered to static markup; layout
 * itself is checked by the sweep and the phone check.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Grid } from "../src/components/layout/Grid";
import { Stack } from "../src/components/layout/Stack";
import { FoodFacts, FoodSections } from "../src/components/catalogue/FoodRecord";
import { Panes } from "../src/components/catalogue/Panes";
import { RecordSection } from "../src/components/catalogue/RecordSection";
import { Split } from "../src/components/Split";
import { Text } from "../src/components/layout/Text";
import type { FoodView } from "../src/catalogue";
import type { Layout, PartSpec } from "../src/layout";
import { cssRules, selectors, stripComments } from "./css";
import { countViolations, sourceFiles, structureViolations, textViolations, WEB, type Counts } from "./layout-lint";

const src = join(import.meta.dirname, "..", "src");
const stylesCss = readFileSync(join(src, "styles.css"), "utf8");
const layoutCss = readFileSync(join(src, "components", "layout", "layout.css"), "utf8");
const html = (el: ReactElement) => renderToStaticMarkup(el);

describe("the CSS reader (test/css.ts)", () => {
  it("reads innermost rules, each with its innermost at-rule, and no comments", () => {
    const css = ":root { --a: 1px; } /* x { y: z; } */ @media (min-width: 1920px) { .a, .b { gap: 2px; } @container screen (min-width: 1150px) { .c { gap: 3px; } } }";
    expect(cssRules(css).map((r) => [r.selector, r.body.trim(), r.at])).toEqual([
      [":root", "--a: 1px;", null],
      [".a, .b", "gap: 2px;", "@media (min-width: 1920px)"],
      [".c", "gap: 3px;", "@container screen (min-width: 1150px)"],
    ]);
    expect(cssRules(css).slice(1, 2).flatMap(selectors)).toEqual([".a", ".b"]);
  });

  it("splits a selector list only at its top-level commas, never inside :is(), :where(), :not() or :has()", () => {
    const css = ".app.wide > .screen:is(.train, .progress), .x:not(.a, .b) > p, :where(.c,.d):has(> .e, .f) { gap: 1px; }";
    expect(cssRules(css).flatMap(selectors)).toEqual([".app.wide > .screen:is(.train, .progress)", ".x:not(.a, .b) > p", ":where(.c,.d):has(> .e, .f)"]);
  });
});

describe("the space tokens (wide-layout spec §2)", () => {
  it("join :root, one per step", () => {
    const root = cssRules(stylesCss).find((r) => r.selector === ":root");
    for (const g of [4, 8, 12, 16, 20, 24, 32]) expect(root?.body, `--gap-${g}`).toMatch(new RegExp(`--gap-${g}:\\s*${g}px;`));
  });
});

describe("Grid (wide-layout spec §3)", () => {
  const li = createElement("li", null, "a");
  const p = createElement("p", null, "a");

  it("is exactly its element, or a fragment, on the phone", () => {
    expect(html(createElement(Grid, { wide: false, min: 340, gap: 12, as: "ol", className: "rows" }, li))).toBe('<ol class="rows"><li>a</li></ol>');
    expect(html(createElement(Grid, { wide: false, min: 340, gap: 12 }, p))).toBe("<p>a</p>");
  });

  it("adds its classes on a wide screen, and passes id, role, aria-* and data-* through", () => {
    expect(html(createElement(Grid, { wide: true, min: 340, max: 3, gap: 16, className: "record-sections", "data-region": "x", "aria-label": "Sections" }, p))).toBe(
      '<div class="record-sections l-grid min-340 max-3 g-16" data-region="x" aria-label="Sections"><p>a</p></div>',
    );
    expect(html(createElement(Grid, { wide: true, min: 480, gap: 20, fill: true, as: "ol" }, li))).toBe('<ol class="l-grid min-480 g-20 fill"><li>a</li></ol>');
  });
});

describe("<Text> (wide-layout spec §3)", () => {
  it("wraps by default: nothing added, and a fragment without `as`", () => {
    expect(html(createElement(Text, { children: "Oats" }))).toBe("Oats");
    expect(html(createElement(Text, { as: "h3", children: "Words" }))).toBe("<h3>Words</h3>");
  });

  it("clamps only as a summary, to 2 or 3 lines", () => {
    expect(html(createElement(Text, { mode: "clamp", lines: 2, as: "summary", children: "A long cue" }))).toBe('<summary class="t-clamp">A long cue</summary>');
    expect(html(createElement(Text, { mode: "clamp", lines: 3, as: "summary", className: "cue", children: "A long cue" }))).toBe('<summary class="cue t-clamp t-clamp-3">A long cue</summary>');
  });

  it("truncates with the full text kept reachable: a title, or the link or label it sits in", () => {
    expect(html(createElement(Text, { mode: "truncate", reach: "title", children: "Masoor dal tadka" }))).toBe('<span class="t-trunc" title="Masoor dal tadka">Masoor dal tadka</span>');
    expect(html(createElement(Text, { mode: "truncate", reach: "link", as: "b", children: "Masoor dal" }))).toBe('<b class="t-trunc">Masoor dal</b>');
  });

  it("keeps a short label on one line, and passes data-* through", () => {
    expect(html(createElement(Text, { mode: "nowrap", className: "num", "data-x": "1", children: "12 g" }))).toBe('<span class="num t-nowrap" data-x="1">12 g</span>');
  });
});

describe("ADOPTED is converted (e2e spec §8)", () => {
  const rules = cssRules(stylesCss);
  const at = (selector: string) => rules.filter((r) => selectors(r).includes(selector));
  const sources = sourceFiles(join(WEB, "src"), ".tsx").map((f) => readFileSync(f, "utf8")).join("\n");

  it("styles.css no longer gives .rx or .acts their structure, and the clamp, truncate and catalogue-cols rules are gone", () => {
    expect(at(".rx").some((r) => /display:|grid-template-columns:/.test(r.body))).toBe(false);
    expect(at(".acts").some((r) => /display:|flex-wrap:/.test(r.body))).toBe(false);
    expect(rules.filter((r) => selectors(r).some((s) => s.includes("summary.clamp")))).toEqual([]);
    expect(at(".seg > span")).toEqual([]);
    expect(rules.filter((r) => selectors(r).some((s) => s.includes("catalogue-cols")))).toEqual([]);
  });

  it("every element that was adopted carries its primitive or mode", () => {
    for (const m of sources.matchAll(/className=(?:"([^"]*)"|\{`([^`]*)`\})/g)) {
      const cls = (m[1] ?? m[2] ?? "").split(/\s+/);
      if (cls.includes("rx")) expect(cls, m[0]).toContain("l-stack");
      if (cls.includes("acts")) expect(cls, m[0]).toContain("l-cluster");
      expect(cls, m[0]).not.toContain("clamp");
    }
    // The pot bar's label goes through <Text> (web decision 111; F16): the seg's title carries the full text.
    expect(sources).toMatch(/<Text mode="truncate" reach="label">\{s\.label\}<\/Text>/);
  });

  it("ADOPTED is deleted", () => {
    expect(existsSync(new URL("../src/components/layout/adopted.ts", import.meta.url))).toBe(false);
  });
});

describe("layout.css (wide-layout spec §1)", () => {
  it("holds only l-*, t-* and named .cols classes, or rules under .app.wide", () => {
    // a named .cols and .app.wide are wide-only; l-stack and l-cluster render on the phone too (web decision 122), and so does t-*: <Text> emits its mode's class at every width, so a phone <Text> mode matches on purpose.
    const WIDE = /^(\.l-|\.t-|:is\(\.l-|\.cols\.|\.app\.wide |details\[open\] > \.t-clamp)/;
    expect(cssRules(layoutCss).flatMap(selectors).filter((s) => !WIDE.test(s))).toEqual([]);
  });
});

describe("Split (wide-layout spec §4)", () => {
  const nodes = { a: createElement("p", null, "A"), b: createElement("p", null, "B"), c: createElement("p", null, "C") };
  const two: PartSpec[] = [{ key: "a", side: "full" }, { key: "b", side: "left" }, { key: "c", side: "right" }];

  it("gives the phone the parts as fragments, in order", () => {
    expect(html(createElement(Split, { wide: false, specs: two, nodes }))).toBe("<p>A</p><p>B</p><p>C</p>");
  });

  it("draws TWO exactly as the desktop build did: both columns, even an empty one, and no name or data-region", () => {
    expect(html(createElement(Split, { wide: true, specs: two, nodes, className: "x" }))).toBe('<p>A</p><div class="cols x"><div class="col"><p>B</p></div><div class="col"><p>C</p></div></div>');
    expect(html(createElement(Split, { wide: true, specs: two.slice(0, 2), nodes }))).toBe('<p>A</p><div class="cols"><div class="col"><p>B</p></div><div class="col"></div></div>');
  });

  it("draws a named layout's regions in its order, leaves an empty one out, and a grids region through Grid", () => {
    const demo: Layout = { name: "demo", regions: ["x", "y", "z"], grids: { z: { min: 480, max: 4, gap: 16 } } };
    const specs: PartSpec[] = [{ key: "a", side: "full" }, { key: "c", side: "z" }, { key: "b", side: "x" }];
    expect(html(createElement(Split, { wide: true, specs, nodes, layout: demo, className: "extra" }))).toBe(
      '<p>A</p><div class="cols demo extra"><div class="col" data-region="x"><p>B</p></div><div class="col l-grid min-480 max-4 g-16" data-region="z"><p>C</p></div></div>',
    );
  });
});

describe("the text lint (wide-layout spec §3)", () => {
  const count = (tsx: string) => textViolations("probe.tsx", tsx);

  it("counts a variable read straight into an intrinsic element", () => {
    expect(count('const a = <p className="leftnote">{view.message}</p>;')).toBe(1);
    expect(count("const a = <li>{w}</li>;")).toBe(1);
    expect(count("const a = <span>{`${n} kcal`}</span>;")).toBe(1);
    expect(count('const a = <h1>{view.title ?? "Train"}</h1>;')).toBe(1);
    expect(count("const a = <b>{row?.name}</b>;")).toBe(1);
  });

  it("leaves out <Text> and other components, literals, calls, markup, attributes and children", () => {
    expect(count('const a = <Text as="span">{view.message}</Text>;')).toBe(0);
    expect(count("const a = <Link href={x}>{label}</Link>;")).toBe(0);
    expect(count('const a = <p>{" "}Plain words</p>;')).toBe(0);
    expect(count("const a = <ul>{xs.map((x) => <li key={x}>{x}</li>)}</ul>;")).toBe(1);
    expect(count("const a = <p>{ok ? <b>yes</b> : null}</p>;")).toBe(0);
    expect(count("const a = <p title={view.title}>Hi</p>;")).toBe(0);
    expect(count("const a = <section>{children}</section>;")).toBe(0);
    expect(count("const a = <>{view.title}</>;")).toBe(0);
  });
});

describe("the structure lint (wide-layout spec §3)", () => {
  it("counts a rule outside layout.css that sets display grid or flex, columns or wrapping", () => {
    expect(structureViolations(".a { display: grid; gap: 4px; }\n.b { display: flex; }\n.c { grid-template-columns: 1fr 1fr; }\n.d { flex-wrap: wrap; }")).toBe(4);
    expect(structureViolations(".rx, .z { display: grid; }\n.acts { flex-wrap: wrap; }")).toBe(2);
    expect(structureViolations(".e { display: inline-grid; } .f { display: -webkit-box; } .g { grid-column: 1 / -1; } .h { display: block; }")).toBe(0);
    expect(structureViolations("@media (min-width: 1px) { .i { display: grid; } }")).toBe(1);
  });
});

describe("the lints' ratchets (wide-layout spec §3)", () => {
  const baseline = JSON.parse(readFileSync(join(WEB, "test", "layout-baseline.json"), "utf8")) as Counts;
  const now = countViolations();

  for (const kind of ["text", "structure"] as const) {
    it(`no file's ${kind} count rises; a fall lowers the baseline in the same commit`, () => {
      const files = [...new Set([...Object.keys(now[kind]), ...Object.keys(baseline[kind])])];
      const rose = files.filter((f) => (now[kind][f] ?? 0) > (baseline[kind][f] ?? 0)).map((f) => `${f}: ${baseline[kind][f] ?? 0} -> ${now[kind][f]}`);
      expect(rose, kind === "text" ? "new written text goes through <Text>" : "new structure goes through a primitive (layout.css)").toEqual([]);
      const fell = files.filter((f) => (now[kind][f] ?? 0) < (baseline[kind][f] ?? 0)).map((f) => `${f}: ${baseline[kind][f]} -> ${now[kind][f] ?? 0}`);
      expect(fell, "a count fell: run `node app/web/scripts/layout-baseline.ts` and commit the lower baseline").toEqual([]);
    });
  }
});

describe("Train A's template (wide-layout spec §5)", () => {
  const text = stripComments(layoutCss);
  const train = cssRules(layoutCss).filter((r) => selectors(r).some((s) => s.startsWith(".cols.train")));

  it("is two regions below a 1,150 px screen, and three from it", () => {
    expect(train.some((r) => r.selector === ".cols.train" && /grid-template-areas:\s*"next list"\s*"next open"/.test(r.body))).toBe(true);
    expect(text).toMatch(/@container screen \(min-width: 1150px\)\s*\{\s*\.cols\.train\s*\{[^}]*grid-template-areas:\s*"next list open"/);
    expect(text).toMatch(/minmax\(0, 1\.3fr\) minmax\(260px, 300px\) minmax\(380px, 1fr\)/);
  });

  it("falls back to the template without a region that has nothing in it", () => {
    const noOpen = '.cols.train:not(:has(> [data-region="open"]))';
    const noNext = '.cols.train:not(:has(> [data-region="next"]))';
    const rule = (selector: string, at: string | null) => train.find((r) => r.selector === selector && r.at === at);
    const tracks = (r: { body: string } | undefined) => r?.body.match(/grid-template-columns:\s*([^;]+);/)?.[1]?.trim();
    const areas = (r: { body: string } | undefined) => r?.body.match(/grid-template-areas:\s*([^;]+);/)?.[1]?.trim();
    // No sessions: next and the list, the list at its designed track in each band (320 px and up below 1,150; 260–300 from it).
    expect([areas(rule(noOpen, null)), tracks(rule(noOpen, null))]).toEqual(['"next list"', "minmax(0, 1.25fr) minmax(320px, 1fr)"]);
    expect(tracks(rule(noOpen, "@container screen (min-width: 1150px)"))).toBe("minmax(0, 1.3fr) minmax(260px, 300px)");
    // No next session: the list, then the open session.
    expect([areas(rule(noNext, null)), tracks(rule(noNext, null))]).toEqual(['"list open"', "minmax(260px, 300px) minmax(0, 1fr)"]);
    // Neither: the list alone.
    expect([areas(rule(`${noNext}:not(:has(> [data-region="open"]))`, null)), tracks(rule(`${noNext}:not(:has(> [data-region="open"]))`, null))]).toEqual(['"list"', "minmax(0, 1fr)"]);
  });

  it("draws the prescriptions as a grid of 340 px cards that keep card width (`fill`), so a lone card never stretches", () => {
    const screen = readFileSync(join(src, "screens", "TrainScreen.tsx"), "utf8");
    expect(screen).toContain('<Grid wide={wide} min={340} gap={12} fill as="ol" className="rows">');
  });

  it("keeps the regions 24 px apart: no Train rule sets its own gap, so `.cols`' 24 px holds (the open session sits 24 px under the list below 1,150 px)", () => {
    expect(train.filter((r) => /(^|[\s;{])(row-|column-)?gap\s*:/.test(r.body)).map((r) => r.selector)).toEqual([]);
  });

  it("lists an open session's sets in two columns from a 560 px panel: a 536 px content box (560 less .rx's 12 px padding each side), reached at a 1,920 px window", () => {
    expect(text).toMatch(/@container open \(min-width: 536px\)\s*\{[^}]*columns:\s*2/);
    expect(cssRules(stylesCss).find((r) => r.selector === ".rx")?.body).toMatch(/padding:\s*12px;/);
  });
});

describe("Catalogue A (wide-layout spec §5)", () => {
  const list = createElement("p", null, "L");
  const go = () => undefined;

  it("draws the wide catalogue through Split: the list, then the record, Words keeping its two columns", () => {
    expect(html(createElement(Panes, { wide: true, pane: "foods", go, list, record: createElement("article", { className: "record" }, "R"), back: "Foods & recipes" }))).toBe(
      '<main class="screen catalogue"><div class="cols catalogue"><div class="col" data-region="list"><p>L</p></div><div class="col" data-region="record"><article class="record">R</article></div></div></main>',
    );
    expect(html(createElement(Panes, { wide: true, pane: "words", go, list, record: null, back: "Words I've learned" }))).toBe(
      '<main class="screen catalogue"><div class="cols catalogue words-cols"><div class="col" data-region="list"><p>L</p></div><div class="col" data-region="record"><p class="leftnote">Pick one from the list.</p></div></div></main>',
    );
  });

  it("sizes the list and the record under .cols.catalogue, and Words' two columns", () => {
    const rules = cssRules(layoutCss);
    expect(rules.find((r) => r.selector === ".cols.catalogue")?.body).toMatch(/grid-template-columns:\s*minmax\(260px, 320px\) minmax\(0, 1fr\)/);
    expect(rules.find((r) => r.selector === ".cols.catalogue.words-cols")?.body).toMatch(/grid-template-columns:\s*minmax\(0, 1\.25fr\) minmax\(320px, 1fr\)/);
  });
});

describe("Stack (wide-layout spec §3; built for Catalogue A's section cards)", () => {
  it("is exactly its element, or a fragment, on the phone, and a stack on a wide screen", () => {
    const p = createElement("p", null, "a");
    expect(html(createElement(Stack, { wide: false, gap: 8, as: "section", className: "rsec" }, p))).toBe('<section class="rsec"><p>a</p></section>');
    expect(html(createElement(Stack, { wide: false, gap: 8 }, p))).toBe("<p>a</p>");
    expect(html(createElement(Stack, { wide: true, gap: 8, as: "section", className: "rsec", "aria-label": "Words" }, p))).toBe('<section class="rsec l-stack g-8" aria-label="Words"><p>a</p></section>');
  });
});

describe("Catalogue A's record sections (wide-layout spec §5)", () => {
  const view: FoodView = {
    title: "Rice (cooked)", facts: "Cooked", per: "Per 100 g",
    macros: [{ key: "kcal", label: "kcal", value: "120" }, { key: "protein_g", label: "Protein", value: "2.4 g" }],
    micros: [{ key: "iron_mg", label: "Iron", value: "unknown" }, { key: "calcium_mg", label: "Calcium", value: "10 mg" }],
    measures: ["1 katori ≈ 150 g"], yields: ["3 g from 1 g dry"], price: "₹8 per 100 g", category: "Grain", tags: "staple", words: [],
  };
  const usedBy = createElement("section", { className: "used-by" }, "U");
  const words = createElement("section", { className: "words" }, "W");

  it("keeps the phone's values exactly as the desktop build drew them", () => {
    expect(html(createElement(FoodFacts, { view }))).toBe(
      '<table class="wide-table facts"><caption>Per 100 g</caption><thead><tr><th scope="col">kcal</th><th scope="col">Protein</th></tr></thead><tbody><tr><td>120</td><td>2.4 g</td></tr></tbody></table><dl class="micros"><div><dt>Iron</dt><dd class="unknown">unknown</dd></div><div><dt>Calcium</dt><dd>10 mg</dd></div></dl><p>Measures: 1 katori ≈ 150 g</p><p>Yields: 3 g from 1 g dry</p><p class="leftnote">₹8 per 100 g</p><p class="leftnote">Grain · staple</p>',
    );
  });

  it("draws a food's sections as cards in Catalogue A's order, Used by and Words among them", () => {
    const out = html(createElement(FoodSections, { view, usedBy, words }));
    expect([...out.matchAll(/<h3>([^<]+)<\/h3>|class="(used-by|words)"/g)].map((m) => m[1] ?? m[2])).toEqual(["Per 100 g", "Micronutrients", "Measures and yields", "used-by", "words", "Price and tags"]);
    expect(out).toContain('<section class="rsec l-stack g-8" aria-label="Per 100 g"><h3>Per 100 g</h3><table class="wide-table facts"><thead>');
  });

  it("leaves out a card with nothing to show", () => {
    const bare = { ...view, measures: [], yields: [], price: null, category: null, tags: null };
    expect(html(createElement(FoodSections, { view: bare, usedBy, words }))).not.toMatch(/Measures and yields|Price and tags/);
  });

  it("draws a section card as a labelled stack: its h3 heading, then its content", () => {
    expect(html(createElement(RecordSection, { title: "Lines", children: createElement("p", null, "x") }))).toBe('<section class="rsec l-stack g-8" aria-label="Lines"><h3>Lines</h3><p>x</p></section>');
  });

  it("lays a recipe's Lines across the section grid's full width on a wide screen, like an open edit; a food's cards keep one track each", () => {
    expect(html(createElement(RecordSection, { title: "Lines", span: true, children: createElement("p", null, "x") }))).toBe('<section class="rsec rsec-span l-stack g-8" aria-label="Lines"><h3>Lines</h3><p>x</p></section>');
    const spanning = cssRules(layoutCss).filter((r) => /grid-column:\s*1\s*\/\s*-1/.test(r.body)).flatMap(selectors);
    expect(spanning).toContain(".app.wide .record-sections > :is(.edit-form, .rsec-span)");
    const recipe = readFileSync(join(src, "components", "catalogue", "RecipeRecord.tsx"), "utf8");
    expect(recipe).toMatch(/<RecordSection title="Lines" span>/);
    expect(html(createElement(FoodSections, { view, usedBy, words }))).not.toContain("rsec-span");
    expect(readFileSync(join(src, "components", "catalogue", "FoodRecord.tsx"), "utf8")).not.toMatch(/<RecordSection[^>]*\bspan\b/);
  });
});

describe("Today B's template (wide-layout spec §5)", () => {
  const text = stripComments(layoutCss);
  const today = cssRules(layoutCss).filter((r) => selectors(r).some((s) => s.startsWith(".cols.today")));

  it("is two columns below a 1,500 px screen, and three from it, with the rail's macros two across", () => {
    expect(today.some((r) => r.selector === ".cols.today" && /grid-template-areas:\s*"rail house"\s*"meals house"\s*"tail house"/.test(r.body))).toBe(true);
    expect(text).toMatch(/@container screen \(min-width: 1500px\)\s*\{\s*\.cols\.today\s*\{[^}]*grid-template-areas:\s*"rail meals house"\s*"tail meals house"/);
    expect(text).toMatch(/minmax\(300px, 340px\) minmax\(0, 1fr\) minmax\(360px, 0\.8fr\)/);
    expect(text).toMatch(/\[data-region="rail"\] \.macros\s*\{[^}]*grid-template-columns:\s*repeat\(2, minmax\(0, 1fr\)\)/);
    // Two across only inside the 1,500 px query: four across below it, as the phone and the desk draw them.
    const macros = today.filter((r) => r.selector === '.cols.today > [data-region="rail"] .macros');
    expect(macros.map((r) => r.at)).toEqual(["@container screen (min-width: 1500px)"]);
  });

  it("falls back to the template without the tail when it has nothing in it (another member's day with no footer)", () => {
    const noTail = '.cols.today:not(:has(> [data-region="tail"]))';
    const rule = (at: string | null) => today.find((r) => r.selector === noTail && r.at === at);
    const prop = (r: { body: string } | undefined, name: string) => r?.body.match(new RegExp(`${name}:\\s*([^;]+);`))?.[1]?.trim();
    const read = (r: { body: string } | undefined) => [prop(r, "grid-template-areas"), prop(r, "grid-template-columns"), prop(r, "grid-template-rows")];
    expect(read(rule(null))).toEqual(['"rail house" "meals house"', "minmax(0, 1.25fr) minmax(360px, 1fr)", "auto 1fr"]);
    expect(read(rule("@container screen (min-width: 1500px)"))).toEqual(['"rail meals house"', "minmax(300px, 340px) minmax(0, 1fr) minmax(360px, 0.8fr)", "auto"]);
  });

  it("leaves the tail out when there is no footer row: the footer part is null, not an element that draws nothing", () => {
    const screen = readFileSync(join(src, "screens", "TodayScreen.tsx"), "utf8");
    expect(screen).toMatch(/footer:\s*view\.footer\.length > 0 \? <Footer [^>]*\/> : null/);
  });

  it("shows a tier's numbers from 520 px", () => {
    expect(text).toMatch(/@container tier \(min-width: 520px\)/);
  });
});
