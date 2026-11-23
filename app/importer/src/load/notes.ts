/**
 * Prose and history:
 * - base Guide -> Hritvik's member notes, one per section (the research
 *   found the Guide is his, copied into base when the tracker was split);
 *   sections a newer source supersedes become version 1 of that topic, and
 *   the newer text version 2 (mechanical, ticket *Import design*);
 * - Hritvik's Guide tab, when it is a copy of base, is not imported twice;
 * - Meal Prep and Exercise Library -> household documents;
 * - Handover fields -> member notes; restrictions and flag rows propose
 *   open flags (semantic);
 * - long prose in header cells -> member notes;
 * - Agent Audit rows -> legacy audit entries.
 */
import { colLetter, type Row, type Sheet } from "../grid";
import { PERSON_FILES } from "../layout";
import { parseDate, parseTime, ParseError } from "../parse";
import { Loader, RowReader } from "./context";

/** Guide sections whose facts a newer source replaced, and the topic both share. */
const SUPERSEDED: Record<string, { topic: string; by: string }> = {
  "NUTRITION TARGETS": { topic: "targets", by: "base People (Target basis)" },
  TRAINING: { topic: "training plan", by: "Handover (Weekly schedule)" },
  "MEDICAL - PROGRAM ON HOLD": { topic: "programme status", by: "Handover (Program status, Active restriction)" },
};

/** Handover fields the app derives from records; not imported as prose. */
const DERIVED_FIELDS = /^(tracker date|status effective|last completed session|last completed date)$/i;

interface Section {
  title: string;
  first: Row;
  lines: string[];
}

function guideSections(sheet: Sheet): Section[] {
  const sections: Section[] = [];
  let current: Section | null = null;
  for (let n = 1; n <= sheet.data.rows; n++) {
    const row = sheet.row(n);
    const a = row.rendered("A").trim();
    const b = row.rendered("B").trim();
    const c = row.rendered("C").trim();
    if (n === 1 || (a === "Section" && b === "Item")) continue;
    if (a) {
      current = { title: a, first: row, lines: [] };
      sections.push(current);
    }
    if (current && (b || c)) current.lines.push(b && c ? `${b}: ${c}` : b || c);
  }
  return sections;
}

const sameGrid = (a: Sheet, b: Sheet) => JSON.stringify(a.data.values) === JSON.stringify(b.data.values);

export async function loadNotes(ld: Loader): Promise<void> {
  const owner = ld.memberOfFile("hritvik");
  const base = ld.sheet("base", "Guide");
  if (owner && base) {
    for (const s of guideSections(base)) {
      if (s.lines.length === 0) continue;
      const sup = SUPERSEDED[s.title.toUpperCase()];
      if (sup) {
        const r = ld.book.raise({
          origin: ld.origin(s.first), code: "superseded_guide_fact", kind: "mechanical",
          problem: `Guide section "${s.title}" holds facts ${sup.by} has since replaced.`,
          proposed_fix: `Import it as version 1 of the "${sup.topic}" note, with the newer text as version 2.`,
          proposal: sup.topic,
        });
        if (!r.apply) continue;
      }
      await ld.write("write_member_note", { member: owner, topic: sup?.topic ?? `guide: ${s.title}`, body: s.lines.join("\n") }, ld.origin(s.first), { key: "note" });
    }
    const copy = ld.sheet("hritvik", "Guide");
    if (copy && !sameGrid(base, copy)) {
      ld.book.raise({
        origin: { file: "hritvik", tab: "Guide", row: 1 }, code: "guide_copy_differs", kind: "semantic",
        problem: "Hritvik's Guide tab is no longer an exact copy of the base Guide.",
        proposed_fix: "Compare the two and say which text is current; only base is imported meanwhile.", proposal: null,
      });
    }
  }
  // People's target basis: the newest text on targets (version 2 after the Guide's, for Hritvik).
  for (const row of ld.sheet("base", "People")?.rows() ?? []) {
    const cfg = ld.members.members.find((m) => m.name.toLowerCase() === row.text("A").toLowerCase());
    if (!cfg || !row.text("N") || !ld.facts.has(`member:${cfg.name}`)) continue;
    await ld.write("write_member_note", { member: cfg.name, topic: "targets", body: row.text("N") }, ld.origin(row), { key: "note_targets" });
  }
  for (const [tab, topic] of [["Meal Prep", "meal prep"], ["Exercise Library", "exercise library"]] as const) {
    const sheet = ld.sheet("base", tab);
    if (!sheet) continue;
    const body = tabText(sheet);
    if (body) await ld.write("write_member_note", { member: null, topic, body }, { file: "base", tab, row: 1 }, { key: "note" });
  }
  for (const file of Object.keys(PERSON_FILES)) {
    const member = ld.memberOfFile(file);
    if (!member || !ld.facts.has(`member:${member}`)) continue;
    await loadHandover(ld, file, member);
    for (const tab of ["Cardio", "Log", "Program"]) await headerProse(ld, file, tab, member);
  }
}

function tabText(sheet: Sheet): string {
  const lines: string[] = [];
  for (let n = 1; n <= sheet.data.rows; n++) {
    const cells = (sheet.data.values[n - 1] ?? []).map((c) => c.trim()).filter(Boolean);
    if (cells.length > 0) lines.push(cells.join(" | "));
  }
  return lines.join("\n");
}

async function headerProse(ld: Loader, file: string, tab: string, member: string): Promise<void> {
  const sheet = ld.sheet(file, tab);
  if (!sheet || sheet.data.rows === 0) return;
  const header = sheet.row(1);
  for (let i = 0; i < sheet.data.cols; i++) {
    const col = colLetter(i);
    const text = header.rendered(col).trim();
    if (text.length > 40) await ld.write("write_member_note", { member, topic: `${tab}: header ${col}`, body: text }, ld.origin(header), { key: `note_${col}` });
  }
}

