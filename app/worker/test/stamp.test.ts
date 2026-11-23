import { spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { appendOverride, git, ignoredSource, installedTree, isoTime, matchingStamp, overridesForStamp, overridesSince, pendingOverrides, readOverrideLog, readOverrides, readStamps, stampDir, treeClean, treesAt, workingTrees, writeStamp, type Stamp } from "../scripts/stamp";

const GIT = ["-c", "user.email=t@example.com", "-c", "user.name=t", "-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false"];

function repo(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "gym-stamp-")));
  onTestFinished(() => {
    rmSync(dir, { recursive: true, force: true });
    rmSync(`${dir}-wt`, { recursive: true, force: true });
  });
  const run = (...args: string[]) => spawnSync("git", [...GIT, ...args], { cwd: dir });
  run("init", "-q", "-b", "main");
  mkdirSync(join(dir, "app"));
  writeFileSync(join(dir, "app", "a.ts"), "export const a = 1;\n");
  writeFileSync(join(dir, "package.json"), "{}\n");
  writeFileSync(join(dir, "package-lock.json"), "{}\n");
  writeFileSync(join(dir, "README.md"), "x\n");
  run("add", ".");
  run("commit", "-q", "-m", "one");
  return dir;
}
const commit = (dir: string, file: string, text: string) => {
  writeFileSync(join(dir, file), text);
  spawnSync("git", [...GIT, "commit", "-qam", file], { cwd: dir });
};
const stampFor = (dir: string, at = "2026-10-08T10:00:00Z"): Stamp => ({
  commit: git(dir, ["rev-parse", "HEAD"]), at, trees: treesAt(dir), installed: "h", playwright: "1.64.0", chromium: "x", counts: { passed: 1 }, wall_ms: 1, overrides: [],
});

