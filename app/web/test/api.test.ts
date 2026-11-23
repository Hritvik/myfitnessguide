import { describe, expect, it, vi } from "vitest";
import { callTool, failedToReach, type FetchLike } from "../src/api";

function reply(status: number, body: unknown): FetchLike {
  return async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("callTool", () => {
  it("POSTs JSON to /tools/<name> on the same origin, with no credentials of its own", async () => {
    const seen: { url: string; init: RequestInit }[] = [];
    const fetcher: FetchLike = async (url, init) => {
      seen.push({ url: String(url), init: init ?? {} });
      return new Response(JSON.stringify({ status: "ok", member: "Asha" }), { status: 200 });
    };
    const out = await callTool("whoami", {}, { fetch: fetcher });
    expect(out).toEqual({ kind: "ok", data: { status: "ok", member: "Asha" } });
    expect(seen[0]?.url).toBe("/tools/whoami");
    expect(seen[0]?.init.method).toBe("POST");
    expect(seen[0]?.init.body).toBe("{}");
    expect(new Headers(seen[0]?.init.headers).get("content-type")).toBe("application/json");
    expect(seen[0]?.init.credentials).toBe("same-origin");
  });

  it("turns needs_clarification into the question to show, never an error", async () => {
    const out = await callTool("amend", {}, {
      fetch: reply(200, { status: "needs_clarification", reason: "portions_exceed_whole", question: "That is more than the whole pot. What is right?", options: [], path: ["changes"] }),
    });
    expect(out).toEqual({ kind: "needs_clarification", question: "That is more than the whole pot. What is right?", options: [], reason: "portions_exceed_whole", path: ["changes"] });
  });

  it("turns an invalid request into a message naming the first issue", async () => {
    const out = await callTool("amend", {}, {
      fetch: reply(400, { status: "invalid", issues: [{ path: ["changes", "fraction"], message: "Too big: expected number to be <=1", code: "too_big" }] }),
    });
    expect(out).toEqual({ kind: "invalid", message: "changes.fraction: Too big: expected number to be <=1" });
  });

  it("turns an API error into its code and message", async () => {
    const out = await callTool("confirm", {}, { fetch: reply(409, { status: "error", error: { code: "not_draft", message: "portion 4 is already confirmed" } }) });
    expect(out).toEqual({ kind: "error", code: "not_draft", message: "portion 4 is already confirmed", http: 409 });
  });

  it("treats 401 and 403 from Access or the API as signed out", async () => {
    expect(await callTool("whoami", {}, { fetch: reply(401, { status: "error", error: { code: "unauthenticated", message: "no valid Access identity" } }) })).toEqual({
      kind: "signed_out",
      http: 401,
    });
    expect(await callTool("whoami", {}, { fetch: reply(403, { status: "error", error: { code: "forbidden", message: "not a member" } }) })).toEqual({
      kind: "signed_out",
      http: 403,
    });
  });

  it("keeps a 403 about one record's visibility as an error, not a sign-out", async () => {
    const out = await callTool("flags", {}, { fetch: reply(403, { status: "error", error: { code: "not_visible", message: "flag records are visible only to their member" } }) });
    expect(out).toMatchObject({ kind: "error", code: "not_visible", http: 403 });
  });

  it("treats a redirect to the Access login (an opaque or HTML reply) as signed out", async () => {
    const html: FetchLike = async () => new Response("<html>Sign in</html>", { status: 200, headers: { "content-type": "text/html" } });
    expect(await callTool("whoami", {}, { fetch: html })).toEqual({ kind: "signed_out", http: 200 });
    const opaque: FetchLike = async () => ({ type: "opaqueredirect", status: 0, ok: false }) as Response;
    expect(await callTool("whoami", {}, { fetch: opaque })).toEqual({ kind: "signed_out", http: 0 });
  });

  it("reports a network failure as offline only when the browser has no connection", async () => {
    const down: FetchLike = async () => {
      throw new TypeError("Failed to fetch");
    };
    vi.stubGlobal("navigator", { onLine: false });
    expect(await callTool("whoami", {}, { fetch: down })).toEqual({ kind: "offline" });
    vi.stubGlobal("navigator", { onLine: true });
    expect(await callTool("whoami", {}, { fetch: down })).toEqual({ kind: "error", code: "no_answer", message: "The server didn't answer.", http: 0 });
    vi.unstubAllGlobals();
  });

  it("classifies a request with no answer: offline only when navigator.onLine is false", () => {
    expect(failedToReach(false)).toEqual({ kind: "offline" });
    expect(failedToReach(true)).toMatchObject({ kind: "error", code: "no_answer", http: 0 });
    expect(failedToReach(undefined)).toMatchObject({ kind: "error", code: "no_answer" });
  });

  it("reports a server failure that isn't JSON as an error to retry", async () => {
    const boom: FetchLike = async () => new Response("Internal Server Error", { status: 500, headers: { "content-type": "text/plain" } });
    expect(await callTool("whoami", {}, { fetch: boom })).toEqual({ kind: "error", code: "http_500", message: "The server failed (HTTP 500).", http: 500 });
  });
});
