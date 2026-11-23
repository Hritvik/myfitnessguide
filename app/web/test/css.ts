/** Reading a stylesheet in tests: its comments removed, and every innermost rule (a rule inside @media or @container counts as its own). */
export function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, "");
}

export interface CssRule {
  selector: string;
  body: string;
  /** The innermost at-rule around it ("@media (min-width: 1920px)", "@container screen (min-width: 1150px)"), or null. */
  at: string | null;
}

/** The one CSS reader the tests share (overflow.test.ts, layout-system.test.ts, layout-lint.ts). */
export function cssRules(css: string): CssRule[] {
  const text = stripComments(css);
  const out: CssRule[] = [];
  const open: { selector: string; from: number }[] = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "{") {
      open.push({ selector: text.slice(start, i).trim(), from: i + 1 });
      start = i + 1;
    } else if (c === "}") {
      const top = open.pop();
      const body = top ? text.slice(top.from, i) : "";
      const at = [...open].reverse().find((o) => o.selector.startsWith("@"))?.selector ?? null;
      if (top && !body.includes("{")) out.push({ selector: top.selector, body, at });
      start = i + 1;
    } else if (c === ";" && open.length === 0) {
      start = i + 1;
    }
  }
  return out;
}

/** A rule's selector list, one selector each: split only at top-level commas, so `:is(.a, .b)` stays whole. */
export function selectors(r: CssRule): string[] {
  const out: string[] = [];
  let depth = 0;
  let from = 0;
  for (let i = 0; i < r.selector.length; i++) {
    const c = r.selector[i];
    if (c === "(") depth++;
    else if (c === ")") depth--;
    else if (c === "," && depth === 0) {
      out.push(r.selector.slice(from, i).trim());
      from = i + 1;
    }
  }
  out.push(r.selector.slice(from).trim());
  return out;
}
