import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, onTestFinished, vi } from "vitest";

const layoutTest = (title: string) => ({ id: title, title, parent: { project: () => ({ name: "layout" }) } });
const result = (retry: number, status: string, attachments: Record<string, string>) => ({
  retry,
  status,
  error: status === "passed" ? undefined : { message: "boom" },
  attachments: Object.entries(attachments).map(([name, body]) => ({ name, body: Buffer.from(body), contentType: "text/plain" })),
});

describe("the layout findings (e2e spec §8)", () => {
  it("records flags with their attempt, so a flag that didn't reproduce on retry shows, and loads over 2 s as slow", async () => {
    const run = mkdtempSync(join(tmpdir(), "gym-e2e-findings-"));
    process.env.E2E_RUN = run;
    onTestFinished(() => {
      rmSync(run, { recursive: true, force: true });
      delete process.env.E2E_RUN;
    });
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { default: Reporter } = await import("../e2e/support/findings-reporter");
    const r = new Reporter();
    const flag = JSON.stringify([{ kind: "spill", where: "main", text: "x", by: 3 }]);
    const on = (t: unknown, res: unknown) => r.onTestEnd(t as never, res as never);
    on(layoutTest("today at 390 light"), result(0, "failed", { flags: flag, load_ms: "2400" }));
    on(layoutTest("today at 390 light"), result(1, "passed", { load_ms: "900" }));
    on(layoutTest("train at 390 light"), result(0, "passed", { load_ms: "2000" }));
    on({ ...layoutTest("phone"), parent: { project: () => ({ name: "phone" }) } }, result(0, "passed", { load_ms: "9000" }));
    r.onEnd();
    const out = JSON.parse(readFileSync(join(run, "findings.json"), "utf8")) as { tests: number; findings: { test: string; retry: number }[]; slow: unknown[] };
    expect(out.tests).toBe(2);
    expect(out.findings).toEqual([{ kind: "spill", where: "main", text: "x", by: 3, test: "today at 390 light", retry: 0 }]);
    expect(out.slow).toEqual([{ test: "today at 390 light", retry: 0, ms: 2400 }]);
  });
});
