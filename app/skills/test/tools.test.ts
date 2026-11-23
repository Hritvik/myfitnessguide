// The skills may only name MCP tools that exist. The tool list is built the
// way the MCP server builds it at startup: the Worker's own registry, listed
// by describeTools() (what GET /tools serves) and passed through the MCP
// server's toMcpTool(). No network: the live list is pinned in live-tools.txt.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { TOOLS } from "../../worker/src/tools";
import { describeTools } from "../../worker/src/tool";
import { servesTool, toMcpTool, UNATTENDED_WRITES } from "../../mcp/src/tools.ts";
import type { ApiTool } from "../../mcp/src/api.ts";

const here = dirname(fileURLToPath(import.meta.url));
const skillsRoot = join(here, "..");
const appRoot = join(skillsRoot, "..");

/** Staged here until cutover; after cutover the skills live in the plugin. */
function skillDir(name: string): string {
  const staged = join(skillsRoot, name);
  return existsSync(staged) ? staged : join(appRoot, "..", "myfitnessguide", "skills", name);
}

const mcpTools = (describeTools(TOOLS) as ApiTool[]).map(toMcpTool);
const toolNames = new Set(mcpTools.map((t) => t.name));

function markdownFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return markdownFiles(path);
    return name.endsWith(".md") ? [path] : [];
  });
}

/** Every file the model reads at runtime, plus the hand-check list that names tools. */
const skillFiles = [
  ...markdownFiles(skillDir("gym-training")),
  ...markdownFiles(skillDir("gym-nutrition")),
  ...markdownFiles(skillDir("gym-inbox")),
];
const checkedFiles = [...skillFiles, join(here, "checklist.md")];

/** Field names, enum values and consts anywhere in the tool schemas. */
function schemaVocabulary(): Set<string> {
  const words = new Set<string>();
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (!node || typeof node !== "object") return;
    const obj = node as Record<string, unknown>;
    if (obj.properties && typeof obj.properties === "object") {
      for (const key of Object.keys(obj.properties)) words.add(key);
    }
    if (Array.isArray(obj.enum)) for (const v of obj.enum) if (typeof v === "string") words.add(v);
    if (typeof obj.const === "string") words.add(obj.const);
    Object.values(obj).forEach(walk);
  };
  mcpTools.forEach((t) => walk(t.inputSchema));
  return words;
}

/** The curated views `query` may read. */
function viewNames(): Set<string> {
  const dir = join(appRoot, "worker", "migrations");
  const names = new Set<string>();
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".sql"))) {
    for (const m of readFileSync(join(dir, file), "utf8").matchAll(/CREATE VIEW (?:IF NOT EXISTS )?(v_[a-z0-9_]+)/g)) {
      names.add(m[1]!);
    }
  }
  return names;
}

/**
 * Words the skills put in backticks that are neither tools nor schema
 * vocabulary: result fields and statuses the tools return, and skill names.
 * Each one was checked against the Worker's responses.
 */
const RESULT_VOCABULARY = new Set([
  "needs_clarification",
  "prescribed",
  "record_only",
  "layoff_policy",
  "gaps",
  "snap",
  "offer",
  "implausible",
  "fired",
  "not_yet",
  "never",
  "cue",
  "idea",
  "gym-training",
  "gym-nutrition",
  "gym-inbox",
  "myfitnessguide",
  "rir_needed",
  "needs_confirmation",
  "confirm_set_ids",
  "raise",
  "affected_prescriptions",
  "ref_exists",
  "energy_mismatch",
  "bodyweight_dominant", // an exercise field, changed with amend (returned in its `after`)
  "ask", // inventory_gaps: the one chunk to ask about this session
  "read_from", // log_set: the stated load when it was read in its native unit
  "unit_unclear", // the clarification for a load clean in both units or neither
  "bar_value", // implement fields, changed with amend (a bar's or sled's weight)
  "bar_unit",
  "alias_taken", // learn_alias: the word already means something else
  "inbox", // the origin an unattended run must write with
  "other_member", // route_text: a line naming another member (input.ts UnresolvedReason)
  "truncated", // inbox_entries: more than 100 entries matched
  "not_pending", // resolve_inbox_entry: the entry is already closed (409)
  "unattended", // whoami in an unattended MCP server: the reply's `unattended: true` (MCP decision 21)
  "idempotency_key_reused", // any write: the key was used for a different request (409); an unattended rerun stops on that entry
  "created_by", // inbox_entries: the member who sent an entry (worker decision 157)
  "implausible_reading", // log_reading / amend of a reading: the value is implausible; answered with implausible_ok
  "unknown_items", // day_totals / what_if / day_meals: how many items a sum leaves out (worker decision 158)
  "known", // a nutrient's coverage: the parts known of `of`
  "of",
  "value_coverage", // analytics: known metric values among the logged rows in a bucket
  "prep_schedule", // preview_meal_plan / save_meal_plan: the dated tasks a plan derives
  "next_prep", // log_intake / household_meal: the tasks due now for the member
]);

