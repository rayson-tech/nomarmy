// Where this install's models run, in one place, so the MCP server, doctor,
// health and the CLI agree.
//
//   local    a llama-server on this machine (the default)
//   remote   a llama-server on another machine, e.g. a team's GPU server:
//            NOMARMY_EXECUTION=local with a non-loopback NOMARMY_LLAMA_HOST
//   hosted   no local model at all: every job runs on an api or subscription
//            agent (NOMARMY_EXECUTION=hosted)
//   bedrock  the Bedrock cloud profile (NOMARMY_EXECUTION=bedrock)
//
// Settings come from config/common.env (and a profile), which `nomarmy
// connect` forwards to the MCP server's environment.

const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1", "[::1]", "0.0.0.0"]);

/** Whether a host name or address points at this machine. */
export function isLoopbackHost(host) {
  const h = String(host ?? "").trim().toLowerCase();
  return h === "" || LOOPBACK.has(h) || /^127\./.test(h);
}

/**
 * This install's execution mode.
 * @returns {{ mode: "local"|"remote"|"hosted"|"bedrock", hasLocalModel: boolean, managesModelServer: boolean, llamaHost: string, llamaPort: string, llamaUrl: string|null }}
 *   hasLocalModel: jobs can run on the `local` agent (local or remote).
 *   managesModelServer: nomArmy starts/stops llama-server and sizes it
 *   against this machine's memory (local only).
 */
export function executionMode(env = process.env) {
  const execution = String(env.NOMARMY_EXECUTION || "local").trim().toLowerCase();
  const llamaHost = String(env.NOMARMY_LLAMA_HOST || "127.0.0.1").trim();
  const llamaPort = String(env.NOMARMY_LLAMA_PORT || "8080").trim();
  const llamaUrl = `http://${llamaHost.includes(":") && !llamaHost.startsWith("[") ? `[${llamaHost}]` : llamaHost}:${llamaPort}`;
  if (execution === "hosted") return { mode: "hosted", hasLocalModel: false, managesModelServer: false, llamaHost, llamaPort, llamaUrl: null };
  if (execution === "bedrock") return { mode: "bedrock", hasLocalModel: false, managesModelServer: false, llamaHost, llamaPort, llamaUrl: null };
  const remote = !isLoopbackHost(llamaHost);
  return { mode: remote ? "remote" : "local", hasLocalModel: true, managesModelServer: !remote, llamaHost, llamaPort, llamaUrl };
}

/**
 * Parse a model-server URL given to `nomarmy setup --llama-url` into the
 * NOMARMY_LLAMA_HOST / NOMARMY_LLAMA_PORT pair. http only (llama-server
 * speaks plain HTTP; put TLS in front of it and use its host if needed),
 * port defaulting to 8080. Throws a clear error on anything else.
 */
export function parseLlamaUrl(input) {
  let url;
  try { url = new URL(String(input ?? "").trim()); } catch { throw new Error(`"${input}" isn't a URL; use the form http://host:8080`); }
  if (url.protocol !== "http:") throw new Error(`use an http:// URL for llama-server (got ${url.protocol}//)`);
  if (url.username || url.password) throw new Error("the URL can't carry a username or password");
  if (url.pathname && url.pathname !== "/") throw new Error(`give the server's address only, without a path (got ${url.pathname})`);
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (!host) throw new Error("the URL has no host");
  return { host, port: url.port || "8080" };
}
