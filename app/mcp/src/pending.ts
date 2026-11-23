// `npm run pending -w @myfitnessguide/mcp`: exit 0 nothing pending, 10 something
// pending, anything else an error (decision 22). This file runs the check
// unconditionally, however it is started (a symlink, a wrapper, another
// name), so it can never fall through to exit 0 without asking; the logic
// lives in pending-check.ts.
import { loadConfig } from "./config.ts";
import { checkPending, describe, exitCodeFor, FAILED, type PendingResult } from "./pending-check.ts";

process.exitCode = FAILED; // until the check has answered
let result: PendingResult;
try {
  const config = loadConfig();
  result = await checkPending({ baseUrl: config.baseUrl, tokenFile: config.tokenFile });
} catch (error) {
  result = { ok: false, reason: (error as Error).message };
}
process.stderr.write(`[pending] ${describe(result)}\n`);
process.exit(exitCodeFor(result));
