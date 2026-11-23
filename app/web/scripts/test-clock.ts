/**
 * The test household's fixed clock (e2e spec §3, "The day", amended 9 Oct
 * 2026; worker decision 162): the invented household lives
 * on Wednesday 7 October 2026 at 10:00 in Asia/Kolkata, whatever the wall
 * clock says. The suite's seed (--fixed-clock) and slots' Workers read it as LOCAL_FIXED_NOW
 * (src/dev-entry.ts), and every browser context the suite makes fixes its
 * Date to it (page.clock), so no screen shows a date or time that moves
 * between runs. The one definition; nothing else names the instant.
 */
export const FIXED_NOW = "2026-10-07T04:30:00Z";
/** FIXED_NOW's household date (Asia/Kolkata). */
export const FIXED_DAY = "2026-10-07";
