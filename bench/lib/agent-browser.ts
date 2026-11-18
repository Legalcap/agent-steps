// Finds agent-browser and starts its MCP server for the bench, in its own session and namespace so it never touches a
// browser the person is using.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { StdioMcpClient } from "../../src/mcp/client.ts";

const KNOWN_PATHS = [
  "/Applications/Openpals.app/Contents/Resources/browser-engine/agent-browser",
];

/** The agent-browser binary: AGENT_BROWSER_BIN, then PATH, then a copy bundled with a known app. */
export function findAgentBrowser(): string | null {
  const fromEnv = process.env.AGENT_BROWSER_BIN;
  if (fromEnv && existsSync(fromEnv)) return fromEnv;
  try {
    const found = execFileSync("which", ["agent-browser"], { encoding: "utf8" }).trim();
    if (found) return found;
  } catch {
    // not on PATH
  }
  return KNOWN_PATHS.find((path) => existsSync(path)) ?? null;
}

export function agentBrowserVersion(bin: string): string {
  try {
    return execFileSync(bin, ["--version"], { encoding: "utf8" }).trim().replace(/^agent-browser\s+/, "");
  } catch {
    return "unknown";
  }
}

export const BENCH_SESSION = { AGENT_BROWSER_SESSION: "agent-steps-bench", AGENT_BROWSER_NAMESPACE: "agent-steps-bench" };

/** The window every contender gets: Playwright's contenders, Stagehand and Midscene use the same size. */
export const VIEWPORT = { width: 1280, height: 720 };

/** Starts agent-browser's MCP server in the bench's session, with its window the size the other contenders use (the
 * size stays with the session, so an agent that joins it later through its own MCP server sees the same window). */
export async function startAgentBrowser(bin: string): Promise<StdioMcpClient> {
  const client = new StdioMcpClient(bin, ["mcp", "--tools", "core,mobile"], { ...process.env, ...BENCH_SESSION });
  await client.start();
  const sized = await client.call("agent_browser_set_viewport", VIEWPORT, new AbortController().signal);
  if (!sized.ok) throw new Error(`agent-browser could not set its window size: ${sized.error}`);
  return client;
}
