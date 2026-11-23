import { describe, expect, it } from "vitest";
import { setup, type As } from "./harness";
import { invented, WED } from "./invented";
import { TOOLS } from "../src/tools";

let requestId = 0;

async function mcp(
  raw: ReturnType<typeof setup>["raw"],
  method: string,
  params: Record<string, unknown>,
  as: As = "hritvik",
  options: { id?: string | number; authorization?: string } = {},
) {
  const reply = await raw("/mcp", {
    method: "POST",
    as,
    headers: {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      ...(options.authorization ? { authorization: options.authorization } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: options.id ?? ++requestId, method, params }),
  });
  return reply;
}

describe("the member-scoped remote MCP endpoint", () => {
  it("requires a known member and refuses service-token agents", async () => {
    const { raw } = setup();
    expect((await mcp(raw, "initialize", {}, "nobody")).http).toBe(401);
    expect((await mcp(raw, "initialize", {}, "stranger")).http).toBe(403);
    expect((await mcp(raw, "initialize", {}, "agent")).http).toBe(403);
  });

  it("speaks stateless Streamable HTTP and lists only the explicit public surface", async () => {
    const { raw } = setup();
    const initialized = await mcp(raw, "initialize", {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "test-client", version: "1" },
    });
    expect(initialized.http).toBe(200);
    expect(initialized.body.result.serverInfo.name).toBe("myfitnessguide");
    expect(initialized.body.result.capabilities.tools).toEqual({});

    const listed = await mcp(raw, "tools/list", {});
    expect(listed.http).toBe(200);
    const tools = listed.body.result.tools as { name: string; description?: string; inputSchema: { type?: string; properties?: Record<string, unknown>; required?: string[] } }[];
    for (const tool of tools) expect(tool.inputSchema.type, tool.name).toBe("object");
    const names = tools.map((tool) => tool.name);
    expect(names.sort()).toEqual(TOOLS.map((tool) => tool.name).filter((name) => name !== "query" && name !== "ask_member").sort());
    expect(names).toContain("log_intake");
    expect(names).toContain("whoami");
    expect(names).toContain("waiting");
    expect(names).toContain("analytics");
    expect(names).toContain("answer_question");
    expect(names).toContain("inventory_gaps");
    expect(names).not.toContain("ask_member");
    expect(names).not.toContain("query");
    expect(names).toContain("triage_feedback");
    expect(names).toContain("upsert_food_source");
    expect(names).toContain("add_measure");
    expect(names).toContain("add_yield");
    expect(names).toContain("update_recipe");
    expect(names).toContain("set_recipe_archived");
    expect(names).toContain("update_workout");
    expect(names).toContain("set_workout_archived");
    expect(names).toContain("create_programme");
    expect(names).toContain("update_programme");
    expect(names).toContain("set_programme_archived");
    expect(names).toContain("upsert_phase");
    expect(names).toContain("set_phase_archived");
    expect(names).toContain("active_session");
    expect(names).toContain("catalogue_dependents");
    expect(names).toContain("learn_alias");
    expect(names).toContain("forget_alias");
    expect(names).toContain("household_planning_context");
    expect(names).toContain("preview_meal_plan");
    expect(names).toContain("save_meal_plan");
    expect(names).toContain("meal_plan");
    expect(names).toContain("set_meal_plan_archived");

    const createFood = tools.find((tool) => tool.name === "upsert_food_source");
    expect(createFood?.description).toContain("Search the catalogue first");
    expect(createFood?.description).toContain("ask the member");
    expect(createFood?.description).toContain("Never invent");

    const logIntake = tools.find((tool) => tool.name === "log_intake");
    expect(logIntake?.description).toMatch(/standalone foods or existing recipe servings/i);
    expect(logIntake?.description).toMatch(/composed dishes/i);

    const householdMeal = tools.find((tool) => tool.name === "household_meal");
    expect(householdMeal?.description).toMatch(/named preparations made from ingredients/i);
    expect(householdMeal?.description).toMatch(/only one person/i);
    expect(householdMeal?.description).toContain("portions: []");

    const markRemainder = tools.find((tool) => tool.name === "mark_remainder");
    expect(markRemainder?.description).toMatch(/allocate shares after/i);
    expect(markRemainder?.description).toContain("day_cooks");

    const setTarget = tools.find((tool) => tool.name === "set_target");
    expect(setTarget?.description).toMatch(/effective-dated/i);
    expect(setTarget?.description).toMatch(/create a new .*target version/i);
    expect(setTarget?.inputSchema.properties).toHaveProperty("effective_from");

    const mealPlan = tools.find((tool) => tool.name === "preview_meal_plan");
    expect(mealPlan?.description).toMatch(/without writing/i);
    expect(mealPlan?.inputSchema.properties).toHaveProperty("entries");

    for (const name of ["save_meal_plan", "set_meal_plan_archived"]) {
      const lifecycle = tools.find((tool) => tool.name === name);
      expect(lifecycle?.inputSchema.properties, name).toHaveProperty("change_reason");
      expect(lifecycle?.inputSchema.properties, name).toHaveProperty("idempotency_key");
    }

    for (const name of ["update_recipe", "set_recipe_archived", "update_workout", "set_workout_archived", "create_programme", "update_programme", "set_programme_archived", "upsert_phase", "set_phase_archived"]) {
      const update = tools.find((tool) => tool.name === name);
      expect(update?.inputSchema.properties, name).toHaveProperty("change_reason");
      expect(update?.inputSchema.properties, name).not.toHaveProperty("reason");
      expect(update?.inputSchema.required, name).toContain("change_reason");
      expect(new Set(update?.inputSchema.required).size, name).toBe(update?.inputSchema.required?.length);
    }

    const write = tools.find((tool) => tool.name === "log_intake");
    expect(write?.inputSchema.properties).toHaveProperty("idempotency_key");
    expect(write?.inputSchema.properties).not.toHaveProperty("origin");
    expect(write?.inputSchema.properties).not.toHaveProperty("speaker");
    expect(write?.inputSchema.properties).not.toHaveProperty("resolver_detail");
    expect(write?.inputSchema.properties).not.toHaveProperty("channel");
    expect(write?.inputSchema.required).not.toContain("idempotency_key");
  });

  it("runs tools as the authenticated member and rejects audit-field injection", async () => {
    const { raw } = setup();
    const identity = await mcp(raw, "tools/call", { name: "whoami", arguments: {} }, "asha");
    expect(identity.http).toBe(200);
    expect(JSON.parse(identity.body.result.content[0].text).member).toBe("Asha");

    const missingReason = await mcp(raw, "tools/call", { name: "set_recipe_archived", arguments: { recipe: "R001", archived: true } });
    expect(missingReason.body.result.isError).toBe(true);
    expect(missingReason.body.result.content[0].text).toContain("requires change_reason");

    for (const [field, value] of Object.entries({
      origin: "inbox",
      speaker: "Kabir",
      reason: "forged",
      resolver_detail: "forged",
      channel: "local_agent",
    })) {
      const injected = await mcp(raw, "tools/call", {
        name: "log_intake",
        arguments: { member: "Asha", date: "2026-10-05", meal_slot: "lunch", items: [], [field]: value },
      });
      expect(injected.body.result.isError, field).toBe(true);
      expect(injected.body.result.content[0].text, field).toContain(`reserved field ${field}`);
    }

    const missingKey = await mcp(raw, "tools/call", {
      name: "set_day_status",
      arguments: { member: "Asha", date: "2026-10-05", status: "open" },
    }, "asha");
    expect(missingKey.body.result.isError).not.toBe(true);
  });

  it("lets a signed-in member create a missing catalogue food through the public MCP", async () => {
    const { raw } = setup();
    const created = await mcp(raw, "tools/call", {
      name: "upsert_food_source",
      arguments: {
        name: "Example label food",
        state: "as_sold",
        reference_amount: 100,
        reference_unit: "g",
        kcal: 200,
        protein_g: 20,
        carbs_g: 20,
        fat_g: 4.4,
        assumptions: "Manufacturer label supplied by the member; checked 2026-10-16.",
        last_checked_on: "2026-10-16",
        idempotency_key: "create-example-label-food",
      },
    });

    expect(created.http).toBe(200);
    const result = JSON.parse(created.body.result.content[0].text);
    expect(result).toMatchObject({
      status: "ok",
      action: "created",
      state: "confirmed",
      food_source: { name: "Example label food", ref: "FS001" },
    });
  });

  it("replays one logical write even when its bearer credential changes", async () => {
    const x = setup();
    const params = { name: "set_day_status", arguments: { member: "Hritvik", date: "2026-10-05", status: "open", idempotency_key: "same-write" } };
    const first = await mcp(x.raw, "tools/call", params, "hritvik", { id: "same-write", authorization: "Bearer old-token" });
    const replay = await mcp(x.raw, "tools/call", params, "hritvik", { id: "same-write", authorization: "Bearer refreshed-token" });

    expect(replay.body).toEqual(first.body);
    expect(x.t.get("SELECT count(*) AS n FROM write_log WHERE tool = 'set_day_status'")).toEqual({ n: 1 });
  });

  it("generates a stable retry key when a client cannot expose idempotency_key", async () => {
    const x = setup();
    const params = { name: "set_day_status", arguments: { member: "Hritvik", date: "2026-10-05", status: "open" } };
    const first = await mcp(x.raw, "tools/call", params, "hritvik", { id: "chatgpt-call-1", authorization: "Bearer old-token" });
    const replay = await mcp(x.raw, "tools/call", { name: "set_day_status", arguments: { status: "open", date: "2026-10-05", member: "Hritvik" } }, "hritvik", { id: "chatgpt-call-1", authorization: "Bearer refreshed-token" });

    expect(replay.body).toEqual(first.body);
    expect(x.t.get("SELECT count(*) AS n FROM write_log WHERE tool = 'set_day_status'")).toEqual({ n: 1 });
  });

  it("does not collide when a stateless client reuses a JSON-RPC id for different writes", async () => {
    const x = setup();
    const call = (date: string) => mcp(x.raw, "tools/call", {
      name: "set_day_status",
      arguments: { member: "Hritvik", date, status: "open" },
    }, "hritvik", { id: 1 });

    expect((await call("2026-10-05")).body.result.isError).not.toBe(true);
    expect((await call("2026-10-06")).body.result.isError).not.toBe(true);
    expect(x.t.get("SELECT count(*) AS n FROM write_log WHERE tool = 'set_day_status'")).toEqual({ n: 2 });
  });

  it("refuses changed input under the same logical write key", async () => {
    const x = setup();
    const call = (status: "open" | "complete") => mcp(x.raw, "tools/call", {
      name: "set_day_status",
      arguments: { member: "Hritvik", date: "2026-10-05", status, idempotency_key: "reused-write" },
    }, "hritvik");

    expect((await call("open")).body.result.isError).not.toBe(true);
    const changed = await call("complete");
    expect(changed.body.result.isError).toBe(true);
    expect(JSON.parse(changed.body.result.content[0].text).error.code).toBe("idempotency_key_reused");
  });

  it("isolates logical keys by member and keeps distinct keys distinct", async () => {
    const x = setup();
    const params = (member: string, key: string) => ({ name: "set_day_status", arguments: { member, date: "2026-10-05", status: "open", idempotency_key: key } });
    await mcp(x.raw, "tools/call", params("Hritvik", "same-key"), "hritvik");
    await mcp(x.raw, "tools/call", params("Asha", "same-key"), "asha");
    await mcp(x.raw, "tools/call", params("Hritvik", "different-key"), "hritvik");

    expect(x.t.get("SELECT count(*) AS n FROM write_log WHERE tool = 'set_day_status'")).toEqual({ n: 3 });
  });
});

