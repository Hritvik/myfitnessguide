import type { QuarantineEntry } from "./support/verdict.ts";

/**
 * Tests that flaked twice in a week (e2e spec §11). Each still runs and
 * reports, but doesn't block the run, for 7 days from `since` (the wall
 * calendar's date, not the household's fixed one); then it blocks again. Its
 * failure or flake still denies the deploy stamp (F7). At most 3 entries.
 * Never a privacy test. `title` is the full title the run's summary prints
 * for it. Remove an entry when its fix lands.
 */
export const QUARANTINE: readonly QuarantineEntry[] = [];
