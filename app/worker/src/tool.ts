import { z } from "zod";
import { WRITE_FIELDS, type Ctx, type WriteFields } from "./context";
import { profilesForTool } from "./tool-capabilities";

export type ToolResult = Record<string, unknown>;

export interface Tool {
  name: string;
  group: string;
  description: string;
  write: boolean;
  input: z.ZodType;
  run(ctx: Ctx, input: unknown): Promise<ToolResult>;
}

/** A read tool: no idempotency key, never writes. */
export function readTool<S extends z.ZodRawShape>(def: {
  name: string;
  group: string;
  description: string;
  input: S;
  run(ctx: Ctx, input: z.infer<z.ZodObject<S>>): Promise<ToolResult>;
}): Tool {
  return {
    name: def.name,
    group: def.group,
    description: def.description,
    write: false,
    input: z.object(def.input).strict(),
    run: (ctx, input) => def.run(ctx, input as z.infer<z.ZodObject<S>>),
  };
}

/** A write tool: takes the common write fields, runs inside one transaction. */
export function writeTool<S extends z.ZodRawShape>(def: {
  name: string;
  group: string;
  description: string;
  input: S;
  run(ctx: Ctx, input: z.infer<z.ZodObject<S>> & WriteFields): Promise<ToolResult>;
}): Tool {
  return {
    name: def.name,
    group: def.group,
    description: def.description,
    write: true,
    input: z.object({ ...def.input, ...WRITE_FIELDS }).strict(),
    run: (ctx, input) => def.run(ctx, input as z.infer<z.ZodObject<S>> & WriteFields),
  };
}

/** The listing GET /tools serves, from which the MCP server is generated. */
export function describeTools(tools: readonly Tool[]): unknown[] {
  return tools.map((t) => ({
    name: t.name,
    group: t.group,
    description: t.description,
    write: t.write,
    profiles: profilesForTool(t.name),
    endpoint: `/tools/${t.name}`,
    input_schema: z.toJSONSchema(t.input, { io: "input", unrepresentable: "any" }),
  }));
}
