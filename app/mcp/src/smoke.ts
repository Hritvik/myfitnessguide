// Live smoke test: ONE read-only GET /tools against the configured API with the
// service token, through the same client the server uses. Never calls a tool.
import { ApiClient } from "./api.ts";
import { loadConfig } from "./config.ts";

const config = loadConfig();
const log = (line: string): void => {
  process.stderr.write(`[smoke] ${line}\n`);
};
try {
  const tools = await new ApiClient({ baseUrl: config.baseUrl, tokenFile: config.tokenFile, log }).listTools();
  const writes = tools.filter((t) => t.write).length;
  log(`GET ${config.baseUrl}/tools: ${tools.length} tools (${writes} writes, ${tools.length - writes} reads)`);
  log(tools.map((t) => t.name).join(", "));
} catch (error) {
  log(`FAILED: ${(error as Error).message}`);
  process.exit(1);
}