describe("the stamp (e2e spec §9)", () => {
  it("clean means nothing modified and nothing untracked", () => {
    const dir = repo();
    expect(treeClean(dir)).toBe(true);
    writeFileSync(join(dir, "app", "new.ts"), "x");
    expect(treeClean(dir)).toBe(false);
  });

  it("matches by the trees of app/, package.json and package-lock.json, so a docs-only commit keeps the stamp", () => {
    const dir = repo();
    writeStamp(dir, stampFor(dir));
    commit(dir, "README.md", "y\n");
    expect(matchingStamp(readStamps(dir), treesAt(dir))).not.toBeNull();
    commit(dir, "app/a.ts", "export const a = 2;\n");
    expect(matchingStamp(readStamps(dir), treesAt(dir))).toBeNull();
    commit(dir, "package-lock.json", "{ }\n");
    expect(matchingStamp(readStamps(dir), treesAt(dir))).toBeNull();
  });

  it("lives in the git common directory, shared by every worktree and never committed", () => {
    const dir = repo();
    const other = `${dir}-wt`;
    spawnSync("git", [...GIT, "worktree", "add", "-q", other], { cwd: dir });
    expect(stampDir(other)).toBe(stampDir(dir));
    expect(stampDir(dir)).toBe(join(dir, ".git", "e2e-pass"));
    writeStamp(other, stampFor(other));
    expect(readStamps(dir)).toHaveLength(1);
    expect(treeClean(dir)).toBe(true);
    expect(treeClean(other)).toBe(true);
  });

  it("overrides are appended and listed until the next stamp", () => {
    const dir = repo();
    writeStamp(dir, stampFor(dir, "2026-10-08T10:00:00Z"));
    appendOverride(dir, { commit: "abc", reason: "hotfix: the cron", at: "2026-10-08T12:00:00Z" });
    expect(overridesSince(readOverrides(dir), readStamps(dir))).toEqual([{ commit: "abc", reason: "hotfix: the cron", at: "2026-10-08T12:00:00Z" }]);
    writeStamp(dir, { ...stampFor(dir, "2026-10-09T10:00:00Z"), commit: "later" });
    expect(overridesSince(readOverrides(dir), readStamps(dir))).toEqual([]);
  });

  it("writes a stamp whole or not at all (temp file and rename), and a corrupt stamp is reported and ignored", () => {
    const dir = repo();
    writeStamp(dir, stampFor(dir));
    expect(readdirSync(stampDir(dir))).toEqual([`${git(dir, ["rev-parse", "HEAD"])}.json`]);
    writeFileSync(join(stampDir(dir), "half.json"), '{"commit": "ab');
    writeFileSync(join(stampDir(dir), "odd.json"), '{"commit": "ab"}');
    writeFileSync(join(stampDir(dir), "x.json.tmp-1"), "{");
    const bad: string[] = [];
    expect(readStamps(dir, (file, why) => bad.push(`${file}: ${why}`))).toHaveLength(1);
    expect(bad).toHaveLength(2);
    expect(bad[0]).toMatch(/^half\.json: /);
    expect(bad[1]).toBe("odd.json: not a stamp");
    expect(readStamps(dir)).toHaveLength(1);
  });

  it("a corrupt override line is reported and skipped", () => {
    const dir = repo();
    appendOverride(dir, { commit: "abc", reason: "r", at: "2026-10-08T12:00:00.000Z" });
    appendFileSync(join(stampDir(dir), "overrides.jsonl"), "{nope\n");
    const bad: string[] = [];
    expect(readOverrides(dir, (line) => bad.push(line))).toEqual([{ commit: "abc", reason: "r", at: "2026-10-08T12:00:00.000Z" }]);
    expect(bad).toEqual(["{nope"]);
  });

  it("isoTime is the one time format (UTC, milliseconds) for stamps and overrides; overridesSince compares instants", () => {
    expect(isoTime(new Date("2026-10-08T17:30:00+05:30"))).toBe("2026-10-08T12:00:00.000Z");
    expect(isoTime("2026-10-08T12:00:00Z")).toBe("2026-10-08T12:00:00.000Z");
    expect(() => isoTime("not a time")).toThrow(/not a time/);
    const stamp = { at: "2026-10-08T12:00:00Z" } as Stamp;
    // As strings "…00.5Z" < "…00Z"; as instants it is later.
    expect(overridesSince([{ commit: "c", reason: "r", at: "2026-10-08T12:00:00.5Z" }], [stamp])).toHaveLength(1);
  });

  it("installedTree hashes the installed dependency tree and says where it disagrees with package-lock.json", () => {
    const dir = repo();
    const lock = { packages: { "": { name: "root" }, "node_modules/a": { version: "1.0.0", integrity: "sha-a" }, "node_modules/opt": { version: "1.0.0", optional: true } } };
    writeFileSync(join(dir, "package-lock.json"), JSON.stringify(lock));
    expect(installedTree(dir).problems).toEqual(["node_modules/.package-lock.json is missing: run npm install"]);
    mkdirSync(join(dir, "node_modules"));
    const hidden = (packages: Record<string, unknown>) => writeFileSync(join(dir, "node_modules", ".package-lock.json"), JSON.stringify({ packages }));
    hidden({ "node_modules/a": { version: "1.0.0", integrity: "sha-a" } });
    const ok = installedTree(dir);
    expect(ok.problems).toEqual([]);
    expect(ok.hash).toMatch(/^[0-9a-f]{64}$/);
    hidden({ "node_modules/a": { version: "1.0.1", integrity: "sha-b" }, "node_modules/b": { version: "2.0.0" } });
    const drifted = installedTree(dir);
    expect(drifted.hash).not.toBe(ok.hash);
    expect(drifted.problems).toEqual([
      "node_modules doesn't match package-lock.json: node_modules/a is 1.0.1 installed, 1.0.0 locked",
      "node_modules doesn't match package-lock.json: node_modules/b is installed but not locked",
    ]);
    hidden({});
    expect(installedTree(dir).problems).toEqual(["node_modules doesn't match package-lock.json: node_modules/a is locked but not installed"]);
  });

  it("ignoredSource lists source-like files under app/ that an ignore hides, outside node_modules, dist and .wrangler", () => {
    const dir = repo();
    writeFileSync(join(dir, ".gitignore"), "node_modules/\ndist/\n.wrangler/\n*.local\nwrangler*.jsonc\n");
    // A global ignore the repository can't see: .git/info/exclude stands in for core.excludesFile.
    mkdirSync(join(dir, ".git", "info"), { recursive: true });
    writeFileSync(join(dir, ".git", "info", "exclude"), "secret.ts\nhidden/\n");
    spawnSync("git", [...GIT, "add", ".gitignore"], { cwd: dir });
    spawnSync("git", [...GIT, "commit", "-qm", "ignore"], { cwd: dir });
    const put = (path: string) => {
      mkdirSync(join(dir, path, ".."), { recursive: true });
      writeFileSync(join(dir, path), "x");
    };
    put("app/web/node_modules/y.ts");
    put("app/web/dist/z.js");
    put("app/worker/.wrangler/state/d1.sql");
    put("app/notes.local");
    // The local-only deployment config is read and checked by the gate itself (check 2).
    put("app/worker/wrangler.jsonc");
    expect(ignoredSource(dir)).toEqual([]);
    // The exemption is those paths alone: another ignored wrangler config is still hidden source.
    put("app/worker/wrangler.extra.jsonc");
    expect(ignoredSource(dir)).toEqual(["app/worker/wrangler.extra.jsonc"]);
    rmSync(join(dir, "app/worker/wrangler.extra.jsonc"));
    put("app/secret.ts");
    put("app/hidden/deep/a.css");
    put("app/hidden/b.png");
    expect(treeClean(dir)).toBe(true);
    expect(ignoredSource(dir)).toEqual(["app/hidden/deep/a.css", "app/secret.ts"]);
  });

  it("a stamp or override whose time doesn't parse is reported and skipped (task 9 re-review)", () => {
    const dir = repo();
    writeStamp(dir, stampFor(dir));
    writeFileSync(join(stampDir(dir), "late.json"), JSON.stringify({ ...stampFor(dir), commit: "late", at: "tomorrow" }));
    const bad: string[] = [];
    expect(readStamps(dir, (file, why) => bad.push(`${file}: ${why}`)).map((s) => s.commit)).toEqual([git(dir, ["rev-parse", "HEAD"])]);
    expect(bad).toEqual(["late.json: not a stamp"]);
    appendOverride(dir, { commit: "abc", reason: "r", at: "2026-10-08T12:00:00.000Z" });
    appendFileSync(join(stampDir(dir), "overrides.jsonl"), `${JSON.stringify({ commit: "c", reason: "r", at: "soon" })}\n`);
    const badLines: string[] = [];
    expect(readOverrides(dir, (line) => badLines.push(line)).map((o) => o.commit)).toEqual(["abc"]);
    expect(badLines).toHaveLength(1);
  });

  it("ignoredSource sees every source-like extension, and paths git would C-quote (task 9 re-review)", () => {
    const dir = repo();
    mkdirSync(join(dir, ".git", "info"), { recursive: true });
    writeFileSync(join(dir, ".git", "info", "exclude"), "*.cjs\n*.cts\n*.html\n*.jsonc\nna*ve.ts\nwith space/\nq*.ts\n");
    const put = (path: string) => {
      mkdirSync(join(dir, path, ".."), { recursive: true });
      writeFileSync(join(dir, path), "x");
    };
    for (const f of ["app/a.cjs", "app/b.cts", "app/c.html", "app/d.jsonc", "app/na\u00efve.ts", "app/with space/e.ts", 'app/q"uote.ts']) put(f);
    expect(treeClean(dir)).toBe(true);
    expect(ignoredSource(dir)).toEqual(["app/a.cjs", "app/b.cts", "app/c.html", "app/d.jsonc", "app/na\u00efve.ts", 'app/q"uote.ts', "app/with space/e.ts"]);
  });

  it("an override appended while a run stamps is listed by the next run, never lost (task 10 fix round 1)", () => {
    const dir = repo();
    const o = (reason: string, at: string) => ({ commit: "abc", reason, at });
    appendOverride(dir, o("before", "2026-10-08T09:00:00.000Z"));
    // The run's stamp: its time is taken, then it reads the log.
    const at = "2026-10-08T12:00:00.000Z";
    const forStamp = overridesForStamp(dir);
    expect(forStamp.overrides.map((x) => x.reason)).toEqual(["before"]);
    // A deploy took its time before the stamp's but appends after the read.
    appendOverride(dir, o("during", "2026-10-08T11:59:59.999Z"));
    writeStamp(dir, { ...stampFor(dir, at), overrides: forStamp.overrides, overridesRead: forStamp.read });
    // By time alone it would be lost: it is older than the stamp.
    expect(overridesSince(readOverrides(dir), readStamps(dir))).toEqual([]);
    expect(pendingOverrides(readOverrideLog(dir), readStamps(dir)).map((x) => x.reason)).toEqual(["during"]);
    // The next stamp records it, and then nothing is pending.
    const next = overridesForStamp(dir);
    expect(next.overrides.map((x) => x.reason)).toEqual(["during"]);
    writeStamp(dir, { ...stampFor(dir, "2026-10-09T12:00:00.000Z"), commit: "next", overrides: next.overrides, overridesRead: next.read });
    expect(overridesForStamp(dir).overrides).toEqual([]);
  });

  it("the override log counts only whole lines, lists everything if it was replaced, and falls back to time without overridesRead", () => {
    const dir = repo();
    appendOverride(dir, { commit: "a", reason: "one", at: "2026-10-08T09:00:00.000Z" });
    const whole = readOverrideLog(dir).size;
    appendFileSync(join(stampDir(dir), "overrides.jsonl"), '{"commit":"b","reason":"half"');
    expect(readOverrideLog(dir)).toMatchObject({ size: whole, entries: [{ end: whole }] });
    writeStamp(dir, { ...stampFor(dir, "2026-10-08T10:00:00.000Z"), overridesRead: whole + 1000 });
    expect(pendingOverrides(readOverrideLog(dir), readStamps(dir)).map((x) => x.reason)).toEqual(["one"]);
    expect(pendingOverrides(readOverrideLog(dir), [stampFor(dir, "2026-10-08T08:00:00.000Z")]).map((x) => x.reason)).toEqual(["one"]);
    expect(pendingOverrides(readOverrideLog(dir), [stampFor(dir, "2026-10-08T10:00:00.000Z")])).toEqual([]);
  });

  it("workingTrees is HEAD's trees on a clean tree and sees tracked and untracked changes, without touching the index", () => {
    const dir = repo();
    expect(workingTrees(dir)).toEqual(treesAt(dir));
    writeFileSync(join(dir, "app", "a.ts"), "export const a = 2;\n");
    const changed = workingTrees(dir);
    expect(changed.app).not.toBe(treesAt(dir).app);
    expect(changed.packageJson).toBe(treesAt(dir).packageJson);
    writeFileSync(join(dir, "app", "new.ts"), "x");
    expect(workingTrees(dir).app).not.toBe(changed.app);
    expect(git(dir, ["diff", "--cached", "--name-only"])).toBe("");
    // Nothing staged: the status is still a modified file and an untracked one.
    expect(git(dir, ["status", "--porcelain"]).split("\n").map((l) => l.trim())).toEqual(["M app/a.ts", "?? app/new.ts"]);
  });

  it("git() throws with git's own message when a command fails", () => {
    const dir = repo();
    expect(() => git(dir, ["rev-parse", "HEAD:nope"])).toThrow(/git rev-parse HEAD:nope/);
  });
});
