/**
 * The household's members as the import needs them: who they are, their
 * Access email, programming mode, week anchor and home gym. Read from
 * ~/.config/myfitnessguide/members.json, which holds real emails and is never
 * committed. When it is missing, the importer writes one with placeholder
 * emails for Hritvik to fill in before the final load.
 */
import { existsSync, readFileSync } from "node:fs";
import { z } from "zod";

export const MembersConfigSchema = z
  .object({
    household: z.string().min(1),
    members: z
      .array(
        z
          .object({
            name: z.string().min(1),
            /** The person file key (hritvik, asha, kabir). */
            file: z.string().min(1),
            email: z.string().min(3),
            programming_mode: z.enum(["prescribed", "record_only"]),
            week_anchor_date: z.iso.date().nullable().optional(),
            gym: z.string().min(1),
          })
          .strict(),
      )
      .min(1),
  })
  .strict();

export type MembersConfig = z.infer<typeof MembersConfigSchema>;
export type MemberConfig = MembersConfig["members"][number];

/**
 * Defaults, from the repo's own (non-sensitive) facts: shared/config.yml's
 * week1_anchor for Hritvik, and *Training schema*'s amendment that Asha is
 * record-only (trainer-led). Emails are placeholders.
 */
export function placeholderMembers(): MembersConfig {
  return {
    household: "Household",
    members: [
      { name: "Hritvik", file: "hritvik", email: "hritvik@placeholder.invalid", programming_mode: "prescribed", week_anchor_date: "2026-07-26", gym: "Hritvik's gym" },
      { name: "Asha", file: "asha", email: "asha@placeholder.invalid", programming_mode: "record_only", week_anchor_date: null, gym: "Asha's gym" },
      { name: "Kabir", file: "kabir", email: "kabir@placeholder.invalid", programming_mode: "prescribed", week_anchor_date: null, gym: "Kabir's gym" },
    ],
  };
}

export function isPlaceholder(config: MembersConfig): boolean {
  return config.members.some((m) => m.email.endsWith(".invalid"));
}

export function loadMembers(path: string): { config: MembersConfig; created: boolean } {
  if (!existsSync(path)) return { config: placeholderMembers(), created: true };
  return { config: MembersConfigSchema.parse(JSON.parse(readFileSync(path, "utf8"))), created: false };
}
