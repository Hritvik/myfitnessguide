import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema, type Tool as McpTool } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { Tool } from "./tool";
import { selectToolsForProfile } from "./tool-capabilities";

const RESERVED_WRITE_FIELDS = ["origin", "speaker", "reason", "resolver_detail", "channel"] as const;
const REASONED_WRITE_TOOLS = new Set([
  "update_recipe", "set_recipe_archived", "update_workout", "set_workout_archived",
  "create_programme", "update_programme", "set_programme_archived", "upsert_phase", "set_phase_archived",
]);

export type InvokeMemberTool = (tool: Tool, input: Record<string, unknown>) => Promise<Response>;

function publicSchema(tool: Tool): McpTool["inputSchema"] {
  const schema = structuredClone(z.toJSONSchema(tool.input, { io: "input", unrepresentable: "any" })) as McpTool["inputSchema"] & {
    required?: string[];
  };
  if (schema.type !== undefined && schema.type !== "object") {
    throw new Error(`Public MCP tool ${tool.name} has a non-object input schema.`);
  }
  const objectSchema = { ...schema, type: "object" as const };
  if (!tool.write) return objectSchema;
  const properties = { ...(objectSchema.properties ?? {}) };
  for (const field of RESERVED_WRITE_FIELDS) delete properties[field];
  if (properties.idempotency_key && typeof properties.idempotency_key === "object") {
    properties.idempotency_key = {
      ...properties.idempotency_key,
      description: "Optional retry key. Reuse it for the same logical write; omit it when the client cannot expose retry keys.",
    };
  }
  return {
    ...objectSchema,
    properties,
    required: [...new Set([
      ...(objectSchema.required ?? []).filter((field) => field !== "idempotency_key" && !RESERVED_WRITE_FIELDS.includes(field as (typeof RESERVED_WRITE_FIELDS)[number])),
      ...(REASONED_WRITE_TOOLS.has(tool.name) ? ["change_reason"] : []),
    ])],
  };
}

function listedTool(tool: Tool): McpTool {
  return {
    name: tool.name,
    description: publicDescription(tool),
    inputSchema: publicSchema(tool),
    annotations: { readOnlyHint: !tool.write, destructiveHint: tool.write, openWorldHint: false },
  };
}

const PUBLIC_TOOL_GUIDANCE: Readonly<Record<string, string>> = {
  catalogue_search:
    "Search before creating or logging a food. Reuse a strong existing match; a partial match is only a clue, not permission to log the wrong food.",
  upsert_food_source:
    "Search the catalogue first and create only when the food is genuinely missing. Prefer the member's product link or label, then the manufacturer's official page, then a reputable retailer or nutrition source. If required label facts are still missing or the variant is ambiguous, ask the member for the label or clarification before calling this tool. Never invent macros, serving weights, food state, or zero values; omitted optional nutrients mean unknown. Record the source and check date in assumptions/last_checked_on.",
  add_measure:
    "Add a household measure only when its amount in the food's reference unit is known from the label, an authoritative source, or the member. Ask the member rather than guessing.",
  add_yield:
    "Add a yield only for two states of the same food and only when the conversion is known. Ask the member rather than guessing.",
  learn_alias:
    "Teach an alias only after the intended existing catalogue record is unambiguous; aliases are household-wide.",
};

function publicDescription(tool: Tool): string {
  const guidance = PUBLIC_TOOL_GUIDANCE[tool.name];
  return guidance ? `${tool.description}\n\nRemote client workflow: ${guidance}` : tool.description;
}

function reservedField(input: Record<string, unknown>): string | null {
  return RESERVED_WRITE_FIELDS.find((field) => Object.hasOwn(input, field)) ?? null;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

async function requestKey(connectionScope: string, clientKey: string): Promise<string> {
  // The client names one logical write and reuses that name only for retries.
  // Scope it to this authorization so two clients cannot collide or replay it.
  const digest = async (value: string): Promise<string> => {
    const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
    return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  };
  return `mcp:${(await digest(connectionScope)).slice(0, 24)}:${await digest(clientKey)}`;
}

/** Handle one authenticated member request using stateless Streamable HTTP. */
export async function handleRemoteMcp(request: Request, connectionScope: string, tools: readonly Tool[], invoke: InvokeMemberTool): Promise<Response> {
  const publicTools = selectToolsForProfile(tools, "remoteMember");
  const byName = new Map(publicTools.map((tool) => [tool.name, tool]));
  const server = new Server({ name: "myfitnessguide", version: "0.1.0" }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: publicTools.map(listedTool) }));
  server.setRequestHandler(CallToolRequestSchema, async (call, extra) => {
    const tool = byName.get(call.params.name);
    if (!tool) return { content: [{ type: "text", text: `No public tool named ${call.params.name}.` }], isError: true };
    const input = (call.params.arguments ?? {}) as Record<string, unknown>;
    if (tool.write) {
      const field = reservedField(input);
      if (field) return { content: [{ type: "text", text: `Refused reserved field ${field}; the server supplies audit metadata.` }], isError: true };
      if (input.idempotency_key !== undefined && (typeof input.idempotency_key !== "string" || input.idempotency_key.length < 1 || input.idempotency_key.length > 200)) {
        return { content: [{ type: "text", text: "When supplied, idempotency_key must be 1-200 characters." }], isError: true };
      }
      if (REASONED_WRITE_TOOLS.has(tool.name) && (typeof input.change_reason !== "string" || input.change_reason.trim().length === 0)) {
        return { content: [{ type: "text", text: `Tool ${tool.name} requires change_reason so the member's rationale is preserved in audit history.` }], isError: true };
      }
    }
    const clientKey = typeof input.idempotency_key === "string"
      ? `client:${input.idempotency_key}`
      : `request:${String(extra.requestId)}:${canonical({ name: tool.name, arguments: input, meta: call.params._meta ?? null })}`;
    const changeReason = typeof input.change_reason === "string" ? input.change_reason : null;
    const body = tool.write
      ? { ...input, idempotency_key: await requestKey(connectionScope, clientKey), reason: changeReason ?? `remote MCP: ${tool.name}` }
      : input;
    const response = await invoke(tool, body);
    const text = await response.text();
    return { content: [{ type: "text", text }], ...(response.ok ? {} : { isError: true }) };
  });

  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true, maxRequestBodySize: 256 * 1024 });
  await server.connect(transport);
  return transport.handleRequest(request);
}