const vocabulary = new Set([...schemaVocabulary(), ...viewNames(), ...RESULT_VOCABULARY]);

/** Identifier-shaped spans in backticks: `log_set`, `origin`. */
function backticked(text: string): string[] {
  return [...text.matchAll(/`([^`\n]+)`/g)].map((m) => m[1]!).filter((s) => /^[a-z][a-z0-9_-]*$/.test(s));
}

const read = (path: string) => readFileSync(path, "utf8");
const rel = (path: string) => relative(appRoot, path);

describe("the MCP tool list", () => {
  test("is the pinned list (live-tools.txt: the deployed API's, plus tools not yet deployed)", () => {
    const live = read(join(here, "live-tools.txt"))
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#"));
    expect([...toolNames].sort()).toEqual([...live].sort());
  });

  test("marks every write with idempotency_key, speaker and origin", () => {
    for (const t of mcpTools.filter((t) => t.description?.startsWith("WRITE") || "idempotency_key" in (t.inputSchema.properties ?? {}))) {
      expect(t.inputSchema.required, t.name).toEqual(expect.arrayContaining(["idempotency_key", "speaker", "origin"]));
    }
  });
});

// Ticket 78: the unattended server (MCP decision 21), checked against the Worker's own registry.
describe("the unattended MCP server", () => {
  const listing = describeTools(TOOLS) as ApiTool[];
  const writes = listing.filter((t) => t.write).map((t) => t.name);
  const hidden = listing.filter((t) => !servesTool(t, "unattended")).map((t) => t.name);

  test("keeps only writes the Worker has", () => {
    expect([...UNATTENDED_WRITES].filter((n) => !writes.includes(n))).toEqual([]);
  });

  test("hides every write that confirms, rejects, teaches or edits the catalogue, and no read", () => {
    const mustHide = [
      "mark_remainder", "log_set", "log_workout", "log_cardio", "start_session",
      "confirm", "reject", "retract", "amend", "learn_alias", "forget_alias",
      "upsert_food_source", "upsert_recipe", "update_recipe", "set_recipe_archived", "add_measure", "add_yield", "add_recipe_line", "remove_recipe_line",
      "add_cook_line", "remove_cook_line", "create_workout", "update_workout", "set_workout_archived", "add_workout_line", "remove_workout_line", "save_session_as_workout",
      "end_session", "submit_to_inbox",
    ];
    expect(mustHide.filter((n) => !hidden.includes(n))).toEqual([]);
    expect(hidden.filter((n) => !writes.includes(n))).toEqual([]);
  });

  test("gym-inbox's Unattended runs section names only tools that server serves", () => {
    const text = read(join(skillDir("gym-inbox"), "SKILL.md"));
    const section = /## Unattended runs\n([\s\S]*?)(?=\n## |$)/.exec(text)?.[1] ?? "";
    expect(section.length).toBeGreaterThan(0);
    const served = new Set(listing.filter((t) => servesTool(t, "unattended")).map((t) => t.name));
    // `confirm` is named only as the fail-safe probe: its presence means an interactive server.
    expect(backticked(section).filter((w) => toolNames.has(w) && !served.has(w) && w !== "confirm")).toEqual([]);
    expect(served.has("confirm")).toBe(false);
  });
});

describe.each(checkedFiles.map((f) => [rel(f), f]))("%s", (_name, file) => {
  const text = read(file);

  test("names no tool that doesn't exist", () => {
    const unknown = backticked(text).filter((w) => !toolNames.has(w) && !vocabulary.has(w));
    expect(unknown, "backticked identifiers that are neither MCP tools nor schema/result vocabulary").toEqual([]);
  });

  test("calls nothing that isn't a tool", () => {
    const calls = [...text.matchAll(/`([a-z][a-z0-9_]*)\(/g)].map((m) => m[1]!);
    expect(calls.filter((c) => !toolNames.has(c))).toEqual([]);
  });
});

