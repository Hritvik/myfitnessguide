// Prose -> member notes (Guide, Handover, Meal Prep, Exercise Library),
// flags proposed from Handover, and the Agent Audit rows as history.
import { describe, expect, it } from "vitest";
import { rehearse } from "../src/rehearse";
import { AUDIT_HEADER, basePeople, CARDIO_HEADER, members, snapshot } from "./fixture";

const guide = [
  ["GUIDE", "All prose lives here."],
  [],
  ["Section", "Item", "Detail"],
  ["NUTRITION TARGETS", "Calories", "2100 kcal once the deficit starts."],
  ["", "Protein", "100 g."],
  [],
  ["ALSO KNOWN", "Sport", "Plays tennis."],
];

const handover = [
  ["REMOTE AGENT HANDOVER", "", "", "", "", "", "", "stray set dump"],
  ["Use this tab before any remote write."],
  ["Field", "Current value"],
  ["Program status", "Cleared - deficit active"],
  ["Status effective", 46237],
  ["Tracker date", 46298],
  ["Active restriction", "Doctor follow-up pending. Raised 3 Aug 2026."],
  ["Weekly schedule", "MON Upper, WED Lower."],
  ["Knee watch flag", "RAISED 5 Oct 2026. NOT A DIAGNOSIS. Clicks on stairs."],
];

function run(extra: Record<string, Record<string, unknown[][]>> = {}) {
  return rehearse({
    snapshot: snapshot({
      base: {
        People: basePeople(),
        Guide: guide,
        "Meal Prep": [["THE SUNDAY BATCH", "Two hours."], ["Soak", "Rajma"]],
        "Exercise Library": [["Muscle Group", "Movement"], ["Chest", "Flat press"]],
        "Agent Audit": [AUDIT_HEADER, [46234, "", "Codex", "Upgrade", "Today", "Agreed", "Old", "Done"], [46235, 0.5, "Claude", "", "Log", "r", "", ""]],
      },
      hritvik: { Handover: handover, Guide: guide, Cardio: [[...CARDIO_HEADER, "A LONG PROTOCOL HEADER CELL HOLDING A PARAGRAPH OF PROSE"]] },
      ...extra,
    } as never),
    members: members(),
  });
}

describe("member notes", () => {
  it("imports Guide sections as Hritvik's notes, with superseded facts as older versions (mechanical)", async () => {
    const r = await run();
    const versions = r.db.all<{ topic: string; version: number; body: string }>(
      "SELECT n.topic, v.version, v.body FROM member_note n JOIN member_note_version v ON v.note_id = n.id WHERE n.member_id = 1 AND n.topic IN ('targets', 'programme status') ORDER BY n.topic, v.version",
    );
    expect(versions.map((v) => [v.topic, v.version])).toEqual([
      ["programme status", 1],
      ["targets", 1],
      ["targets", 2],
    ]);
    expect(versions[1]?.body).toContain("Calories: 2100 kcal once the deficit starts.");
    expect(versions[2]?.body).toBe("Set by the member.");
    expect(r.rulings.find((x) => x.id === "base/Guide!4/superseded_guide_fact")).toMatchObject({ kind: "mechanical", decision: "accepted" });
    expect(r.db.get("SELECT count(*) AS n FROM member_note WHERE topic = 'guide: ALSO KNOWN'")).toEqual({ n: 1 });
  });

  it("skips Hritvik's Guide when it is a copy of base, and keeps household documents", async () => {
    const r = await run();
    expect(r.db.all("SELECT topic, member_id FROM v_member_note WHERE member_id IS NULL ORDER BY topic")).toEqual([
      { topic: "exercise library", member_id: null },
      { topic: "meal prep", member_id: null },
    ]);
    expect(r.rulings.filter((x) => x.code === "guide_copy_differs")).toEqual([]);
  });

  it("imports Handover fields as notes and proposes flags from restrictions", async () => {
    const r = await run();
    const topics = r.db.all<{ topic: string }>("SELECT topic FROM member_note WHERE member_id = 1 AND topic NOT LIKE 'guide:%' ORDER BY topic").map((x) => x.topic);
    expect(topics).toEqual(["Cardio: header R", "handover: Knee watch flag", "programme status", "targets", "training plan"]);
    expect(r.db.all("SELECT subtype, subject, raised_on, status FROM flag ORDER BY id")).toEqual([
      { subtype: "health_watch", subject: "Doctor follow-up pending", raised_on: "2026-08-03", status: "open" },
      { subtype: "health_watch", subject: "Knee watch", raised_on: "2026-10-05", status: "open" },
    ]);
    expect(r.rulings.filter((x) => x.code === "flag_from_handover").map((x) => x.decision)).toEqual(["pending", "pending"]);
  });
});

describe("legacy audit", () => {
  it("keeps every Agent Audit row as history and asks about one with no action", async () => {
    const r = await run();
    expect(r.db.all("SELECT source_file, logged_on, logged_time, agent, action FROM legacy_audit_entry")).toEqual([
      { source_file: "base", logged_on: "2026-07-31", logged_time: null, agent: "Codex", action: "Upgrade" },
    ]);
    expect(r.rulings.find((x) => x.id === "base/Agent Audit!3/rejected_by_api/add_legacy_audit_entry")).toMatchObject({ kind: "semantic" });
  });
});
