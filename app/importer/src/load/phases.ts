/**
 * Phases (ticket *Triage*, rule 2: phases with an energy stance and intent
 * at cutover).
 *
 * - The base Guide's PHASE MAP is Hritvik's (the base Guide is his,
 *   DECISIONS 31): one dated phase per "Wk ..." row, through
 *   upsert_phase. Dates are read from the row ("3 Aug - 11
 *   Oct 2026", "12 Oct.", "17-30 May."), the year carried forward and
 *   rolled over at January; a phase given only its start ends the day
 *   before the next one starts. The stance is read from the words
 *   (deficit / cut, maintenance, surplus); a row that states none, or more
 *   than one, is a semantic ruling with a proposal.
 * - A member with no phase map gets one phase proposed from their Handover
 *   (Status effective as the start) and the People goal (Cut is a deficit),
 *   as a semantic ruling, applied while pending.
 */
import { addDays } from "@myfitnessguide/domain";
import type { Row } from "../grid";
import { PERSON_FILES } from "../layout";
import { parseDate } from "../parse";
import type { Loader } from "./context";

type Stance = "deficit" | "maintenance" | "surplus";

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

interface MapRow {
  row: Row;
  name: string;
  intent: string;
  starts: string;
  ends: string | null;
  stance: Stance | null;
  stances: Stance[];
}

/** The stances a phase row's words name. */
export function stancesIn(text: string): Stance[] {
  const t = text.toLowerCase();
  const out: Stance[] = [];
  if (/\bdeficit\b|\bcut\b|mini-cut/.test(t)) out.push("deficit");
  if (/\bmaintenance\b/.test(t)) out.push("maintenance");
  if (/\bsurplus\b/.test(t)) out.push("surplus");
  return out;
}

