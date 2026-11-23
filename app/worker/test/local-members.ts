/** An invented household for the entry tests: Asha and Kabir active, Ira inactive. */
import { SqliteDb } from "./sqlite";

const NOW = "2026-10-08T00:00:00Z";

export function sampleDb(): SqliteDb {
  const db = new SqliteDb();
  const household = db.test.insert("household", { name: "Sample household", created_at: NOW });
  for (const [name, email, active] of [
    ["Asha", "asha@example.com", 1],
    ["Kabir", "kabir@example.com", 1],
    ["Ira", "ira@example.com", 0],
  ] as const) {
    db.test.insert("member", { household_id: household, name, email, programming_mode: "record_only", active, created_at: NOW });
  }
  return db;
}

/** POST /tools/whoami at `host` (a hostname with an optional port, or a bracketed IPv6 address). */
export function whoamiAt(host: string, headers: Record<string, string> = {}): Request {
  return new Request(`http://${host}/tools/whoami`, { method: "POST", body: "{}", headers: { "content-type": "application/json", ...headers } });
}

/** The signed-in member's name on 200; otherwise the status. */
export async function memberOf(response: Response): Promise<string | number> {
  if (response.status !== 200) return response.status;
  return ((await response.json()) as { member: string }).member;
}
