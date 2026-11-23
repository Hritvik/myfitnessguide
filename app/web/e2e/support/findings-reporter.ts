/**
 * Writes findings.json for the layout project into the run directory (e2e spec
 * §8): every flag with its test and attempt (a flag on the first attempt that
 * didn't reproduce on the retry still shows, and the run is flaky: no stamp),
 * the tests that failed otherwise, the loads (goto and settle) over 2 s as
 * `slow` (informational, as the old sweep listed them), and the wall time from
 * before the build and seed (the 10-minute budget includes them).
 */
import { writeFileSync } from "node:fs";
import type { Reporter, TestCase, TestResult } from "@playwright/test/reporter";
import { paths, runDir } from "./run.ts";

/** A load slower than this is listed in `slow` (the old sweep's 2 s). */
export const SLOW_MS = 2_000;

interface Finding {
  kind: string;
  where: string;
  text: string;
  by: number;
  test: string;
  retry: number;
}

export default class FindingsReporter implements Reporter {
  private readonly started = Date.now();
  private readonly tests = new Set<string>();
  private readonly findings: Finding[] = [];
  private readonly failed: { test: string; retry: number; error: string }[] = [];
  private readonly slow: { test: string; retry: number; ms: number }[] = [];

  onTestEnd(test: TestCase, result: TestResult): void {
    if (test.parent.project()?.name !== "layout") return;
    this.tests.add(test.id);
    const load = result.attachments.find((a) => a.name === "load_ms");
    const ms = load?.body ? Number(load.body.toString()) : 0;
    if (ms > SLOW_MS) this.slow.push({ test: test.title, retry: result.retry, ms });
    const flags = result.attachments.find((a) => a.name === "flags");
    if (flags?.body) {
      for (const f of JSON.parse(flags.body.toString()) as Omit<Finding, "test" | "retry">[]) this.findings.push({ ...f, test: test.title, retry: result.retry });
    } else if (result.status === "failed" || result.status === "timedOut") {
      this.failed.push({ test: test.title, retry: result.retry, error: (result.error?.message ?? "").slice(0, 200) });
    }
  }

  onEnd(): void {
    if (this.tests.size === 0) return;
    const wall_ms = Date.now() - this.started;
    writeFileSync(paths(runDir()).findings, JSON.stringify({ wall_ms, tests: this.tests.size, findings: this.findings, failed: this.failed, slow: this.slow }, null, 2));
    console.log(`layout: ${this.findings.length} flags, ${this.failed.length} failed, ${this.slow.length} slow loads, ${this.tests.size} tests, wall_ms ${wall_ms}`);
  }
}
