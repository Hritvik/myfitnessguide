// Phases: the Guide's phase map becomes dated phases of its member (the base
// Guide is Hritvik's), with energy stance and intent; members without a map
// get one phase proposed from their Handover and People goal. Invented
// values only.
import { describe, expect, it } from "vitest";
import { rehearse } from "../src/rehearse";
import { basePeople, members, snapshot } from "./fixture";

const guide = [
  ["GUIDE", "All prose lives here."],
  [],
  ["Section", "Item", "Detail"],
  ["PHASE MAP", "Wk 1", "Calibration. 2 Feb - 8 Feb 2026."],
  ["", "Wk 2-6", "Phase 1 Base, deficit. 9 Feb - 15 Mar 2026."],
  ["", "Wk 7", "Deload, maintenance. 16 Mar."],
  ["", "Wk 8-12", "Phase 2 Fed, maintenance to slight surplus. 23 Mar - 26 Apr."],
  ["", "Wk 13-14", "Taper. 27 Apr - 10 May."],
  ["", "Why this order", "Prose about the order, not a phase."],
  ["ALSO KNOWN", "Sport", "Plays tennis."],
];

const handover = (status: string, effective: unknown) => [
  ["REMOTE AGENT HANDOVER"],
  ["Use this tab before any remote write."],
  ["Field", "Current value"],
  ["Program status", status],
  ["Status effective", effective],
];

function run() {
  return rehearse({
    snapshot: snapshot({
      base: { People: basePeople(), Guide: guide },
      asha: { Handover: handover("Started 2 Mar 2026 - first session done", "2026-03-02") },
      kabir: { Handover: handover("Not started - tabs created", 46082) },
    } as never),
    members: members(),
  });
}

describe("phases", () => {
  it("imports the phase map as dated, non-overlapping phases with stance and intent", async () => {
    const r = await run();
    const hritvik = r.db.all("SELECT name, starts_on, ends_on, energy_stance, intent FROM phase WHERE member_id = (SELECT id FROM member WHERE name = 'Hritvik') ORDER BY starts_on");
    expect(hritvik).toEqual([
      { name: "Calibration", starts_on: "2026-02-02", ends_on: "2026-02-08", energy_stance: "maintenance", intent: "Wk 1: Calibration. 2 Feb - 8 Feb 2026." },
      { name: "Phase 1 Base", starts_on: "2026-02-09", ends_on: "2026-03-15", energy_stance: "deficit", intent: "Wk 2-6: Phase 1 Base, deficit. 9 Feb - 15 Mar 2026." },
      { name: "Deload", starts_on: "2026-03-16", ends_on: "2026-03-22", energy_stance: "maintenance", intent: "Wk 7: Deload, maintenance. 16 Mar." },
      { name: "Phase 2 Fed", starts_on: "2026-03-23", ends_on: "2026-04-26", energy_stance: "surplus", intent: "Wk 8-12: Phase 2 Fed, maintenance to slight surplus. 23 Mar - 26 Apr." },
      { name: "Taper", starts_on: "2026-04-27", ends_on: "2026-05-10", energy_stance: "maintenance", intent: "Wk 13-14: Taper. 27 Apr - 10 May." },
    ]);
  });

  it("asks about a stance the map doesn't state or states as a range, proposing one", async () => {
    const r = await run();
    const asked = r.rulings.filter((x) => x.code === "phase_energy_stance").map((x) => [x.id, x.proposal, x.decision]);
    expect(asked).toEqual([
      ["base/Guide!4/phase_energy_stance", "maintenance", "pending"],
      ["base/Guide!7/phase_energy_stance", "surplus", "pending"],
      ["base/Guide!8/phase_energy_stance", "maintenance", "pending"],
    ]);
  });

  it("proposes one phase for a member with no phase map, from the Handover status and the People goal", async () => {
    const r = await run();
    const asha = r.rulings.find((x) => x.id === "asha/Handover!4/phase_from_handover");
    expect(asha).toMatchObject({ kind: "semantic", decision: "pending" });
    expect(asha?.proposal).toMatchObject({ name: "Cut", starts_on: "2026-03-02", energy_stance: "deficit" });
    expect(r.db.all("SELECT m.name, p.name AS phase, p.starts_on FROM phase p JOIN member m ON m.id = p.member_id WHERE m.name <> 'Hritvik' ORDER BY m.name")).toEqual([
      { name: "Asha", phase: "Cut", starts_on: "2026-03-02" },
      { name: "Kabir", phase: "Cut", starts_on: "2026-03-01" },
    ]);
  });
});
