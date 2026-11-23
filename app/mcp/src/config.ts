import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const DEFAULT_API_URL = "https://myfitnessguide.hritvikdinkar.workers.dev";

export interface Config {
  baseUrl: string;
  tokenFile: string;
  cacheFile: string;
  /** Unattended mode (DECISIONS.md, decision 21): every write is stamped origin `inbox`. */
  unattended: boolean;
}

/**
 * `MYFITNESSGUIDE_UNATTENDED`: `1` turns unattended mode on; unset, empty or `0`
 * leaves it off. Any other value stops startup, so a typo ("true", "yes")
 * can never start an interactive server under a scheduler.
 */
export function unattendedFrom(value: string | undefined): boolean {
  if (value === undefined || value === "" || value === "0") return false;
  if (value === "1") return true;
  throw new Error(`MYFITNESSGUIDE_UNATTENDED must be 1 or 0 (or unset); got ${JSON.stringify(value.slice(0, 20))}`);
}

function configuredPath(current: string | undefined, legacy: string | undefined, preferred: string, old: string): string {
  if (current) return current;
  if (legacy) return legacy;
  return existsSync(preferred) || !existsSync(old) ? preferred : old;
}

/**
 * Legacy `GYM_TRACKER_*` variables and paths remain readable during migration.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env, home: string = env.HOME || homedir()): Config {
  if (env.MYFITNESSGUIDE_UNATTENDED !== undefined && env.GYM_TRACKER_UNATTENDED !== undefined
    && env.MYFITNESSGUIDE_UNATTENDED !== env.GYM_TRACKER_UNATTENDED) {
    throw new Error("MYFITNESSGUIDE_UNATTENDED conflicts with legacy GYM_TRACKER_UNATTENDED");
  }
  return {
    baseUrl: env.MYFITNESSGUIDE_API_URL || env.GYM_TRACKER_API_URL || DEFAULT_API_URL,
    tokenFile: configuredPath(env.MYFITNESSGUIDE_TOKEN_FILE, env.GYM_TRACKER_TOKEN_FILE, join(home, ".config", "myfitnessguide", "access-service-token.json"), join(home, ".config", "gym-tracker", "access-service-token.json")),
    cacheFile: configuredPath(env.MYFITNESSGUIDE_TOOLS_CACHE, env.GYM_TRACKER_TOOLS_CACHE, join(home, ".cache", "myfitnessguide", "tools.json"), join(home, ".cache", "gym-tracker", "tools.json")),
    unattended: unattendedFrom(env.MYFITNESSGUIDE_UNATTENDED ?? env.GYM_TRACKER_UNATTENDED),
  };
}
