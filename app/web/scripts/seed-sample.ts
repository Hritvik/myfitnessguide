/**
 * `npm run seed:sample -w @myfitnessguide/web`: builds an invented household
 * (Asha, Kabir, Noor) in a separate local D1 at app/worker/.wrangler/sample,
 * for screenshots that may be committed. It never touches the real local
 * data in .wrangler/state, and never the remote database. `--persist <dir>`
 * puts the D1 elsewhere (the browser suite seeds into its run directory);
 * `--port <n>` fixes the Worker's port (by default the OS picks one).
 *
 * One Worker serves the whole seed: the dev-only entry
 * (app/worker/src/dev-entry.ts), each call signed in as its member by the
 * X-Local-Identity header and this run's token (e2e spec §3). The seed
 * writes relative to the Worker's today. `--fixed-clock` (the browser suite
 * passes it) runs that Worker on the test household's fixed clock
 * (scripts/test-clock.ts; worker decision 162), so every date and time the
 * seed writes is the same on every run; without it (a hand-seeded sample for
 * `npm run dev -- --sample`), today is today. `--seeded-on <file>` writes the
 * date its Worker reported into that file once the seed has finished (the
 * suite's run verdict checks it against the fixed date).
 *
 * Asha's own day is written as Asha (confirmed); the shared pot and one
 * snack are written as Kabir, so they are drafts about Asha "logged by
 * Kabir", the way a real household's would be.
 *
 * `--long` builds the same household in app/worker/.wrangler/sample-long
 * with long values wherever a member can type or the agent writes (names,
 * cues and notes of several hundred characters, some in capitals, some with
 * unbroken tokens; long reasons and Tell Claude texts), and the stress shapes
 * of the wide-layout spec §7: many (40 foods, one used by six recipes, 25
 * sessions: 23 here and the base sample's 2; an 11-item dinner, six
 * leftovers, eight Tell Claude texts), empty
 * (Kabir with no target, sessions or readings; no priced item logged; no day
 * closed complete; an item of unknown kcal and protein) and short (one-word
 * food and recipe names, a two-letter gym). It is the data
 * `scripts/sweep-layout.ts` checks the layout against. Invented text only.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { CANARIES, canariesMissing, NUMBERS, numbersNotOnce, type CanaryMember, type TextCanary } from "./canaries.ts";
import { openD1 } from "./d1-file.ts";
import { identityHeaders, newToken, reapStale, startDevWorker, WORKER as worker } from "./dev-worker.ts";
import { FIXED_DAY, FIXED_NOW } from "./test-clock.ts";
import { argValue, checkPersist, parsePort } from "./seed-args.ts";

const argv = process.argv.slice(2);
const LONG = argv.includes("--long");
/** --fixed-clock: the test household's fixed instant (the browser suite's seed); else the wall clock. */
const FIXED_CLOCK = argv.includes("--fixed-clock");
/**
 * Where the sample's D1 lives: --persist <dir> (absolute, or relative to
 * app/worker), else .wrangler/sample(-long). The seed deletes it first, so it
 * must be under app/worker/.wrangler (never .wrangler/state) or the temp
 * directory, unless --persist-anywhere.
 */
const PERSIST_DIR = checkPersist(argValue(argv, "persist") ?? (LONG ? ".wrangler/sample-long" : ".wrangler/sample"), { worker, anywhere: argv.includes("--persist-anywhere") });
/** --port <n>: the Worker's port; by default the OS picks one (nothing assumes 8787, 8788 or 8790 is free). */
const PORT = parsePort(argValue(argv, "port"));
/** --seeded-on <file>: where to record the Worker's today once the seed has finished (the browser suite's verdict reads it). */
const SEEDED_ON = argValue(argv, "seeded-on");
const TOKEN = newToken();
const EMAIL = { Asha: "asha@example.com", Kabir: "kabir@example.com", Noor: "noor@example.com" } as const;
type Who = keyof typeof EMAIL;

function wrangler(args: string[]): void {
  const r = spawnSync("npx", ["wrangler", ...args, "--local", "--persist-to", PERSIST_DIR], { cwd: worker, stdio: "inherit", env: { ...process.env, CI: "1" } });
  if (r.status !== 0) throw new Error(`wrangler ${args.join(" ")} failed`);
}