function firstDate(text: string): string | null {
  const m = /(\d{1,2} [A-Z][a-z]{2} \d{4})/.exec(text);
  if (!m) return null;
  try {
    return parseDate(m[1] as string).value;
  } catch {
    return null;
  }
}

async function loadHandover(ld: Loader, file: string, member: string): Promise<void> {
  const sheet = ld.sheet(file, "Handover");
  if (!sheet) return;
  const fields = new Map<string, Row>();
  for (let n = 4; n <= sheet.data.rows; n++) {
    const row = sheet.row(n);
    if (row.text("A")) fields.set(row.text("A").toLowerCase(), row);
  }
  const value = (f: string) => fields.get(f)?.rendered("B").trim() ?? "";
  let effective: string | null = null;
  const eff = fields.get("status effective");
  if (eff) {
    try {
      effective = parseDate(eff.raw("B")).value;
    } catch (error) {
      if (!(error instanceof ParseError)) throw error;
    }
  }
  const done = new Set<string>();
  // Program status and the active restriction are one note.
  const status = ["program status", "active restriction"].filter((f) => value(f)).map((f) => `${fields.get(f)?.text("A")}: ${value(f)}`);
  if (status.length > 0) {
    const first = (fields.get("program status") ?? fields.get("active restriction")) as Row;
    await ld.write("write_member_note", { member, topic: "programme status", body: status.join("\n") }, ld.origin(first), { key: "note" });
  }
  done.add("program status").add("active restriction");
  if (value("weekly schedule")) {
    await ld.write("write_member_note", { member, topic: "training plan", body: value("weekly schedule") }, ld.origin(fields.get("weekly schedule") as Row), { key: "note" });
  }
  done.add("weekly schedule");
  for (const [f, row] of fields) {
    if (done.has(f) || DERIVED_FIELDS.test(f) || !value(f)) continue;
    await ld.write("write_member_note", { member, topic: `handover: ${row.text("A")}`, body: value(f) }, ld.origin(row), { key: "note" });
  }
  // Flags: an active restriction that is not "none", and any field that is a flag.
  for (const [f, row] of fields) {
    const text = value(f);
    const isFlag = (f === "active restriction" && text && !/^none\b/i.test(text)) || /\bflag\b/i.test(f);
    if (!isFlag || !text) continue;
    // A flag row is named by its field ("Sleep / OSA flag"); a restriction by its first sentence.
    const subject = /\bflag\b/i.test(f)
      ? (row.text("A").replace(/\s*\bflag\b\s*/i, " ").trim() || row.text("A"))
      : (text.split(/\.\s/)[0] ?? text).replace(/\.$/, "").slice(0, 120);
    const raised = firstDate(text) ?? effective ?? ld.at.slice(0, 10);
    const proposal = { member, subtype: /\bas an event\b|\bevent\b/i.test(text) ? "event" : "health_watch", subject, raised_on: raised, note: text };
    const r = ld.book.raise<Record<string, unknown>>({
      origin: ld.origin(row), code: "flag_from_handover", kind: "semantic",
      problem: `Handover "${row.text("A")}" describes an open item in prose, which the app keeps as a flag.`,
      proposed_fix: `Raise an open ${proposal.subtype} flag "${subject}", raised ${raised}.`,
      proposal, row: row.cells(["A"]),
    });
    if (!r.apply) continue;
    const res = await ld.write("raise_flag", r.value, ld.origin(row), { key: "flag" });
    if (res) ld.record(ld.origin(row), { table: "flag", id: (res.flag as { id: number }).id, tool: "raise_flag" });
  }
}

export async function loadAudit(ld: Loader): Promise<void> {
  for (const file of ["base", ...Object.keys(PERSON_FILES)]) {
    const member = file === "base" ? null : ld.memberOfFile(file);
    for (const row of ld.sheet(file, "Agent Audit")?.rows() ?? []) {
      const origin = ld.origin(row);
      const rd = new RowReader(ld, row);
      let date: string | null = null;
      let time: string | null = null;
      try {
        date = rd.date("A");
      } catch (error) {
        if (!(error instanceof ParseError)) throw error;
      }
      if (!date) {
        ld.book.raise({ origin, code: "unreadable_date", kind: "semantic", problem: `Date "${row.text("A")}" is not a date.`, proposed_fix: "Give the date, or leave the row out.", proposal: null, row: row.cells(["A", "B", "C", "D"]) });
        continue;
      }
      try {
        time = parseTime(row.raw("B")).value;
      } catch {
        const r = ld.book.raise<string>({ origin, code: "audit_time", kind: "semantic", problem: `Time "${row.text("B")}" is not a time of day.`, proposed_fix: "Keep the time as not recorded (the text stays in the result).", proposal: "not_recorded", row: row.cells(["A", "B"]) });
        if (!r.apply) continue;
      }
      rd.flush();
      const text = (c: string) => row.rendered(c).trim();
      const timeNote = time === null && text("B") ? `Time in Sheets: ${text("B")}` : "";
      await ld.write("add_legacy_audit_entry", {
        source_file: file, ...(member ? { member } : {}), logged_on: date, ...(time ? { logged_time: time } : {}),
        ...(text("C") ? { agent: text("C") } : {}), action: text("D"),
        ...(text("E") ? { target: text("E") } : {}), ...(text("F") ? { reason: text("F") } : {}),
        ...(text("G") ? { prior_value: text("G") } : {}), ...([text("H"), timeNote].filter(Boolean).length ? { result: [text("H"), timeNote].filter(Boolean).join("; ") } : {}),
      }, origin, { evidence: row, key: "add_legacy_audit_entry" });
    }
  }
}
