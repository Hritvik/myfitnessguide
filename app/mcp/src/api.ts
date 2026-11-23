import { readFileSync } from "node:fs";

export const VERSION = "0.1.0";

/**
 * Cloudflare answers error 1010 to default library user agents, so every
 * request names this client.
 */
export const USER_AGENT = `myfitnessguide-mcp/${VERSION} (Claude Code MCP server; node ${process.version})`;

export const ACCESS_REFUSED =
  "Access refused: check the service token or the Agent policy (must be Service Auth).";

/** One entry of the Worker's `GET /tools` listing. */
export interface ApiTool {
  name: string;
  description?: string;
  write?: boolean;
  profiles: { remoteMember: boolean; interactiveAgent: boolean; unattended: boolean };
  input_schema: Record<string, unknown>;
}

export interface ApiClientOptions {
  baseUrl: string;
  tokenFile: string;
  log: (line: string) => void;
  /** Per request, including the body. Default 30 s. */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;

interface ServiceToken {
  client_id: string;
  client_secret: string;
}

/** What came back from the API, before any MCP mapping. */
export type ApiReply =
  /** The Worker answered with JSON (any HTTP status). */
  | { kind: "json"; status: number; body: Record<string, unknown>; headers: Headers }
  /** Cloudflare Access answered instead of the Worker: a login redirect or an HTML page. */
  | { kind: "access_refused"; status: number }
  /** Anything else: a non-JSON body from somewhere in between. */
  | { kind: "other"; status: number; text: string };

/**
 * Read `{client_id, client_secret}`. Errors name the file and never quote it:
 * JSON.parse's own message quotes the start of the input, which may be the secret.
 */
export function readToken(file: string): ServiceToken {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? "unreadable";
    throw new Error(`could not read the service token file ${file} (${code})`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`the service token file ${file} is not valid JSON; expected {"client_id": "...", "client_secret": "..."}`);
  }
  const t = parsed as Partial<ServiceToken> | null;
  if (!t || typeof t.client_id !== "string" || typeof t.client_secret !== "string" || !t.client_id || !t.client_secret) {
    throw new Error(`the service token file ${file} must hold non-empty string fields client_id and client_secret`);
  }
  return { client_id: t.client_id, client_secret: t.client_secret };
}

/** The API could not be reached at all; a write may or may not have applied. */
export class Unreachable extends Error {}

export class ApiClient {
  private readonly opts: ApiClientOptions;
  private readonly token: ServiceToken;

  constructor(opts: ApiClientOptions) {
    this.opts = opts;
    this.token = readToken(opts.tokenFile);
  }

  private headers(): Record<string, string> {
    return {
      "user-agent": USER_AGENT,
      accept: "application/json",
      "CF-Access-Client-Id": this.token.client_id,
      "CF-Access-Client-Secret": this.token.client_secret,
    };
  }

  async request(method: "GET" | "POST", path: string, body?: unknown): Promise<ApiReply> {
    const timeoutMs = this.opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const unreachable = (error: unknown): Unreachable => {
      if (error instanceof Error && error.name === "TimeoutError") {
        return new Unreachable(`the request to ${this.opts.baseUrl}${path} timed out after ${timeoutMs} ms`);
      }
      const cause = error instanceof Error && error.cause instanceof Error ? `: ${error.cause.message}` : "";
      return new Unreachable(`could not reach ${this.opts.baseUrl}${cause}`);
    };
    let res: Response;
    let text: string;
    try {
      res = await fetch(new URL(path, this.opts.baseUrl), {
        method,
        // Access answers an unauthenticated request with a 302 to its login page; never follow it.
        redirect: "manual",
        headers: body === undefined ? this.headers() : { ...this.headers(), "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
      const type = res.headers.get("content-type") ?? "";
      if ((res.status >= 300 && res.status < 400) || type.includes("text/html")) {
        await res.body?.cancel();
        return { kind: "access_refused", status: res.status };
      }
      text = await res.text();
    } catch (error) {
      throw unreachable(error);
    }
    const type = res.headers.get("content-type") ?? "";
    if (type.includes("json")) {
      try {
        return { kind: "json", status: res.status, body: JSON.parse(text) as Record<string, unknown>, headers: res.headers };
      } catch {
        // fall through
      }
    }
    return { kind: "other", status: res.status, text };
  }

  /** The API's tool listing; throws with a readable reason when it can't be had. */
  async listTools(): Promise<ApiTool[]> {
    const reply = await this.request("GET", "/tools");
    if (reply.kind === "access_refused") throw new Error(`${ACCESS_REFUSED} (HTTP ${reply.status})`);
    if (reply.kind === "other") throw new Error(`GET /tools answered HTTP ${reply.status} without JSON`);
    const tools = reply.body.tools;
    if (reply.status !== 200 || !Array.isArray(tools)) {
      throw new Error(`GET /tools answered HTTP ${reply.status}: ${JSON.stringify(reply.body).slice(0, 300)}`);
    }
    return tools as ApiTool[];
  }
}