let API = "";
let seq = 0;
/** A tool call as `as` (Asha unless named), signed in by the header against the one Worker. */
async function call(tool: string, input: Record<string, unknown>, write = true, as: Who = "Asha"): Promise<Record<string, unknown>> {
  const body = write ? { ...input, idempotency_key: `sample-${TOKEN.slice(0, 12)}-${++seq}` } : input;
  const response = await fetch(`${API}/${tool}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...identityHeaders(EMAIL[as], TOKEN) },
    body: JSON.stringify(body),
  });
  const out = (await response.json()) as Record<string, unknown>;
  if (out.status !== "ok") throw new Error(`${tool} as ${as}: ${JSON.stringify(out)}`);
  return out;
}

const food = (name: string, state: string, per: number, unit: "g" | "ml", kcal: number, p: number, c: number, f: number, measures?: { name: string; amount: number }[]) => ({
  name, state, reference_amount: per, reference_unit: unit, kcal, protein_g: p, carbs_g: c, fat_g: f, ...(measures ? { measures } : {}),
});

/** A value in the default sample, or its long form under --long. */
const L = <T>(short: T, long: T): T => (LONG ? long : short);
/** A string as an SQL literal. */
const q = (s: string | null) => (s === null ? "NULL" : `'${s.replaceAll("'", "''")}'`);
/** The stress household's one-word foods (wide-layout spec §7, "many" and "short"): invented values per 100 g as sold. */
const ONE_WORD_FOODS: readonly [name: string, kcal: number, protein: number, carbs: number, fat: number][] = [
  ["Ragi", 330, 7, 72, 1.5], ["Bajra", 360, 11, 67, 5], ["Jowar", 350, 10, 72, 2], ["Moong", 345, 24, 60, 1.2], ["Chana", 360, 20, 61, 5],
  ["Urad", 340, 25, 59, 1.6], ["Toor", 340, 22, 62, 1.5], ["Besan", 385, 22, 58, 6.5], ["Suji", 355, 11, 73, 1], ["Makhana", 350, 10, 77, 0.5],
  ["Peanuts", 609, 26, 16, 49], ["Almonds", 622, 21, 22, 50], ["Walnuts", 701, 15, 14, 65], ["Cashews", 588, 18, 30, 44], ["Dates", 314, 2.5, 75, 0.4],
  ["Banana", 99, 1.1, 23, 0.3], ["Apple", 59, 0.3, 14, 0.2], ["Papaya", 49, 0.5, 11, 0.3], ["Guava", 75, 2.6, 14, 1], ["Orange", 52, 0.9, 12, 0.1],
  ["Spinach", 30, 2.9, 3.6, 0.4], ["Methi", 49, 4.4, 6, 0.9], ["Okra", 37, 1.9, 7, 0.2], ["Brinjal", 30, 1, 6, 0.2], ["Carrot", 45, 0.9, 10, 0.2],
  ["Beetroot", 48, 1.6, 10, 0.2], ["Cabbage", 30, 1.3, 6, 0.1], ["Tofu", 153, 15, 3, 9], ["Soya", 345, 52, 33, 0.5],
];
const N = {
  noor: L("Noor", "Noor Fatima Venkataraman-Siddiqui"),
  gym: L("Sample gym", "Sample gym: the basement floor of the community centre behind the long market road (use the second entrance after 8 pm)"),
  bar: L("Olympic bar", "Olympic bar (the one with the slightly bent sleeve and worn knurling on the left side)"),
  stack: L("Row stack", "Row stack on the seated cable station by the window, pin weights only"),
  dumbbells: L("Dumbbells", "Dumbbells, the hex rubber set on the lower rack (the 16s are often missing)"),
  bench: L("Barbell bench press", "Barbell bench press, flat bench, competition grip, paused on the chest every rep"),
  row: L("Cable row", "Seated cable row with the wide neutral-grip attachment (machine by the window)"),
  goblet: L("Goblet squat", "Goblet squat to a box, heels on plates, dumbbell held vertically against the sternum"),
  pushup: L("Push-up", "Push-up on the handles, deficit, chest to the floor"),
  programme: L("Base", "Base block: three-day rotation rebuilt after the equipment change at the basement gym"),
  template: L("Upper A", "Upper A (heavy press and pull, the long day)"),
  phase: L("Cut 1", "Cut 1: slow waist-first deficit through the wedding season"),
  intent: L("Bring the waist down", "Bring the waist down by about four centimetres without losing any bench strength; hold protein at or above 140 g every day, including travel days and festival weeks."),
  cueBench: L(
    "Pause on the chest, feet planted.",
    "EQUIPMENT CHANGED 1 OCT 2026: FIXED BARS ARE ABANDONED, THIS LIFT MOVES TO A LOADABLE BARBELL WITH MIXED KG AND LB PLATES. The programme has warned since calibration that pre-weighted bars would cap progression; that cap has now been hit and measured. Pause a full second on the chest, feet planted flat, shoulder blades pinned, and stop the set when the bar speed visibly slows: you are 2-3 reps from failure there. LOAD RECALIBRATED 39->52kg,+33% after the test day; see https://example.com/sample/programme/notes/bench-recalibration-2026-10-01-full-write-up-with-videos for the write-up. Reference SL20260915BENCHRECALIBRATIONREFERENCE88123ABCDEFGHIJKLMNOP.",
  ),
  fallbackBench: L(
    "Dumbbell press if the bench is taken.",
    "If the flat bench is taken for more than five minutes, do the dumbbell press on the adjustable bench at the same rep range and RIR, starting two dumbbell steps below the usual working weight; log it as the substitute, never as the barbell lift, so the progression rule does not read it. IF BOTH BENCHES ARE TAKEN, DO PUSH-UPS ON THE HANDLES INSTEAD AND SAY SO.",
  ),
  cueRow: L(
    "Chest up; pull to the navel.",
    "Chest up and tall, pull the handle to the navel, elbows brushing the ribs, a one-second squeeze at the back, and a slow two-second return with no rocking from the hips. STACK PINNED AT 40 KG MEANS THE NEXT STEP IS UNVERIFIED: ASK AT THE DESK WHETHER THE 45 KG PIN WORKS BEFORE LOADING IT. Rest the full two minutes even when it feels easy. Pairs-with-the-lat-pulldown-on-Upper-B-and-never-with-the-face-pull-superset.",
  ),
  oats: L("Oats", "Rolled oats, old-fashioned, the large blue pack from the wholesale store on the ring road"),
  whey: L("Whey isolate", "Whey-isolate-unflavoured-1kg-pouch-batch#A7731-imported-via-the-sports-shop"),
  milk: L("Toned milk", "Toned milk, 3% fat, the half-litre pouch delivered every morning before six"),
  roti: L("Roti", "Roti, whole wheat, made at home on the iron tawa, medium size"),
  dal: L("Masoor dal", "Masoor dal, split red lentils, unpolished, from the organic shop near the temple"),
  ghee: L("Ghee", "Ghee, cow, homemade from the weekly malai collection"),
  yogurt: L("Greek yogurt", "Greek yogurt, plain, high-protein, the 400 g tub (not the fruit cups)"),
  rice: L("Rice", "Rice, basmati, aged two years, long grain, from the big steel dabba in the kitchen"),
  poha: L("Poha", "Poha with peanuts, curry leaves and lemon, the Sunday breakfast version for two people"),
  workout: L("Hotel legs", "Hotel legs: the twenty-five minute dumbbell-only lower day for travel weeks and hotel gyms"),
  dalPot: L("Masoor dal", "Masoor dal tadka with garlic, cumin and the extra ghee Kabir always adds at the end"),
  rajmaPot: L("Rajma", "Rajma chawal, the big Sunday pot with tomatoes cooked down for an hour"),
  reason: L("Sample food for screenshots.", "Sample food for screenshots, entered from the back of the pack; the label lists values per 100 g as sold and a serving size that does not match any scoop or spoon we own."),
  inbox: L(
    "2 idli and the green chutney from the dhaba",
    "2 idli and the green chutney from the dhaba, then half a plate of the sambar that came with it (it was thinner than usual), plus a filter coffee with sugar, and later about a handful of roasted chana from the office jar; I think it was the big jar on the third floor, not the small one. Also: https://example.com/sample/menu/dhaba-near-the-office/idli-sambar-combo-plate-with-chutney",
  ),
};

rmSync(PERSIST_DIR, { recursive: true, force: true });
wrangler(["d1", "migrations", "apply", "gym-tracker"]);
wrangler([
  "d1", "execute", "gym-tracker", "--command",
  `INSERT INTO household (id, name, created_at) VALUES (1, 'Sample household', '2026-01-01T00:00:00Z');
   INSERT INTO member (household_id, name, email, programming_mode, created_at) VALUES
     (1, 'Asha', 'asha@example.com', 'prescribed', '2026-01-01T00:00:00Z'),
     (1, 'Kabir', 'kabir@example.com', 'record_only', '2026-01-01T00:00:00Z'),
     (1, ${q(N.noor)}, 'noor@example.com', 'prescribed', '2026-01-01T00:00:00Z');`,
]);
wrangler([
  "d1", "execute", "gym-tracker", "--command",
  `INSERT INTO gym (id, household_id, name) VALUES (1, 1, ${q(N.gym)});
   UPDATE member SET home_gym_id = 1, week_anchor_date = '2026-07-26' WHERE id = 1;
   INSERT INTO implement (id, gym_id, name, kind, unit, loading, load_list_complete, bar_value, bar_unit) VALUES
     (1, 1, ${q(N.bar)}, 'barbell', 'kg', 'per_side', 1, 20, 'kg'),
     (2, 1, ${q(N.stack)}, 'cable', 'kg', 'total', 0, NULL, NULL);
   INSERT INTO implement_load (implement_id, load, unit) VALUES (2, 30, 'kg'), (2, 35, 'kg'), (2, 40, 'kg');
   INSERT INTO plate_set (id, gym_id, unit, complete) VALUES (1, 1, 'kg', 0), (2, 1, 'lb', 0);
   INSERT INTO plate (plate_set_id, value, status) VALUES (1, 20, 'confirmed'), (1, 10, 'confirmed'), (1, 5, 'confirmed'), (2, 5, 'confirmed');
   INSERT INTO exercise (id, household_id, name, implement_kind) VALUES (1, 1, ${q(N.bench)}, 'barbell'), (2, 1, ${q(N.row)}, 'cable');
   INSERT INTO alias (household_id, alias, kind, target_id, created_at) VALUES (1, 'bench', 'exercise', 1, '2026-10-06T00:00:00Z'), (1, 'row', 'exercise', 2, '2026-10-06T00:00:00Z');
   INSERT INTO programme (id, member_id, name, schedule_kind, active, started_on) VALUES (1, 1, ${q(N.programme)}, 'rotation', 1, '2026-08-01');
   INSERT INTO session_template (id, programme_id, name, session_type) VALUES (1, 1, ${q(N.template)}, 'strength');
   INSERT INTO schedule_slot (programme_id, rotation_position, template_id) VALUES (1, 1, 1);
   INSERT INTO prescription (template_id, position, exercise_id, sets, rep_low, rep_high, rir_target_low, rir_target_high, rest_s,
     load_value, load_unit, load_basis, load_implement_id, bar_value, bar_unit, plates, progression_rule, cue, fallback_note) VALUES
     (1, 1, 1, 3, 8, 12, 1, 2, 150, 12.27, 'kg', 'per_side', 1, 20, 'kg', '[{"value":10,"unit":"kg","count":1},{"value":5,"unit":"lb","count":1}]',
      '{"kind":"rep_top","target_sets":3,"rep_top":12,"rir_floor":1,"increment":"smallest_step"}', ${q(N.cueBench)}, ${q(N.fallbackBench)}),
     (1, 2, 2, 3, 10, 12, 1, 2, 120, 40, 'kg', 'total', 2, NULL, NULL, NULL,
      '{"kind":"rep_top","target_sets":3,"rep_top":12,"rir_floor":1,"increment":"smallest_step"}', ${q(N.cueRow)}, NULL);
   INSERT INTO phase (member_id, name, starts_on, ends_on, energy_stance, intent) VALUES (1, ${q(N.phase)}, '2026-08-01', NULL, 'deficit', ${q(N.intent)});`,
]);
// The input sheet's sample (no-ops where the statements above already made them): dumbbells and two exercises for a saved workout.
wrangler([
  "d1", "execute", "gym-tracker", "--command",
  `INSERT OR IGNORE INTO gym (id, household_id, name) VALUES (1, 1, ${q(N.gym)});
   UPDATE member SET home_gym_id = 1 WHERE id = 1 AND home_gym_id IS NULL;
   INSERT INTO implement (gym_id, name, kind, unit, loading, load_list_complete) SELECT 1, ${q(N.dumbbells)}, 'dumbbell', 'kg', 'total', 1 WHERE NOT EXISTS (SELECT 1 FROM implement WHERE gym_id = 1 AND name = ${q(N.dumbbells)});
   INSERT INTO implement_load (implement_id, load, unit) SELECT id, 16, 'kg' FROM implement WHERE gym_id = 1 AND name = ${q(N.dumbbells)} AND NOT EXISTS (SELECT 1 FROM implement_load l WHERE l.implement_id = implement.id AND l.load = 16);
   INSERT OR IGNORE INTO exercise (household_id, name, implement_kind) VALUES (1, ${q(N.goblet)}, 'dumbbell'), (1, ${q(N.pushup)}, 'bodyweight');`,
]);

/** Calendar helpers for the sample's dates (the script has no domain import). */
const shift = (iso: string, days: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
const sunday = (iso: string) => shift(iso, -new Date(`${iso}T00:00:00Z`).getUTCDay());

/**
 * The Private shape (e2e spec §3), under --long: every canary written where its
 * field lives, as its own member through the tools where a write reason or a
 * version is needed, and by SQL elsewhere. The tool calls run now; the SQL is
 * returned, to run once the Worker has stopped (one writer at a time, like the
 * goal path). Invented text only.
 */
async function privateShape(today: string): Promise<string[]> {
  const text = (m: CanaryMember, field: string): string | null =>
    CANARIES.find((c): c is TextCanary => c.kind === "text" && c.member === m && `${c.table}.${c.field}` === field)?.text ?? null;
  const number = (m: CanaryMember, what: string): number | null => NUMBERS.find((n) => n.member === m && n.what === what)?.value ?? null;
  const name = (m: CanaryMember) => (m === "Noor" ? N.noor : m);
  const sql: string[] = [];
  for (const m of ["Asha", "Kabir", "Noor"] as const) {
    const me = `(SELECT id FROM member WHERE email = '${EMAIL[m]}')`;
    const t = (field: string) => q(text(m, field));
    const has = (field: string) => text(m, field) !== null;
    // Through the tools, as the member: a flag carrying the write reason, then its note by SQL; the member note with its version.
    if (has("flag.note")) {
      await call("raise_flag", { member: name(m), subtype: "data", subject: "Check the bathroom scale's battery", ...(has("write_log.reason") ? { reason: text(m, "write_log.reason") } : {}) }, true, m);
      sql.push(`UPDATE flag SET note = ${t("flag.note")} WHERE id = (SELECT max(id) FROM flag WHERE member_id = ${me});`);
    }
    if (has("member_note.topic")) {
      await call("write_member_note", { member: name(m), topic: text(m, "member_note.topic"), body: text(m, "member_note_version.body") }, true, m);
    }
    if (has("feedback.text")) {
      sql.push(`INSERT INTO feedback (member_id, type, text, context, created_at) VALUES (${me}, 'idea', ${t("feedback.text")}, '{"route":"/"}', '${today}T00:00:00Z');`);
    }
    // A Tell Claude text, sent by the member through the tool, so created_by is theirs (Worker decision 157; F5).
    // Kabir's is about Asha: his text, which she must never see.
    const inbox = text(m, "inbox_entry.text");
    if (inbox) {
      await call("submit_to_inbox", { member: m === "Kabir" ? "Asha" : name(m), date: today, meal_slot: "snack", text: inbox, spans: [{ text: inbox, start: 0, end: inbox.length }] }, true, m);
    }
    // The dev entry signs in members only; seed the agent's question by SQL.
    if (has("question.text")) {
      sql.push(`INSERT INTO question (member_id, text, choices, asked_at) VALUES (${me}, ${t("question.text")}, '["Mine","The other one"]', '${today}T03:00:00Z');`);
      // Keep the agent's creation version too: history is the owner's read until Waiting lands.
      // This also lets the cross-member probes verify refusal of an existing question history.
      sql.push(
        `INSERT INTO write_log (at, resolver, on_behalf_of_member_id, origin, tool, reason) VALUES ('${today}T03:00:00Z', 'claude_code', ${me}, 'inbox', 'ask_member', 'Private shape question');`,
        `INSERT INTO record_version (write_id, table_name, record_id, version, action, data, created_at)
         SELECT (SELECT max(id) FROM write_log), 'question', q.id, 1, 'create',
           json_object('id', q.id, 'member_id', q.member_id, 'inbox_entry_id', q.inbox_entry_id, 'text', q.text,
             'choices', q.choices, 'blocks', q.blocks, 'status', q.status, 'answer', q.answer,
             'answer_inbox_entry_id', q.answer_inbox_entry_id, 'asked_at', q.asked_at, 'answered_at', q.answered_at, 'closed_at', q.closed_at),
           q.asked_at FROM question q WHERE q.id = (SELECT max(id) FROM question WHERE member_id = ${me});`,
      );
    }
    if (m === "Kabir") continue;
    // Readings and bloods: the reading note on the fasted-weight canary, the waist canary, a draw and its marker.
    const d40 = shift(today, -40);
    const d60 = shift(today, -60);
    sql.push(
      `INSERT INTO reading (member_id, metric, measured_on, value, unit, body_state, measurer, state, confirmed_at, note) VALUES (${me}, 'weight', '${d40}', ${number(m, "fasted weight")}, 'kg', 'fasted', 'self', 'confirmed', '${d40}T00:00:00Z', ${t("reading.note")});`,
      `INSERT INTO reading (member_id, metric, measured_on, value, unit, body_state, measurer, state, confirmed_at) VALUES (${me}, 'waist_navel', '${d40}', ${number(m, "waist")}, 'cm', 'fasted', 'self', 'confirmed', '${d40}T00:00:00Z');`,
      `INSERT INTO blood_draw (member_id, drawn_on, lab, fasting, state, confirmed_at, note) VALUES (${me}, '${d60}', 'Sample Labs', 1, 'confirmed', '${d60}T00:00:00Z', ${t("blood_draw.note")});`,
      `INSERT INTO lab_result (draw_id, marker, value, unit, note) SELECT max(id), 'Vitamin B12', ${number(m, "marker")}, 'pg/mL', ${t("lab_result.note")} FROM blood_draw WHERE member_id = ${me};`,
      `INSERT INTO measurement_cadence (member_id, name, every_days, source, metric, body_state, message) VALUES (${me}, 'waist_check', 14, 'reading', 'waist_navel', 'fasted', ${t("measurement_cadence.message")});`,
      `INSERT INTO hr_zone (member_id, zone, low_bpm, high_bpm, status, set_on, basis) VALUES (${me}, 2, 118, 132, 'provisional', '${shift(today, -10)}', ${t("hr_zone.basis")});`,
      `INSERT INTO method_change (member_id, metric, changed_on, note) VALUES (${me}, 'waist_navel', '${shift(today, -30)}', ${t("method_change.note")});`,
      `INSERT INTO legacy_audit_entry (source_file, member_id, logged_on, action, reason) VALUES ('base', ${me}, '2026-01-02', 'note', ${t("legacy_audit_entry.reason")});`,
    );
    if (m === "Asha") {
      // Asha's existing target, goal path, phase and prescriptions carry hers; her latest session, set and cardio block too.
      // Every id is found through her own programme, and an empty column takes the canary alone (NULL || x is NULL).
      const programme = `(SELECT id FROM programme WHERE member_id = ${me} AND active = 1)`;
      const prescriptions = `(SELECT p.id FROM prescription p JOIN session_template st ON st.id = p.template_id WHERE st.programme_id = ${programme})`;
      const append = (column: string, field: string) => `${column} = coalesce(${column} || ' ', '') || ${t(field)}`;
      sql.push(
        `UPDATE target SET ${append("reasoning", "target.reasoning")} WHERE member_id = ${me};`,
        `UPDATE goal_point SET note = ${t("goal_point.note")} WHERE id = (SELECT max(id) FROM goal_point WHERE member_id = ${me});`,
        `UPDATE phase SET ${append("intent", "phase.intent")} WHERE member_id = ${me};`,
        `UPDATE prescription SET ${append("cue", "prescription.cue")} WHERE id = (SELECT min(id) FROM ${prescriptions});`,
        `UPDATE prescription SET ${append("fallback_note", "prescription.fallback_note")} WHERE id = (SELECT max(id) FROM ${prescriptions});`,
        // A load change on her total-loaded prescription (the row), in that prescription's own unit, basis and implement.
        `INSERT INTO load_change (prescription_id, changed_on, load_value, load_unit, load_basis, load_implement_id, reason)
           SELECT id, '${shift(today, -14)}', 35, load_unit, load_basis, load_implement_id, ${t("load_change.reason")} FROM prescription
           WHERE id = (SELECT max(id) FROM prescription WHERE id IN ${prescriptions} AND load_basis = 'total');`,
        `INSERT INTO schedule_swap (programme_id, on_date, template_id, reason)
           SELECT ${programme}, '${shift(today, -3)}', min(id), ${t("schedule_swap.reason")} FROM session_template WHERE programme_id = ${programme};`,
      );
    } else {
      // Noor: her own target, goal point, phase, a strength session with one set, and a cardio session, written as Noor.
      await call("set_target", { member: name(m), effective_from: shift(today, -30), provenance: "member", reasoning: text(m, "target.reasoning"), values: [{ nutrient: "kcal", kind: "target", value: 1900 }] }, true, m);
      sql.push(
        `INSERT INTO goal_point (member_id, metric, week_of, tier, basis, value_low, value_high, unit, headline, note) VALUES (${me}, 'waist_navel', '${sunday(shift(today, 70))}', 'planned', 'absolute', 75, 75, 'cm', 0, ${t("goal_point.note")});`,
        `INSERT INTO phase (member_id, name, starts_on, ends_on, energy_stance, intent) VALUES (${me}, 'Base', '${shift(today, -30)}', NULL, 'maintenance', ${t("phase.intent")});`,
      );
      const session = (await call("start_session", { member: name(m), date: shift(today, -2), session_type: "strength", gym: 1, note: text(m, "session.note") }, true, m)).session as { id: number };
      await call("log_set", { session_id: session.id, exercise: "row", reps: 12, rir: 2, load: { value: 35, unit: "kg", basis: "total", implement: 2 } }, true, m);
      await call("log_cardio", { member: name(m), date: shift(today, -3), session_type: "cardio", energy_kcal: 200, blocks: [{ kind: "steady", duration_s: 1500 }] }, true, m);
    }
    sql.push(
      `UPDATE session SET note = ${t("session.note")} WHERE id = (SELECT max(id) FROM session WHERE member_id = ${me} AND session_type = 'strength');`,
      `UPDATE session_set SET note = ${t("session_set.note")} WHERE id = (SELECT max(ss.id) FROM session_set ss JOIN session s ON s.id = ss.session_id WHERE s.member_id = ${me});`,
      `UPDATE cardio_block SET note = ${t("cardio_block.note")} WHERE id = (SELECT max(b.id) FROM cardio_block b JOIN session s ON s.id = b.session_id WHERE s.member_id = ${me});`,
    );
  }
  return sql;
}

/**
 * The D1 as SQL text, one INSERT per row of every table. `wrangler d1 export
 * --local` takes no --persist-to (4.147.0), so the seed reads the file itself.
 */
function d1Rows(db: DatabaseSync): string {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name").all() as { name: string }[];
  const literal = (v: unknown) => (v === null ? "NULL" : typeof v === "string" ? q(v) : v instanceof Uint8Array ? "X''" : String(v));
  return tables
    .flatMap(({ name }) => (db.prepare(`SELECT * FROM "${name}"`).all() as Record<string, unknown>[]).map((row) => `INSERT INTO ${name} VALUES (${Object.values(row).map(literal).join(", ")});`))
    .join("\n");
}

/**
 * The Private shape landed (e2e spec §3), checked once the Worker has stopped:
 * every text canary in its own field on a row its member owns (so a canary the
 * seed never writes, a zero-row UPDATE or a NULL concatenation fails here, not
 * as a privacy test that passes on a word that isn't there), and every
 * owner-only number exactly once in the whole household.
 */
function checkPrivateShape(): void {
  const db = openD1(PERSIST_DIR);
  try {
    const missing = canariesMissing(db);
    if (missing.length > 0) throw new Error(`The Private shape's text canaries must each be in their own field, on their member's row. Missing: ${missing.join("; ")}`);
    const problems = numbersNotOnce(d1Rows(db));
    if (problems.length > 0) throw new Error(`The Private shape's numbers must each occur once: ${problems.join("; ")}`);
  } finally {
    db.close();
  }
}

// One Worker for the whole seed (e2e spec §3): each call names its member.
// Its pid is recorded in a run record of its own (owner first, then pids), so
// if this seed is SIGKILL'd, the next seed or e2e run reaps the Worker.
reapStale(tmpdir());
const RUN = mkdtempSync(join(tmpdir(), "gym-e2e-seed-"));
writeFileSync(join(RUN, "owner"), String(process.pid));
const server = await startDevWorker({ persist: PERSIST_DIR, token: TOKEN, probeEmail: EMAIL.Asha, pidFile: join(RUN, "pids"), ...(PORT ? { port: PORT } : {}), ...(FIXED_CLOCK ? { fixedNow: FIXED_NOW } : {}) }).catch((error: unknown) => {
  rmSync(RUN, { recursive: true, force: true }); // startDevWorker has already killed its group
  throw error;
});
API = `${server.origin}/tools`;
// Phase 1, as Asha: the catalogue, her target, her own meals, a flag and a cadence;
// then her body, bloods, sessions and an open yesterday.
let todaySeen = "";
/** The Private shape's SQL (--long), run after the Worker stops. */
let privateSql: string[] = [];
try {
  const today = String((await call("whoami", {}, false)).today);
  if (FIXED_CLOCK && today !== FIXED_DAY) throw new Error(`The seed's Worker says today is ${today}, not the fixed ${FIXED_DAY}: it isn't on the fixed clock (LOCAL_FIXED_NOW).`);
  todaySeen = today;
  for (const f of [
    food(N.oats, "dry", 100, "g", 380, 13, 67, 7),
    food(N.whey, "as_sold", 100, "g", 390, 80, 6, 4, [{ name: "scoop", amount: 33 }]),
    food(N.milk, "as_sold", 100, "ml", 59, 3.1, 4.8, 3),
    food(N.roti, "cooked", 100, "g", 300, 10, 50, 4, [{ name: "roti", amount: 36 }]),
    food(N.dal, "dry", 100, "g", 350, 25, 60, 1.5),
    food(N.ghee, "as_sold", 100, "g", 900, 0, 0, 100, [{ name: "tsp", amount: 5 }]),
    food(N.yogurt, "as_sold", 100, "g", 100, 10, 6, 3),
  ]) await call("upsert_food_source", f);
  await call("set_target", {
    member: "Asha", effective_from: "2026-01-01", provenance: "member", reasoning: L("Sample target for screenshots.", "Sample target for screenshots: protein held at 140 g through the cut because the bench has to keep moving, fat floored at 45 g, carbs take whatever is left."),
    values: [
      { nutrient: "kcal", kind: "target", value: 1600 },
      { nutrient: "protein_g", kind: "target", value: 140 },
      { nutrient: "fat_g", kind: "target", value: 55 },
      { nutrient: "fat_g", kind: "floor", value: 45 },
      { nutrient: "carbs_g", kind: "remainder" },
    ],
  });
  await call("log_intake", {
    member: "Asha", date: today, meal_slot: "breakfast",
    items: [
      { source: "food", food: N.oats, value: 50, unit: "g", provenance: "weighed", confidence: "high" },
      { source: "food", food: N.whey, value: 1, measure: "scoop", provenance: "label", confidence: "high" },
      { source: "food", food: N.milk, value: 200, unit: "ml", provenance: "weighed", confidence: "high" },
    ],
  });
  await call("log_intake", {
    member: "Asha", date: today, meal_slot: "lunch",
    items: [
      { source: "food", food: N.roti, value: 2, measure: "roti", provenance: "counted", confidence: "high" },
      { source: "manual", kcal: 260, protein_g: 16, carbs_g: 6, fat_g: 19, reason: L("No catalogue entry for it.", "No catalogue entry for it: the canteen makes it differently every day and nobody could say how much butter went in."), label: L("Paneer bhurji, 1 bowl", "Paneer bhurji from the office canteen, 1 steel bowl, heaped, with the extra onions and the green chillies on the side"), provenance: "estimated", confidence: "low",
        dominant_uncertainty: { description: L("the bowl size", "the bowl size, and whether the paneer was full-fat or the low-fat block the canteen sometimes buys"), kcal: 120 } },
    ],
  });
  await call("set_day_status", { member: "Asha", date: today, status: "open", skipped_meals: ["pre_workout"] });
  await call("raise_flag", { member: "Asha", subtype: "health_watch", subject: L("Repeat the iron panel", "Repeat the iron panel with ferritin, transferrin saturation and a full blood count, fasted, at the same lab as last time, before the cut goes any deeper"), due_on: "2026-10-20" });
  await call("set_measurement_cadence", {
    member: "Asha", name: "fasted_weight", every_days: 2, source: { kind: "reading", metric: "weight", body_state: "fasted" }, message: "Log a fasted weight.",
  });

  // Body: height, ten weeks of waist and fasted weight, a BIA fat-free mass, and the 0.50 end target.
  await call("log_reading", { member: "Asha", date: "2026-01-01", metric: "height", value: 165, unit: "cm", body_state: "not_recorded" });
  for (let w = 10; w >= 0; w--) {
    const d = shift(today, -7 * w);
    await call("log_reading", { member: "Asha", date: d, metric: "waist_navel", value: Math.round((88 - 0.34 * (10 - w)) * 10) / 10, unit: "cm", body_state: "fasted" });
    // Weights a day before each waist, and none this week, so the 7-day fasted-weight cadence is overdue
    // and the strip offers "Log a reading" (the input sheet's screenshots).
    if (w > 0) await call("log_reading", { member: "Asha", date: shift(d, -1), metric: "weight", value: Math.round((71.4 - 0.18 * (10 - w)) * 10) / 10, unit: "kg", body_state: "fasted" });
  }
  await call("log_reading", { member: "Asha", date: shift(today, -20), metric: "bia_fat_free_mass", value: 46.5, unit: "kg", body_state: "fasted" });
  await call("set_goal_point", { member: "Asha", metric: "waist_to_height", week_of: shift(today, 7 * 24), value: 0.5, tier: "planned", reason: L("Sample end target", "Sample end target: waist at half the height, the threshold the doctor named at the April check-up.") });

  // Bloods: two draws; TSH and ALT out of range on the latest. A report never received, and a follow-up.
  await call("log_blood_draw", { member: "Asha", date: "2026-04-01", lab: L("Sample Labs", "Sample Labs, the diagnostics centre on the second floor above the pharmacy"), results: [
    { marker: "TSH", value: 3.1, unit: "mIU/L", ref_low: 0.4, ref_high: 4.2 }, { marker: "Ferritin", value: 40, unit: "ng/mL", ref_low: 30, ref_high: 400 },
  ] });
  await call("log_blood_draw", { member: "Asha", date: shift(today, -5), lab: L("Sample Labs", "Sample Labs, the diagnostics centre on the second floor above the pharmacy"), fasting: true, results: [
    { marker: "TSH", value: 5.6, unit: "mIU/L", ref_low: 0.4, ref_high: 4.2 }, { marker: "ALT", value: 52, unit: "U/L", ref_high: 45 },
    { marker: "Vitamin D", value: 34, unit: "ng/mL", ref_low: 30, ref_high: 100 }, { marker: "CRP", value: 0.5, comparator: "<", unit: "mg/L", ref_high: 5 },
  ] });
  await call("raise_flag", { member: "Asha", subtype: "data", subject: L("Lipid report never received", "Lipid report never received from the lab: the receipt says LIPID-PANEL-EXTENDED-REF#SL-2026-0915-88123 but the email never came"), due_on: shift(today, 10) });

  // Two Upper A sessions: the row tops its range (an unverified 45 kg step next), the bench doesn't.
  for (const [back, rowLoad] of [[9, 35], [2, 40]] as const) {
    const session = (await call("start_session", { member: "Asha", date: shift(today, -back), session_type: "strength", template: N.template })).session as { id: number };
    for (let i = 0; i < 3; i++) {
      await call("log_set", { session_id: session.id, exercise: "bench", reps: 10, rir: 1, load: { basis: "per_side", implement: 1, bar: { value: 20, unit: "kg" }, plates: [{ value: 10, unit: "kg" }, { value: 5, unit: "lb" }] } });
      await call("log_set", { session_id: session.id, exercise: "row", reps: 12, rir: back === 9 ? 0 : 2, load: { value: rowLoad, unit: "kg", basis: "total", implement: 2 } });
    }
  }
  await call("log_cardio", { member: "Asha", date: shift(today, -1), session_type: "class", energy_kcal: 280, blocks: [{ kind: "steady", duration_s: 2700 }] });

  // Yesterday: logged and left open, so the strip asks to close it.
  await call("log_intake", { member: "Asha", date: shift(today, -1), meal_slot: "lunch", items: [
    { source: "food", food: N.roti, value: 3, measure: "roti", provenance: "counted", confidence: "high" },
    { source: "food", food: N.yogurt, value: 150, unit: "g", provenance: "weighed", confidence: "high" },
  ] });

  // The input sheet's sample: a recipe, a learned word, a saved workout and an Inbox entry.
  await call("upsert_recipe", { name: N.poha, kind: "dish", servings: 2, lines: [{ food: N.oats, value: 120, unit: "g" }, { food: N.ghee, value: 1, measure: "tsp" }] });
  // The catalogue's sample (desktop spec §5): a food in two states with a yield, and an unknown micronutrient.
  const dryRice = (await call("upsert_food_source", { name: N.rice, state: "dry", reference_amount: 100, reference_unit: "g", kcal: 360, protein_g: 7, carbs_g: 79, fat_g: 0.6, iron_mg: 0.8, price_min_inr: 6, price_max_inr: 8, reason: N.reason })) as { food_source: { ref: string } };
  await call("upsert_food_source", {
    name: N.rice, state: "cooked", reference_amount: 100, reference_unit: "g", kcal: 120, protein_g: 2.4, carbs_g: 26.3, fat_g: 0.2,
    yields_from: [{ from: dryRice.food_source.ref, factor: 3 }], reason: N.reason,
  });
  await call("learn_alias", { alias: L("chawal", "chawal-from-the-big-steel-dabba"), kind: "food_source", target: dryRice.food_source.ref, reason: L("What Asha calls it.", "What Asha calls it at home, and how it is written on the masking-tape label on the dabba.") });
  await call("learn_alias", { alias: L("dahi", "the thick dahi from the tub"), kind: "food_source", target: N.yogurt, reason: L("What Asha calls it.", "What Asha calls it at home, and how it is written on the masking-tape label on the dabba.") });
  await call("create_workout", {
    name: N.workout, reason: L("Sample workout for screenshots.", "Sample workout for screenshots, built for the hotel gym in the conference week where there are only dumbbells up to 20 kg and one flat bench."),
    lines: [
      { exercise: N.goblet, sets: 3, reps: { low: 10, high: 12 }, load: { value: 16, unit: "kg", basis: "total" }, rir: { low: 1, high: 2 }, rest_s: 90 },
      { exercise: N.pushup, sets: 2, reps: { low: 12, high: 15 }, load: "none" },
    ],
  });
  await call("submit_to_inbox", { member: "Asha", date: today, meal_slot: "snack", text: N.inbox, spans: [{ text: "the green chutney from the dhaba", start: 11, end: 43 }] });
  // A fasted-weight cadence for the strip's card, and a draft reading and a draft blood draw about Asha, as the agent would leave them.
  await call("set_measurement_cadence", { member: "Asha", name: "fasted_weight", every_days: 7, source: { kind: "reading", metric: "weight", body_state: "fasted" }, message: L("Log a fasted weight.", "Log a fasted weight: first thing after waking, after the bathroom, before water or tea, same scale on the same tile.") });
  wrangler([
    "d1", "execute", "gym-tracker", "--command",
    `INSERT INTO reading (member_id, metric, measured_on, value, unit, body_state, measurer, state) SELECT id, 'waist_navel', '${today}', 78.5, 'cm', 'not_recorded', 'not_recorded', 'draft' FROM member WHERE name = 'Asha';
     INSERT INTO blood_draw (member_id, drawn_on, lab, fasting, state) SELECT id, '${today}', ${q(L("Sample lab", "Sample lab, the home-collection service that came at 7 am (booking ref HC-2026-10-08-000123456789)"))}, 1, 'draft' FROM member WHERE name = 'Asha';
     INSERT INTO lab_result (draw_id, marker, value, unit, ref_low, ref_high) SELECT max(id), 'Ferritin', 18, 'ng/mL', 30, 400 FROM blood_draw;`,
  ]);

  if (LONG) {
    // Many sessions with long notes, and cardio with a long note, over the last twelve weeks.
    const sessionNote = "Felt flat after a short night; the bench room was packed so the press started twenty minutes late and the rest periods ran long. THE ROW STACK PIN WAS STUCK AT 40 KG AGAIN, REPORTED AT THE DESK. Knee fine, shoulder fine, the left elbow clicked twice on the second set but did not hurt.";
    for (let back = 80; back >= 12; back -= 3) {
      const session = (await call("start_session", { member: "Asha", date: shift(today, -back), session_type: "strength", template: N.template, note: back % 2 ? sessionNote : undefined })).session as { id: number };
      for (let i = 0; i < 3; i++) {
        await call("log_set", { session_id: session.id, exercise: "bench", reps: 9 + (i % 2), rir: 2, load: { basis: "per_side", implement: 1, bar: { value: 20, unit: "kg" }, plates: [{ value: 10, unit: "kg" }] } });
        await call("log_set", { session_id: session.id, exercise: "row", reps: 11, rir: 2, load: { value: 35, unit: "kg", basis: "total", implement: 2 } });
      }
      if (back % 9 === 0) await call("log_cardio", { member: "Asha", date: shift(today, -back + 1), session_type: "cardio", energy_kcal: 310, blocks: [{ kind: "steady", duration_s: 1800 }, { kind: "steady", duration_s: 900 }, { kind: "steady", duration_s: 600 }] });
    }
    // More Tell Claude texts waiting, each long.
    for (const text of [
      "BREAKFAST WAS THE BIG BOWL OF POHA AGAIN BUT WITH EXTRA PEANUTS AND A SPOON OF GHEE ON TOP, AND I HAD THE LEFTOVER RAJMA FROM YESTERDAY AT ELEVEN BECAUSE THE MEETING RAN OVER AND LUNCH WAS NOT GOING TO HAPPEN UNTIL THREE",
      "dinner-at-the-wedding:paneer-tikka(4pcs),dal-makhani(1katori),2butter-naan,gulab-jamun(2),and-a-glass-of-thandai-that-was-mostly-sugar-and-cream",
    ]) await call("submit_to_inbox", { member: "Asha", date: today, meal_slot: "dinner", text, spans: [{ text: text.slice(0, 40), start: 0, end: 40 }] });
    // A long recipe and a long-named food with a long reason.
    // A name with no break opportunity at all, as a pasted product code would be.
    await call("upsert_food_source", food("Proteinbarchocolatepeanutbutterdoublecrunchbatch0000123456789ABCDEFGH", "as_sold", 100, "g", 380, 30, 40, 12));
    await call("log_intake", { member: "Asha", date: today, meal_slot: "snack", items: [{ source: "food", food: "Proteinbarchocolatepeanutbutterdoublecrunchbatch0000123456789ABCDEFGH", value: 60, unit: "g", provenance: "label", confidence: "high" }] });
    await call("upsert_food_source", food("Paneer, low-fat block from the dairy co-operative, sold loose by weight, wrapped in banana leaf", "as_sold", 100, "g", 200, 22, 4, 10));
    await call("upsert_recipe", {
      name: "Sunday chole with the tea-bag trick, black chana soaked overnight, pressure-cooked for six whistles and finished with amchur",
      kind: "dish", servings: 6, reason: N.reason,
      lines: [{ food: N.dal, value: 300, unit: "g" }, { food: N.ghee, value: 3, measure: "tsp" }, { food: "Paneer, low-fat block from the dairy co-operative, sold loose by weight, wrapped in banana leaf", value: 200, unit: "g" }],
    });
    // A third flag and a member note, as the agent would write them.
    await call("raise_flag", { member: "Asha", subtype: "data", subject: "WAIST READINGS ON 28 SEP AND 1 OCT DISAGREE BY 2.4 CM: CHECK WHETHER THE TAPE WAS AT THE NAVEL OR AT THE NARROWEST POINT BEFORE TRUSTING THE TREND", due_on: shift(today, 3) });
    await call("write_member_note", { member: "Asha", topic: "Training constraints and the reasoning behind the current programme", body: N.cueBench + " " + N.cueRow });
    // The stress shapes (wide-layout spec §7). Many and short: 29 one-word foods (40 in all) and four one-word
    // recipes that use ghee, so ghee is used by six (Poha and the Sunday chole are the other two).
    for (const [name, kcal, p, c, f] of ONE_WORD_FOODS) await call("upsert_food_source", food(name, "as_sold", 100, "g", kcal, p, c, f));
    for (const [name, lines] of [
      ["Upma", [{ food: "Suji", value: 100, unit: "g" }, { food: N.ghee, value: 1, measure: "tsp" }]],
      ["Khichdi", [{ food: "Moong", value: 80, unit: "g" }, { food: "Toor", value: 40, unit: "g" }, { food: N.ghee, value: 2, measure: "tsp" }]],
      ["Halwa", [{ food: "Suji", value: 60, unit: "g" }, { food: N.ghee, value: 3, measure: "tsp" }]],
      ["Pongal", [{ food: "Moong", value: 60, unit: "g" }, { food: N.ghee, value: 2, measure: "tsp" }]],
    ] as const) await call("upsert_recipe", { name, kind: "dish", servings: 2, lines, reason: N.reason });
    // An 11-item dinner: ten weighed one-word foods, and 2 pieces of Tofu. Tofu's reference unit is g and the item's
    // unit is piece (not a measure), so v_intake_item's factor is NULL and its kcal and protein are unknown
    // (app/worker/migrations/0010_nutrition_views.sql:106-107): the "empty" shape, schema-legal. Written as SQL:
    // log_intake refuses a unit the food can't convert.
    await call("log_intake", {
      member: "Asha", date: today, meal_slot: "dinner",
      items: ONE_WORD_FOODS.slice(0, 10).map(([name], i) => ({ source: "food", food: name, value: 30 + 5 * i, unit: "g", provenance: "weighed", confidence: "high" })),
    });
    wrangler([
      "d1", "execute", "gym-tracker", "--command",
      `INSERT INTO intake_item (member_id, eaten_on, meal_slot, source_kind, food_source_id, amount_value, amount_unit, provenance, confidence, state, confirmed_at)
         SELECT m.id, '${today}', 'dinner', 'food_source', f.id, 2, 'piece', 'counted', 'low', 'confirmed', '${today}T00:00:00Z' FROM member m, food_source f WHERE m.name = 'Asha' AND f.name = 'Tofu';
       INSERT INTO gym (household_id, name) VALUES (1, 'Ox');`,
    ]);
    const mealsToday = (await call("day_meals", { member: "Asha", date: today }, false)).slots as { slot: string; items: { name: string | null; kcal: number | null; protein: number | null }[] }[];
    const dinner = mealsToday.find((s) => s.slot === "dinner");
    const tofu = dinner?.items.find((i) => i.name === "Tofu");
    if (dinner?.items.length !== 11 || !tofu || tofu.kcal !== null || tofu.protein !== null) {
      throw new Error(`The stress dinner should hold 11 items, Tofu with unknown kcal and protein: ${JSON.stringify(dinner)}`);
    }
    // Eight Tell Claude texts waiting in all (three above): short and long.
    for (const text of ["2 idli", "chai", "half a plate of poha and a banana", "the usual oats, but with 2 scoops", "dal chawal, 1 katori each"]) {
      await call("submit_to_inbox", { member: "Asha", date: today, meal_slot: "snack", text, spans: [{ text, start: 0, end: text.length }] });
    }
  }

  // Phase 2, as Kabir: the shared pot (Noor wasn't there) and a yogurt he logged for Asha, both drafts about her.
  const kabirToday = String((await call("whoami", {}, false, "Kabir")).today);
  await call("household_meal", {
    date: kabirToday, meal_slot: "lunch",
    cooks: [{
      name: N.dalPot,
      lines: [
        { food: N.dal, state: "dry", value: 150, unit: "g", provenance: "weighed" },
        { food: N.ghee, value: 2, measure: "tsp", provenance: "counted" },
      ],
      portions: [
        { member: "Asha", fraction: 0.38, provenance: "estimated", dominant_uncertainty: { description: "ladle size", kcal: 35 } },
        { member: "Kabir", fraction: 0.34, provenance: "estimated" },
      ],
    }],
  }, true, "Kabir");
  await call("log_intake", {
    member: "Asha", date: kabirToday, meal_slot: "snack",
    items: [{ source: "food", food: N.yogurt, value: 100, unit: "g", provenance: "label", confidence: "high" }],
  }, true, "Kabir");

  // A leftover from yesterday's pot.
  const rajma = await call("household_meal", {
    date: shift(kabirToday, -1), meal_slot: "dinner",
    cooks: [{ name: N.rajmaPot, lines: [{ food: N.dal, state: "dry", value: 200, unit: "g", provenance: "weighed" }], portions: [
      { member: "Kabir", fraction: 0.4, provenance: "estimated" }, { member: "Asha", fraction: 0.3, provenance: "estimated" },
      // The long sample's long name gets a share wide enough to carry a label in the split bar.
      ...(LONG ? [{ member: N.noor, fraction: 0.25, provenance: "estimated" }] : []),
    ] }],
  }, true, "Kabir");
  const component = (rajma.cooks as { components: { id: number }[] }[])[0]!.components[0]!.id;
  await call("mark_remainder", { component_id: component, disposition: "leftover", provenance: "estimated", date: shift(kabirToday, -1) }, true, "Kabir");
  if (LONG) {
    // Five more leftovers (six in all, wide-layout spec §7), each from its own one-word pot.
    for (const [i, name] of ["Sambar", "Chole", "Kadhi", "Pulao", "Rasam"].entries()) {
      const date = shift(kabirToday, -2 - Math.floor(i / 2));
      const slot = i % 2 === 0 ? "lunch" : "dinner";
      const pot = await call("household_meal", {
        date, meal_slot: slot,
        cooks: [{ name, lines: [{ food: N.dal, state: "dry", value: 120 + 10 * i, unit: "g", provenance: "weighed" }], portions: [
          { member: "Kabir", fraction: 0.3, provenance: "estimated" }, { member: "Asha", fraction: 0.3, provenance: "estimated" },
        ] }],
      }, true, "Kabir");
      const id = (pot.cooks as { components: { id: number }[] }[])[0]!.components[0]!.id;
      await call("mark_remainder", { component_id: id, disposition: "leftover", provenance: "estimated", date }, true, "Kabir");
    }
  }
  if (LONG) privateSql = await privateShape(kabirToday);
} finally {
  await server.stop();
  rmSync(RUN, { recursive: true, force: true });
}

// The weekly cm goal path: a goal point per Sunday from ten weeks back to 24 weeks ahead,
// written once the Worker has stopped, so nothing else writes its D1 while it runs.
const start = sunday(shift(todaySeen, -70));
const path = Array.from({ length: 35 }, (_, w) => `(1, 'waist_navel', '${shift(start, 7 * w)}', 'planned', 'absolute', ${(88 - 0.16 * w).toFixed(2)}, ${(88 - 0.16 * w).toFixed(2)}, 'cm', 0)`);
wrangler(["d1", "execute", "gym-tracker", "--command", `INSERT INTO goal_point (member_id, metric, week_of, tier, basis, value_low, value_high, unit, headline) VALUES ${path.join(", ")};`]);
if (privateSql.length > 0) {
  wrangler(["d1", "execute", "gym-tracker", "--command", privateSql.join("\n")]);
  checkPrivateShape();
}
if (SEEDED_ON) writeFileSync(SEEDED_ON, `${todaySeen}\n`);
console.log(`Sample household ready in ${PERSIST_DIR}. Run: npm run dev -w @myfitnessguide/web -- ${LONG ? "--sample-long" : "--sample"}`);
