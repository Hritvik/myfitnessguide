// The old gap_registry -> measurement cadences (set_measurement_cadence).
// The registry here is invented, in the shape of shared/config.yml's.
import { describe, expect, it } from "vitest";
import { parseGapRegistry } from "../src/cadences";
import { rehearse } from "../src/rehearse";
import { basePeople, BODY_HEADER, CARDIO_HEADER, LOG_HEADER, members, PROGRAM_HEADER, set, snapshot } from "./fixture";

const REGISTRY = `
files: { base: x }
gap_registry:
  - name: waist
    every_days: 7
    source: { tab: body, column: G }
    message: "Waist is overdue."
  - name: fasted_weight
    every_days: 2
    source: { tab: body, column: C }
    message: "No recent fasted weight."
  - name: hr_data
    every_days: 7
    source: { tab: cardio, column: K }
    message: "No HR data."
  - name: progress_photos
    every_days: 28
    source: { tab: body, column: S }
    message: "No progress photos."
  - name: plank
    every_days: 7
    source: { tab: log, match: { exercise: Plank } }
    message: "Plank is overdue."
  - name: mystery
    every_days: 3
    source: { tab: nutrition, column: Z }
    message: "?"
`;

const program = [
  PROGRAM_HEADER,
  ["Upper A", 1, "Plank", "Core", 3, "30-45", 1, "60s", "", "", "", "", "", "", "", ""],
];

function run(registry: string | null = REGISTRY) {
  return rehearse({
    snapshot: snapshot({
      base: { People: basePeople() },
      hritvik: { Body: [BODY_HEADER], Cardio: [CARDIO_HEADER], Log: [LOG_HEADER, set({ date: 46240, session: "Upper A", exercise: "Plank", set: 1, reps: "", basis: "bodyweight", duration: 30 })], Program: program },
    } as never),
    members: members(),
    ...(registry === null ? {} : { gapRegistry: parseGapRegistry(registry) }),
  });
}

describe("gap registry -> measurement cadences", () => {
  it("parses the registry's entries", () => {
    expect(parseGapRegistry(REGISTRY).map((e) => e.name)).toEqual(["waist", "fasted_weight", "hr_data", "progress_photos", "plank", "mystery"]);
  });

  it("seeds Hritvik's cadences, mapping each Sheets source to where the app keeps it", async () => {
    const r = await run();
    const rows = r.db.all(
      `SELECT c.name, c.every_days, c.source, c.metric, c.body_state, e.name AS exercise, c.message
       FROM measurement_cadence c JOIN member m ON m.id = c.member_id LEFT JOIN exercise e ON e.id = c.exercise_id
       WHERE m.name = 'Hritvik' ORDER BY c.id`,
    );
    expect(rows).toEqual([
      { name: "waist", every_days: 7, source: "reading", metric: "waist_navel", body_state: null, exercise: null, message: "Waist is overdue." },
      { name: "fasted_weight", every_days: 2, source: "reading", metric: "weight", body_state: "fasted", exercise: null, message: "No recent fasted weight." },
      { name: "hr_data", every_days: 7, source: "cardio_hr", metric: null, body_state: null, exercise: null, message: "No HR data." },
      { name: "progress_photos", every_days: 28, source: "manual", metric: null, body_state: null, exercise: null, message: "No progress photos." },
      { name: "plank", every_days: 7, source: "exercise", metric: null, body_state: null, exercise: "Plank", message: "Plank is overdue." },
    ]);
  });

  it("raises a ruling for a source it can't map, instead of dropping it", async () => {
    const r = await run();
    expect(r.rulings.find((x) => x.id === "config/gap_registry!6/unmapped_cadence")).toMatchObject({ kind: "semantic", proposal: null });
  });

  it("seeds nothing when no registry is given", async () => {
    const r = await run(null);
    expect(r.db.all("SELECT count(*) AS n FROM measurement_cadence")).toEqual([{ n: 0 }]);
  });
});
