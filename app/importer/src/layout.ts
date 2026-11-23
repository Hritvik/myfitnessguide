/**
 * Where things live outside the repo, and which tabs a complete snapshot
 * holds. Tab names come from `shared/config.yml` and the research
 * inventory (`docs/research/sheets-raw-vs-rendered.md`).
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

export const DATA_DIR = join(homedir(), ".local", "share", "myfitnessguide");
export const SNAPSHOT_DIR = join(DATA_DIR, "snapshots");
export const MEMBERS_FILE = join(homedir(), ".config", "myfitnessguide", "members.json");
export const SHARED_CONFIG = fileURLToPath(new URL("../../../shared/config.yml", import.meta.url));

/** The person files, keyed by the importer's file key, with the member name each belongs to. */
export const PERSON_FILES = { hritvik: "Hritvik", asha: "Asha", kabir: "Kabir" } as const;
export type PersonFile = keyof typeof PERSON_FILES;
export type FileKey = "base" | PersonFile;

const PERSON_TABS = ["Catalogue", "Today", "Nutrition", "Daily Nutrition", "Log", "Program", "Cardio", "Body", "Charts", "Chart Data", "Handover", "Agent Audit"];

export const EXPECTED_TABS: Record<FileKey, readonly string[]> = {
  base: ["People", "Exercise Library", "Recipes", "Food Sources", "Meal Prep", "Guide", "Recipe Ingredients", "Agent Audit", "Meal Plan"],
  hritvik: [...PERSON_TABS, "Trajectory", "Bloods", "Guide"],
  asha: [...PERSON_TABS, "Bloods"],
  kabir: PERSON_TABS,
};

/** Spreadsheet ids per file key, from shared/config.yml. */
export function spreadsheetIds(configPath = SHARED_CONFIG): Record<FileKey, string> {
  const config = parse(readFileSync(configPath, "utf8")) as { files: Record<string, string> };
  return {
    base: config.files.base as string,
    hritvik: config.files.Hritvik as string,
    asha: config.files.Asha as string,
    kabir: config.files.Kabir as string,
  };
}

/** ISO 8601 basic format (20261005T190721Z): a timestamp that is safe in a file name. */
export function basicTimestamp(iso: string): string {
  return iso.replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
}
