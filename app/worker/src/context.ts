import { z } from "zod";
import { all, type Db } from "./db";
import { Clarify, ToolError } from "./errors";
import type { OwnerOnly } from "./owner-only";
import type { WriteTx } from "./write";

export type Resolver = "claude_code" | "hosted_model";
export type WriteChannel = "web" | "remote_mcp" | "local_agent" | "unattended" | "import";
export type ServiceChannel = Extract<WriteChannel, "local_agent" | "unattended">;
export interface ServicePrincipal {
  resolver: Resolver;
  channel: ServiceChannel;
}
export type Origin = "live" | "coach" | "inbox" | "app" | "import";
export type RecordState = "draft" | "confirmed";

/** Who is calling: a member through the app, or the agent through a service token. */
export type Caller =
  | { kind: "member"; memberId: number; householdId: number; name: string; channel?: Extract<WriteChannel, "web" | "remote_mcp"> }
  | { kind: "agent"; resolver: Resolver | "importer"; householdId: number; clientId: string; channel?: ServiceChannel | "import" };

export interface Member {
  id: number;
  household_id: number;
  name: string;
  email: string;
  programming_mode: "prescribed" | "record_only";
  home_gym_id: number | null;
  week_anchor_date: string | null;
  active: number;
}

/** Fields every write takes besides its own. */
export const WRITE_FIELDS = {
  idempotency_key: z.string().min(1).max(200).describe("Unique per write; a retry with the same key returns the original response."),
  origin: z
    .enum(["live", "coach", "inbox"])
    .optional()
    .describe("Agent only. live (default): chat with `speaker`; coach: a Coach-mode session; inbox: an unattended resolver."),
  speaker: z.string().optional().describe("Agent only. The member the agent is talking with (required for live and coach)."),
  reason: z.string().min(1).optional().describe("Why this write was made; goes to the write log."),
  resolver_detail: z.string().optional().describe("Free text about the resolver, such as a model or session id."),
};

export type WriteFields = {
  idempotency_key: string;
  origin?: "live" | "coach" | "inbox" | undefined;
  speaker?: string | undefined;
  reason?: string | undefined;
  resolver_detail?: string | undefined;
};

export interface WriteInfo {
  origin: Origin;
  speaker: Member | null;
  onBehalfOf: number | null;
}

export type { OwnerOnly } from "./owner-only";

export class Ctx {
  private memberCache: Member[] | null = null;
  tx: WriteTx | null = null;
  write: WriteInfo | null = null;

  constructor(
    readonly db: Db,
    readonly caller: Caller,
    readonly clock: () => Date,
    readonly timeZone: string,
    /** The household's members, when the caller lookup already read them (decision 96). */
    members: Member[] | null = null,
  ) {
    this.memberCache = members;
  }

  get householdId(): number {
    return this.caller.householdId;
  }

  nowIso(): string {
    return isoSeconds(this.clock());
  }

  /** Today's date in the household's time zone. */
  today(): string {
    return new Intl.DateTimeFormat("en-CA", { timeZone: this.timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(
      this.clock(),
    );
  }

  async members(): Promise<Member[]> {
    if (!this.memberCache) {
      this.memberCache = await all<Member>(this.db, "SELECT * FROM member WHERE household_id = ? ORDER BY id", this.householdId);
    }
    return this.memberCache;
  }

  /** A member by name or email, ignoring case; asks when unknown. */
  async member(ref: string, path: (string | number)[] = ["member"]): Promise<Member> {
    const members = await this.members();
    const key = ref.trim().toLowerCase();
    const found = members.find((m) => m.name.toLowerCase() === key || m.email.toLowerCase() === key);
    if (!found) {
      throw new Clarify("unknown_member", `Who is "${ref}"?`, members.map((m) => m.name), path);
    }
    return found;
  }

  async memberById(id: number): Promise<Member> {
    const found = (await this.members()).find((m) => m.id === id);
    if (!found) throw new ToolError("not_found", `no member ${id}`, 404);
    return found;
  }

  /** Owner-only data: its member and the agent see it, nobody else. A null owner is household data. */
  canSee(ownerMemberId: number | null): boolean {
    if (this.caller.kind === "agent") return true;
    return ownerMemberId === null || ownerMemberId === this.caller.memberId;
  }

  assertCanSee(kind: OwnerOnly, ownerMemberId: number | null): void {
    if (!this.canSee(ownerMemberId)) {
      throw new ToolError("not_visible", `${kind} records are visible only to their member`, 403);
    }
  }

  /**
   * An Inbox text is its sender's (decision 157): the agent sees every one,
   * a member only those they sent (`created_by`). The one refusal for the
   * rule: `inbox_entries` passes the member named, so a member names only themselves.
   */
  assertSentInbox(createdBy: number | null): void {
    if (this.caller.kind === "member" && createdBy !== this.caller.memberId) {
      throw new ToolError("not_visible", "an Inbox text is visible only to the member who sent it", 403);
    }
  }

  get txOrThrow(): WriteTx {
    if (!this.tx) throw new Error("not a write");
    return this.tx;
  }

  get writeInfo(): WriteInfo {
    if (!this.write) throw new Error("not a write");
    return this.write;
  }

  /**
   * A read that previews a write decides draft or confirmed as that write
   * would: a member's call as their own app write; the agent's as a live
   * write with no speaker, so any member's record would be a draft.
   */
  async previewWrite(): Promise<void> {
    this.write =
      this.caller.kind === "member"
        ? { origin: "app", speaker: await this.memberById(this.caller.memberId), onBehalfOf: null }
        : { origin: "live", speaker: null, onBehalfOf: null };
  }

  /** Record which member this write is on behalf of (the write log keeps one). */
  onBehalfOf(memberId: number | null): void {
    this.writeInfo.onBehalfOf = memberId;
  }

  /**
   * Confirmation (Agent API surface): a live write about the speaker's own
   * member is confirmed. A write about another member, or from the Inbox,
   * is a draft that auto-confirms after 48 h. Coach-mode training records
   * stay drafts until end_session. Household-level records (memberId null)
   * follow the origin alone. Imported records are the Sheets history,
   * already accepted, so the importer confirms them.
   */
  stateFor(memberId: number | null, options: { coach?: boolean } = {}): RecordState {
    const w = this.writeInfo;
    if (w.origin === "import") return "confirmed";
    if (w.origin === "inbox") return "draft";
    if (w.origin === "coach" && options.coach) return "draft";
    if (memberId !== null && memberId !== w.speaker?.id) return "draft";
    return "confirmed";
  }

  stamp(state: RecordState): { state: RecordState; confirmed_at: string | null } {
    return { state, confirmed_at: state === "confirmed" ? this.nowIso() : null };
  }
}

export function isoSeconds(d: Date): string {
  return d.toISOString().replace(/\.\d{3}Z$/, "Z");
}