describe.each(skillFiles.map((f) => [rel(f), f]))("%s", (_name, file) => {
  test("holds no Sheets mechanics or local scripts", () => {
    expect(read(file)).not.toMatch(/gymcalc|spreadsheet|google sheet|\bsheets?\b|config\.yml|mirror|pending file|read it back|<base>/i);
  });
});

describe("each skill", () => {
  const skill = (name: string) => read(join(skillDir(name), "SKILL.md"));
  const allOf = (name: string) => markdownFiles(skillDir(name)).map(read).join("\n");

  test.each(["gym-training", "gym-nutrition", "gym-inbox"])("%s has frontmatter naming it, and a description", (name) => {
    const fm = /^---\nname: ([^\n]+)\ndescription: ([^\n]+)\n---\n/.exec(skill(name));
    expect(fm?.[1]).toBe(name);
    expect(fm?.[2]!.length).toBeGreaterThan(100);
  });

  test.each([
    ["gym-training", ["active_session", "start_session", "log_set", "end_session", "next_prescription", "programme", "create_programme", "update_programme", "set_programme_archived", "upsert_phase", "set_phase_archived", "member_notes", "check_progression", "programme_change", "substitute", "inventory", "remove_implement_load", "staleness", "set_measurement_cadence", "lift_history", "workouts", "create_workout", "update_workout", "set_workout_archived", "analytics", "query", "confirm", "reject", "amend"]],
    ["gym-nutrition", ["household_meal", "household_planning_context", "preview_meal_plan", "save_meal_plan", "meal_plan", "set_meal_plan_archived", "log_intake", "day_totals", "day_items", "day_cooks", "what_if", "targets", "set_target", "member_notes", "catalogue_search", "catalogue_lookup", "upsert_food_source", "upsert_recipe", "update_recipe", "set_recipe_archived", "add_measure", "add_yield", "add_recipe_line", "remove_recipe_line", "catalogue_dependents", "mark_remainder", "set_day_status", "analytics", "query", "confirm", "reject", "amend"]],
    ["gym-inbox", ["inbox_entries", "resolve_inbox_entry", "catalogue_search", "catalogue_lookup", "what_if", "log_intake", "household_meal", "mark_remainder", "log_set", "log_workout", "upsert_food_source", "learn_alias"]],
  ] as const)("%s routes its intents to the tools", (name, tools) => {
    const words = new Set(backticked(allOf(name)));
    expect(tools.filter((t) => !words.has(t))).toEqual([]);
  });

  test.each(["gym-training", "gym-nutrition", "gym-inbox"])("%s states the write fields and the clarification rule", (name) => {
    const text = skill(name);
    for (const w of ["idempotency_key", "speaker", "origin", "needs_clarification", "same key", "48 h"]) expect(text).toContain(w);
  });

  test("gym-inbox asks before confirming the speaker's own entries, and never confirms unattended", () => {
    const text = skill("gym-inbox");
    expect(text).toMatch(/ask before logging it/i);
    expect(text).toMatch(/never confirm/i);
    expect(text).toContain("origin `inbox`");
    expect(text).toContain("`replace` only");
  });

  // Ticket 78 step 2 and its review: a scheduled run checks its server, then drafts an entry all or
  // nothing in one write; an unclear entry stays pending.
  test("gym-inbox's unattended run checks its server, writes an entry all or nothing in one call, and leaves the rest pending", () => {
    const section = /## Unattended runs\n([\s\S]*?)(?=\n## |$)/.exec(skill("gym-inbox"))?.[1] ?? "";
    expect(section.trimStart()).toMatch(/^If `confirm` is among your tools, this is not an unattended server:\s+stop and write nothing\./);
    expect(section).toMatch(/call `whoami` before anything else;\s+unless its reply carries `unattended: true`, stop and write nothing/);
    expect(section).toMatch(/confirms\s+by itself after 48 h unless the member confirms, changes or rejects it/);
    expect(section).toMatch(/never confirm, never learn words, never add foods/i);
    expect(section).toMatch(/All or nothing, one write per entry/);
    expect(section).toMatch(/only when\s+every span in it needs no question/);
    expect(section).toMatch(/known food or a learned word/);
    expect(section).toMatch(/amount in the text/);
    expect(section).toMatch(/plain owner/);
    expect(section).toMatch(/Everything goes in one call/);
    expect(section).toMatch(/write nothing and leave it pending/);
    expect(section).toMatch(/`needs_clarification`[^.]*means nothing\s+was written: leave the entry pending/);
    for (const preview of ["what_if", "preview_meal"]) expect(section).toContain(`\`${preview}\``);
    expect(section).toContain("`inbox-<entry id>-write`");
    expect(section).toContain("`inbox-<entry id>-close`");
    expect(section).toContain('"drafted by the scheduled run"');
    expect(section).toMatch(/never members' names or an entry's text/);
    // Training and leftovers are for a hand run (review C1, C2).
    for (const dropped of ["log_set", "log_workout", "log_cardio", "mark_remainder", "preview_set"]) expect(section).not.toContain(`\`${dropped}\``);
  });

  test("gym-inbox's loop points a scheduled run at its own section", () => {
    const loop = /## The loop\n([\s\S]*?)\n1\. /.exec(skill("gym-inbox"))?.[1] ?? "";
    expect(loop).toMatch(/In a scheduled run, read "Unattended runs" below first/);
  });

  test("gym-inbox never quotes a sender's text into another member's records (worker decision 157)", () => {
    const text = skill("gym-inbox");
    expect(text).toContain("`created_by`");
    expect(text).toMatch(/own\s+neutral\s+words/i);
    expect(text).toMatch(/never\s+quote\s+the\s+sender's\s+text/i);
  });

  test("gym-training never prescribes for a record-only member", () => {
    expect(skill("gym-training")).toMatch(/never prescribe/i);
    expect(skill("gym-training")).toContain("record_only");
  });

  // Ticket 27 closed these backend gaps; the workarounds the skills held must not come back.
  test.each([
    ["gym-training", /no tool to remove a\s+load|don't quote it as progress|overdue per the member's notes/i],
    ["gym-training", /bulk[^.]*rather than numbers the member gave/i],
    ["gym-nutrition", /pick a ref nobody uses|replaced\*{0,2} whole|latest ref/i],
  ] as const)("%s holds no workaround for a closed backend gap (%s)", (name, pattern) => {
    expect(allOf(name)).not.toMatch(pattern);
  });

  test("gym-training logs a bulk-reported set as inferred, and asks on needs_confirmation", () => {
    const text = allOf("gym-training");
    expect(text).toContain("reps_inferred: true");
    expect(text).toContain("`needs_confirmation`");
  });

  test("gym-nutrition lets the API allocate refs and puts an energy mismatch to the member", () => {
    const text = allOf("gym-nutrition");
    expect(text).toMatch(/leave `ref` out/);
    expect(text).toContain("`energy_mismatch`");
  });

  // Click test P2-19 (Hritvik, 8 Oct 2026): notes, cues and flags were stored as all-caps essays.
  test.each(["gym-training", "gym-nutrition"])("%s writes notes, cues and flags in sentence case, keeping acronyms", (name) => {
    const text = skill(name);
    expect(text).toMatch(/sentence\s+case/i);
    expect(text).toMatch(/never\s+in\s+(all\s+)?capitals/i);
    for (const a of ["RIR", "BMR", "e1RM"]) expect(text).toContain(a);
  });

  // Review of ticket 68: a set's template can start a second session on a day.
  test("gym-training passes session_id to log_set when a day has two sessions", () => {
    expect(skill("gym-training")).toMatch(/two strength sessions[^.]*`session_id`[^.]*`start_session`[^.]*`sessions`/s);
  });

  test("gym-nutrition keeps an absent member distinct from a portion of 0", () => {
    expect(skill("gym-nutrition")).toMatch(/wasn't there gets no portion/);
  });
});
