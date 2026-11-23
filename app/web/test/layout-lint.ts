/**
 * The layout system's two lints (wide-layout spec §3), as source tokenizers:
 * - text: in screens/ and components/, a JSX child that reads a variable
 *   straight into an intrinsic element (`<span>{row.cue}</span>`) must go
 *   through <Text>;
 * - structure: outside layout.css, a rule that sets display: grid|flex,
 *   grid-template-columns or flex-wrap is counted.
 * Both are ratchets: today's counts per file are test/layout-baseline.json,
 * and `scripts/layout-baseline.ts` only ever lowers them. The TSX is parsed
 * with the parser Vite already ships (oxc), so no dependency is added.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { parseSync } from "vite";
import { cssRules } from "./css.ts";

/** The app/web directory. */
export const WEB = join(import.meta.dirname, "..");

type Node = { type: string; [key: string]: unknown };
const isNode = (v: unknown): v is Node => typeof v === "object" && v !== null && typeof (v as { type?: unknown }).type === "string";

/** `children` (or `props.children`) is composition, not text. */
function isChildren(e: Node): boolean {
  if (e.type === "Identifier") return e.name === "children";
  if (e.type === "MemberExpression" && !e.computed && isNode(e.property)) return e.property.name === "children";
  return false;
}

/** Reads a variable as text: a name, a member, an optional chain, a template with a value in it, or `a ?? b` / `a || b` led by one. */
function readsText(e: Node): boolean {
  if (e.type === "Identifier" || e.type === "MemberExpression" || e.type === "ChainExpression") return !isChildren(e);
  if (e.type === "TemplateLiteral") return Array.isArray(e.expressions) && e.expressions.length > 0;
  if (e.type === "LogicalExpression") return isNode(e.left) && readsText(e.left);
  return false;
}

/** How many text-lint violations one TSX source has. */
export function textViolations(file: string, source: string): number {
  const { program, errors } = parseSync(file, source);
  if (errors.length > 0) throw new Error(`${file}: ${errors[0]?.message}`);
  let count = 0;
  const visit = (node: unknown, parent: Node | null): void => {
    if (Array.isArray(node)) {
      for (const child of node) visit(child, parent);
      return;
    }
    if (!isNode(node)) return;
    if (node.type === "JSXExpressionContainer" && parent?.type === "JSXElement" && (parent.children as unknown[]).includes(node)) {
      const name = (parent.openingElement as Node).name as Node;
      if (name.type === "JSXIdentifier" && /^[a-z]/.test(String(name.name)) && isNode(node.expression) && readsText(node.expression)) count++;
    }
    for (const [key, value] of Object.entries(node)) if (key !== "parent" && typeof value === "object") visit(value, node);
  };
  visit(program, null);
  return count;
}

const STRUCTURE = /(^|;)\s*(display\s*:\s*(grid|flex)\b|grid-template-columns\s*:|flex-wrap\s*:)/;

/** How many structure-lint violations one stylesheet has. */
export function structureViolations(css: string): number {
  return cssRules(css).filter((r) => STRUCTURE.test(r.body)).length;
}

/** Every file under `dir` ending in `ext`: the one source walker (the lints here, overflow.test.ts's inline-style check). */
export function sourceFiles(dir: string, ext: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? sourceFiles(join(dir, e.name), ext) : e.name.endsWith(ext) ? [join(dir, e.name)] : []));
}

export interface Counts {
  text: Record<string, number>;
  structure: Record<string, number>;
}

/** Each lint's count per file (relative to app/web), files with none left out. */
export function countViolations(): Counts {
  const text: Record<string, number> = {};
  for (const f of [...sourceFiles(join(WEB, "src", "components"), ".tsx"), ...sourceFiles(join(WEB, "src", "screens"), ".tsx")].sort()) {
    const n = textViolations(f, readFileSync(f, "utf8"));
    if (n > 0) text[relative(WEB, f)] = n;
  }
  const structure: Record<string, number> = {};
  for (const f of sourceFiles(join(WEB, "src"), ".css").sort()) {
    if (f === join(WEB, "src", "components", "layout", "layout.css")) continue;
    const n = structureViolations(readFileSync(f, "utf8"));
    if (n > 0) structure[relative(WEB, f)] = n;
  }
  return { text, structure };
}
