// Click test P2-19 (ticket 68): coach notes, cues and flags stored as
// all-caps essays. The preview script proposes a sentence-case rewrite per
// row, keeping acronyms, units, dates, names and quoted text; it writes
// nothing (the rewrite itself goes through amend / the note tools, after
// Hritvik has seen the before and after). Invented text only.
import { describe, expect, it } from "vitest";
import { preview, sentenceCase } from "../scripts/sentence-case-preview";

describe("sentenceCase", () => {
  it("lowercases a shouted note, capitalising each sentence", () => {
    expect(sentenceCase("KEEP THE ELBOWS TUCKED. PAUSE AT THE BOTTOM! DON'T BOUNCE?")).toBe("Keep the elbows tucked. Pause at the bottom! Don't bounce?");
  });

  it("keeps the known acronyms and units in their own case", () => {
    expect(sentenceCase("STOP AT RIR 2. BMR FROM THE BIA SCAN. CHECK TSH AND BP; HR UNDER 150.")).toBe("Stop at RIR 2. BMR from the BIA scan. Check TSH and BP; HR under 150.");
    expect(sentenceCase("E1RM UP 5 KG ON THE DB PRESS, 10 LB ON THE EZ BAR, 3 KM WALK")).toBe("e1RM up 5 kg on the DB press, 10 lb on the EZ bar, 3 km walk");
    expect(sentenceCase("SS-A/SS-B: SUPERSET THEM")).toBe("SS-A/SS-B: superset them");
    expect(sentenceCase("40 MIN ZONE 2 AFTER UPPER A")).toBe("40 min Zone 2 after Upper A");
    expect(sentenceCase("3X12 AT 20KG")).toBe("3x12 at 20kg");
  });

  it("lowercases a short all-caps word that isn't a known acronym", () => {
    expect(sentenceCase("DO NOT GO TO FAILURE ON THE RDL")).toBe("Do not go to failure on the RDL");
    expect(sentenceCase("THE XYZ THING")).toBe("The xyz thing");
  });

  it("keeps dates, the household's names, I and quoted text", () => {
    expect(sentenceCase("RETEST ON 8 OCT 2026 (MONDAY), 2026-10-12. I'M TOLD ASHA SAID \"KEEP IT LIGHT\".")).toBe(
      "Retest on 8 Oct 2026 (Monday), 2026-10-12. I'm told Asha said \"KEEP IT LIGHT\".",
    );
    expect(sentenceCase("HRITVIK: USE THE 'SLOW ECCENTRIC' CUE")).toBe("Hritvik: use the 'SLOW ECCENTRIC' cue");
    expect(sentenceCase("Asha’s NOTE: “HOLD 2 S”", { names: ["Asha"] })).toBe("Asha’s note: “HOLD 2 S”");
  });

  it("starts each line and bullet with a capital", () => {
    expect(sentenceCase("WEEK 1:\n- ADD A SET\n- KEEP RIR 2")).toBe("Week 1:\n- Add a set\n- Keep RIR 2");
  });

  it("leaves text that is already in sentence case as it is", () => {
    for (const t of ["Keep the elbows tucked; RIR 2 on the last set.", "e1RM rose 2 kg since Upper A.", "Use the SMR roller first."]) expect(sentenceCase(t)).toBe(t);
  });

  it("lowercases an emphasised long word in otherwise ordinary text, but keeps a short unknown capitalised token there", () => {
    expect(sentenceCase("Do NOT lock out, and ALWAYS brace. Ask the PT.")).toBe("Do not lock out, and always brace. Ask the PT.");
  });
});

describe("preview", () => {
  it("gives each row its proposal and whether it changed, and names short words it lowercased for a second look", () => {
    const rows = [
      { id: 7, table: "flag", field: "note", text: "LOW B12. RECHECK IN 3 MONTHS, ASK DR ABOUT IT" },
      { id: 8, table: "prescription", field: "cue", text: "Chest up." },
    ];
    expect(preview(rows)).toEqual([
      { id: 7, table: "flag", field: "note", before: rows[0]!.text, after: "Low B12. Recheck in 3 months, ask dr about it", changed: true, review: ["DR"] },
      { id: 8, table: "prescription", field: "cue", before: "Chest up.", after: "Chest up.", changed: false, review: [] },
    ]);
  });

  it("refuses rows that aren't {id, table, field, text}", () => {
    expect(() => preview([{ id: 1, table: "flag", text: "X" }] as never)).toThrow(/row 0/);
  });
});