const iso = (y: number, m: number, d: number) => `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;

/**
 * The start (and end, when given) of a phase row, with the year carried
 * from the rows before it. Returns null when the row names no date.
 */
export function phaseDates(text: string, carry: { year: number | null; month: number }): { starts: string; ends: string | null } | null {
  const mon = (s: string | undefined) => (s ? MONTHS.indexOf(s.slice(0, 3).toLowerCase()) + 1 : 0);
  const range = /(\d{1,2})(?:\s+([A-Za-z]{3}))?(?:\s+(\d{4}))?\s*-\s*(\d{1,2})\s+([A-Za-z]{3})[a-z]*(?:\s+(\d{4}))?/.exec(text);
  const single = /(\d{1,2})\s+([A-Za-z]{3})[a-z]*(?:\s+(\d{4}))?/.exec(text);
  const place = (month: number, explicit: string | undefined) => {
    if (explicit) carry.year = Number(explicit);
    else if (carry.year !== null && month < carry.month) carry.year += 1;
    carry.month = month;
    return carry.year;
  };
  if (range && mon(range[5]) > 0) {
    const endMonth = mon(range[5]);
    const startMonth = mon(range[2]) || endMonth;
    if (startMonth === 0) return null;
    // The end's year, when written, also dates the start (one earlier across December).
    const endYearGiven = range[6] ? Number(range[6]) : null;
    let startYear: number | null;
    if (range[3]) startYear = place(startMonth, range[3]);
    else if (endYearGiven !== null && carry.year === null) {
      startYear = startMonth > endMonth ? endYearGiven - 1 : endYearGiven;
      carry.year = startYear;
      carry.month = startMonth;
    } else startYear = place(startMonth, undefined);
    const endYear = place(endMonth, range[6]);
    if (startYear === null || endYear === null) return null;
    return { starts: iso(startYear, startMonth, Number(range[1])), ends: iso(endYear, endMonth, Number(range[4])) };
  }
  if (single && mon(single[2]) > 0) {
    const month = mon(single[2]);
    const year = place(month, single[3]);
    return year === null ? null : { starts: iso(year, month, Number(single[1])), ends: null };
  }
  return null;
}

function phaseMap(ld: Loader): MapRow[] {
  const guide = ld.sheet("base", "Guide");
  if (!guide) return [];
  const out: MapRow[] = [];
  let inMap = false;
  const carry = { year: null as number | null, month: 0 };
  for (const row of guide.rows(1)) {
    const section = row.text("A");
    if (section) inMap = /^phase map$/i.test(section);
    if (!inMap || !/^wk\b/i.test(row.text("B"))) continue;
    const detail = row.text("C");
    const dates = phaseDates(detail, carry);
    if (!dates) {
      ld.book.raise({
        origin: ld.origin(row), code: "phase_dates", kind: "semantic",
        problem: `Phase map row "${row.text("B")}" names no date the importer can read ("${detail}").`,
        proposed_fix: "Give the phase's dates, or leave it out.", proposal: null, row: row.cells(["B", "C"]),
      });
      continue;
    }
    const name = (detail.split(".")[0] ?? detail).split(",")[0]?.trim() || row.text("B");
    const stances = stancesIn(detail);
    out.push({ row, name, intent: `${row.text("B")}: ${detail}`, ...dates, stance: stances.length === 1 ? (stances[0] as Stance) : null, stances });
  }
  // A phase given only its start ends the day before the next one starts.
  for (const [i, p] of out.entries()) {
    const next = out[i + 1];
    if (p.ends === null && next) p.ends = addDays(next.starts, -1);
  }
  return out;
}

export async function loadPhases(ld: Loader): Promise<void> {
  // The base Guide is Hritvik's.
  const owner = ld.memberOfFile("hritvik");
  const map = phaseMap(ld);
  if (owner && map.length > 0) {
    for (const p of map) {
      let stance = p.stance;
      if (stance === null) {
        const named = p.stances;
        const r = ld.book.raise<Stance>({
          origin: ld.origin(p.row), code: "phase_energy_stance", kind: "semantic",
          problem: named.length > 1
            ? `Phase "${p.name}" names more than one energy stance (${named.join(" to ")}).`
            : `Phase "${p.name}" states no energy stance.`,
          proposed_fix: named.length > 1 ? `Use ${named.at(-1)}, where the phase ends up, or give the stance as override.` : "Use maintenance, or give the stance as override.",
          proposal: named.length > 1 ? (named.at(-1) as Stance) : "maintenance", row: p.row.cells(["B", "C"]),
        });
        if (!r.apply) continue;
        stance = r.value;
      }
      await ld.write("upsert_phase", {
        member: owner,
        name: p.name,
        starts_on: p.starts,
        ends_on: p.ends,
        energy_stance: stance,
        intent: p.intent,
        change_reason: "Imported phase map",
      }, ld.origin(p.row), { evidence: p.row, key: "upsert_phase" });
    }
  }
  for (const file of Object.keys(PERSON_FILES)) {
    const member = ld.memberOfFile(file);
    if (!member || (member === owner && map.length > 0)) continue;
    await handoverPhase(ld, file, member);
  }
}

async function handoverPhase(ld: Loader, file: string, member: string): Promise<void> {
  const sheet = ld.sheet(file, "Handover");
  if (!sheet) return;
  const field = (name: string) => sheet.rows(1).find((r) => r.text("A").toLowerCase() === name);
  const status = field("program status");
  const effective = field("status effective");
  if (!status) return;
  let starts: string | null = null;
  try {
    starts = effective ? parseDate(effective.raw("B")).value : null;
  } catch {
    starts = null;
  }
  const person = ld.sheet("base", "People")?.rows().find((r) => r.text("A").toLowerCase() === member.toLowerCase());
  const goal = person?.text("G") ?? "";
  const stances = stancesIn(goal);
  const proposal = starts
    ? {
        name: goal || "Current phase", starts_on: starts, energy_stance: stances.length === 1 ? stances[0] : "maintenance",
        intent: `People goal: ${goal || "not stated"}. Handover program status: ${status.text("B")}`,
      }
    : null;
  const r = ld.book.raise<{ name: string; starts_on: string; energy_stance: Stance; intent: string } | null>({
    origin: ld.origin(status), code: "phase_from_handover", kind: "semantic",
    problem: `${member} has no phase map; the Handover says only "${status.text("B")}"${goal ? ` and People's goal is "${goal}"` : ""}.`,
    proposed_fix: proposal ? `Start one phase "${proposal.name}" on ${proposal.starts_on} (the Handover's Status effective), stance ${proposal.energy_stance}, open-ended.` : "Give the phase (name, starts_on, energy_stance, intent), or leave it out.",
    proposal, row: status.cells(["A", "B"]),
  });
  if (!r.apply || !r.value) return;
  await ld.write("upsert_phase", { member, ...r.value, ends_on: null, change_reason: "Proposed from the Handover" }, ld.origin(status), { evidence: status, key: "upsert_phase" });
}