describe("Waiting through the member MCP", () => {
  it("keeps private questions, quoted texts, sent entries and readings with their member", async () => {
    const x = invented();
    const text = "Asha's private food note";
    const sent = await x.ok("submit_to_inbox", { member: "Asha", date: WED, text, spans: [{ text, start: 0, end: text.length }] }, "asha");
    const question = (await x.ok("ask_member", { member: "Asha", text: "Which private meal?", choices: ["Lunch", "Dinner"], inbox_entry_id: sent.entry.id })).question;
    await x.ok("log_reading", { member: "Asha", date: WED, metric: "weight", value: 66.4, unit: "kg", body_state: "fasted", measurer: "not_recorded", speaker: "Kabir" });

    const own = await mcp(x.raw, "tools/call", { name: "waiting", arguments: {} }, "asha");
    const ownBody = JSON.parse(own.body.result.content[0].text);
    expect(ownBody).toMatchObject({ status: "ok", member: "Asha", asks: [{ kind: "question", id: question.id, quote: { text } }] });
    expect(ownBody.sent).toEqual([expect.objectContaining({ text })]);
    expect(ownBody.handoffs).toEqual([expect.objectContaining({ type: "reading" })]);

    const other = await mcp(x.raw, "tools/call", { name: "waiting", arguments: {} }, "kabir");
    expect(JSON.parse(other.body.result.content[0].text)).toMatchObject({ status: "ok", member: "Kabir", asks: [], sent: [], on_others: [] });
    expect(other.body.result.content[0].text).not.toContain(text);
    expect(other.body.result.content[0].text).not.toContain(question.text);
    const refused = await mcp(x.raw, "tools/call", { name: "waiting", arguments: { member: "Asha" } }, "kabir");
    expect(refused.body.result.isError).toBe(true);
    expect(JSON.parse(refused.body.result.content[0].text).error.code).toBe("not_visible");
  });

  it("lets only the recipient answer once, with member audit metadata, and keeps asking private", async () => {
    const x = invented();
    const question = (await x.ok("ask_member", { member: "Asha", text: "Which meal?", choices: ["Lunch", "Dinner"] })).question;
    const params = { name: "answer_question", arguments: { id: question.id, choice: "Lunch", idempotency_key: `answer-${question.id}` } };
    const injected = await mcp(x.raw, "tools/call", { ...params, arguments: { ...params.arguments, speaker: "Asha" } }, "kabir");
    expect(injected.body.result.isError).toBe(true);
    expect(injected.body.result.content[0].text).toContain("reserved field speaker");
    const refused = await mcp(x.raw, "tools/call", params, "kabir");
    expect(refused.body.result.isError).toBe(true);
    expect(JSON.parse(refused.body.result.content[0].text).error.code).toBe("not_yours");
    expect(x.t.get("SELECT status FROM question WHERE id = ?", question.id)).toEqual({ status: "open" });

    const answer = await mcp(x.raw, "tools/call", params, "asha");
    const result = JSON.parse(answer.body.result.content[0].text);
    expect(result.question).toMatchObject({ id: question.id, status: "answered", answer: "Lunch" });
    expect(x.t.get("SELECT member_id, created_by FROM inbox_entry WHERE id = ?", result.entry_id)).toEqual({ member_id: x.h.asha, created_by: x.h.asha });
    expect(x.t.get("SELECT channel, origin, actor_member_id, speaker_member_id FROM write_log ORDER BY id DESC LIMIT 1")).toEqual({ channel: "remote_mcp", origin: "app", actor_member_id: x.h.asha, speaker_member_id: null });

    const again = await mcp(x.raw, "tools/call", { ...params, arguments: { ...params.arguments, idempotency_key: `answer-${question.id}-again` } }, "asha");
    expect(again.body.result.isError).toBe(true);
    expect(JSON.parse(again.body.result.content[0].text).error.code).toBe("not_open");
    const ask = await mcp(x.raw, "tools/call", { name: "ask_member", arguments: { member: "Asha", text: "Which meal?", choices: ["Lunch"] } }, "asha");
    expect(ask.body.result.isError).toBe(true);
    expect(ask.body.result.content[0].text).toContain("No public tool named ask_member");
  });

  it("keeps inventory in its dedicated member tool", async () => {
    const x = invented();
    const gym = x.t.insert("gym", { household_id: x.h.id, name: "Sample Gym" });
    x.t.db.prepare("UPDATE member SET home_gym_id = ? WHERE id = ?").run(gym, x.h.asha);
    x.t.insert("implement", { gym_id: gym, name: "Row stack", kind: "cable", unit: "kg", loading: "total", load_list_complete: 0 });
    const gap = await mcp(x.raw, "tools/call", { name: "inventory_gaps", arguments: { member: "Asha" } }, "asha");
    expect(JSON.parse(gap.body.result.content[0].text)).toMatchObject({ status: "ok", member: "Asha", ask: { kind: "stack_top", implement: "Row stack" } });
    const waiting = await mcp(x.raw, "tools/call", { name: "waiting", arguments: {} }, "asha");
    expect(JSON.parse(waiting.body.result.content[0].text)).not.toHaveProperty("inventory");
  });
});
