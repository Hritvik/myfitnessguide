// People -> household, members (emails from members.json), home gyms,
// height readings and dated targets with their reasoning.
import { describe, expect, it } from "vitest";
import { rehearse } from "../src/rehearse";
import { basePeople, catalogueWithSetOn, members, PEOPLE_HEADER, person, snapshot } from "./fixture";

describe("people", () => {
  it("creates the household, its members and their home gyms", async () => {
    const r = await rehearse({ snapshot: snapshot({ base: { People: basePeople() } }), members: members() });
    expect(r.db.all("SELECT name, email, programming_mode, sex, week_anchor_date, (SELECT name FROM gym WHERE id = home_gym_id) AS gym FROM member ORDER BY id")).toEqual([
      { name: "Hritvik", email: "hritvik@example.com", programming_mode: "prescribed", sex: "male", week_anchor_date: "2026-07-26", gym: "Hritvik's gym" },
      { name: "Asha", email: "asha@example.com", programming_mode: "record_only", sex: "female", week_anchor_date: null, gym: "Asha's gym" },
      { name: "Kabir", email: "kabir@example.com", programming_mode: "prescribed", sex: "male", week_anchor_date: null, gym: "Kabir's gym" },
    ]);
    expect(r.db.all("SELECT resolver, origin, json_extract(resolver_detail, '$.origin.tab') AS tab FROM write_log WHERE tool = 'create_member'")).toEqual(
      Array(3).fill({ resolver: "importer", origin: "import", tab: "People" }),
    );
  });

  it("imports each member's height and dated targets, with the RDA block as reference intakes", async () => {
    const snap = snapshot({
      base: { People: basePeople() },
      hritvik: { Catalogue: catalogueWithSetOn(46288) },
    });
    const r = await rehearse({ snapshot: snap, members: members() });
    expect(r.db.all("SELECT m.name, r.value, r.unit FROM reading r JOIN member m ON m.id = r.member_id WHERE metric = 'height' ORDER BY m.id")).toEqual([
      { name: "Hritvik", value: 170, unit: "cm" },
      { name: "Asha", value: 150, unit: "cm" },
      { name: "Kabir", value: 170, unit: "cm" },
    ]);
    const target = r.db.get<{ effective_from: string; reasoning: string; provenance: string }>(
      "SELECT effective_from, reasoning, provenance FROM target t JOIN member m ON m.id = t.member_id WHERE m.name = 'Hritvik'",
    );
    expect(target).toEqual({ effective_from: "2026-09-23", reasoning: "Set by the member.", provenance: "import" });
    expect(r.db.all("SELECT nutrient, kind, value FROM v_target WHERE member_id = 1 ORDER BY kind, nutrient")).toEqual([
      { nutrient: "b12_ug", kind: "reference_intake", value: 2.2 },
      { nutrient: "calcium_mg", kind: "reference_intake", value: 1000 },
      { nutrient: "fibre_g", kind: "reference_intake", value: 30 },
      { nutrient: "iron_mg", kind: "reference_intake", value: 19 },
      { nutrient: "magnesium_mg", kind: "reference_intake", value: 440 },
      { nutrient: "potassium_mg", kind: "reference_intake", value: 3510 },
      { nutrient: "sodium_mg", kind: "reference_intake", value: 2000 },
      { nutrient: "carbs_g", kind: "target", value: 200 },
      { nutrient: "fat_g", kind: "target", value: 55 },
      { nutrient: "kcal", kind: "target", value: 1800 },
      { nutrient: "protein_g", kind: "target", value: 120 },
    ]);
  });

  it("reads targets stored as text, recording a mechanical ruling", async () => {
    const snap = snapshot({
      base: { People: [PEOPLE_HEADER, person("Hritvik"), person("Asha", { sex: "F", kcal: "1488", protein: "112" }), person("Kabir")] },
      asha: { Catalogue: catalogueWithSetOn(46290) },
    });
    const r = await rehearse({ snapshot: snap, members: members() });
    expect(r.db.get("SELECT value FROM v_target WHERE member_id = 2 AND nutrient = 'kcal' AND kind = 'target'")).toEqual({ value: 1488 });
    const ruling = r.rulings.find((x) => x.id === "base/People!3/stored_as_text");
    expect(ruling).toMatchObject({ kind: "mechanical", decision: "accepted", proposal: { columns: ["J", "K"] } });
  });

  it("asks for a target date when the person file has none", async () => {
    const r = await rehearse({ snapshot: snapshot({ base: { People: basePeople() } }), members: members() });
    const ruling = r.rulings.find((x) => x.id === "base/People!2/target_date");
    expect(ruling).toMatchObject({ kind: "semantic", decision: "pending", proposal: "2026-10-05" });
    expect(r.db.get("SELECT effective_from FROM target WHERE member_id = 1")).toEqual({ effective_from: "2026-10-05" });
  });

  it("refuses a People row with no members.json entry", async () => {
    const snap = snapshot({ base: { People: [...basePeople(), person("Stranger")] } });
    const r = await rehearse({ snapshot: snap, members: members() });
    expect(r.rulings.find((x) => x.id === "base/People!5/unknown_member")).toMatchObject({ kind: "semantic", decision: "pending", proposal: null });
    expect(r.db.get("SELECT count(*) AS n FROM member")).toEqual({ n: 3 });
  });
});
