import type { Page, Request } from "@playwright/test";

/** One /tools call as the page made it: its input, and its answer or why it failed. */
export interface ToolCall {
  tool: string;
  method: string;
  input: Record<string, any> | null;
  status: number | null;
  body: string;
  failed: string | null;
}

const isTool = (url: string) => /\/tools(\/|$)/.test(new URL(url).pathname);

/** Every /tools request a page makes, kept with its answer: the privacy probes read the bodies, the failure cases the keys. */
export class ToolLog {
  readonly calls: ToolCall[] = [];
  private readonly pending: Promise<void>[] = [];

  constructor(page: Page) {
    this.watch(page);
  }

  watch(page: Page): void {
    page.on("requestfinished", (r) => {
      if (isTool(r.url())) this.pending.push(this.record(r, null));
    });
    page.on("requestfailed", (r) => {
      if (isTool(r.url())) this.pending.push(this.record(r, r.failure()?.errorText ?? "failed"));
    });
  }

  private async record(request: Request, failed: string | null): Promise<void> {
    // A request still being read when the test (and its context) ends has no answer to keep; that is not a failure,
    // but the call says why it has no answer, so it never looks like one that finished (task 13 review M1).
    const response = failed ? null : await request.response().catch((e: Error) => ((failed = `unread: ${e.message}`), null));
    let input: Record<string, any> | null = null;
    try {
      input = request.postDataJSON() as Record<string, any> | null;
    } catch {
      input = null;
    }
    this.calls.push({
      tool: new URL(request.url()).pathname.replace(/^\/tools\/?/, ""),
      method: request.method(),
      input,
      status: response?.status() ?? null,
      body: response ? await response.text().catch(() => "") : "",
      failed,
    });
  }

  async settled(): Promise<ToolCall[]> {
    await Promise.all(this.pending);
    return this.calls;
  }

  /** The calls to a write tool (they carry an idempotency key). */
  async writes(tool: string | RegExp): Promise<ToolCall[]> {
    const match = (t: string) => (typeof tool === "string" ? t === tool : tool.test(t));
    return (await this.settled()).filter((c) => match(c.tool) && c.input !== null && "idempotency_key" in c.input);
  }

  /** The parsed answer of the last call to `tool`. */
  async lastBody(tool: string | RegExp): Promise<any> {
    const match = (t: string) => (typeof tool === "string" ? t === tool : tool.test(t));
    const last = [...(await this.settled())].reverse().find((c) => match(c.tool) && c.status !== null);
    if (!last) throw new Error(`no answered call to ${String(tool)}`);
    return JSON.parse(last.body) as unknown;
  }
}
