// agent-steps mcp [--driver agent-browser|cua] [--store <folder>] [--wait <seconds>] [--full-answers] -- <command> [args...]
// Starts the driver's own MCP server as a child and serves it with the saved-steps tools added, on stdio.
import { homedir } from "node:os";
import { join } from "node:path";
import { cuaDriver } from "./cua/driver.ts";
import { StdioMcpClient } from "./mcp/client.ts";
import { createStepsServer, serveStdio } from "./mcp/server.ts";
import { FileStore } from "./store.ts";
import { agentBrowserDriver } from "./web/driver.ts";

const USAGE = "usage: agent-steps mcp [--driver agent-browser|cua] [--store <folder>] [--wait <seconds>] -- <command> [args...]\n"
  + "  e.g. agent-steps mcp --driver agent-browser -- agent-browser mcp\n"
  + "  --wait: how long a repeat keeps looking for a step's target on a slow page (3 by default)\n"
  + "  --full-answers: pass a browser's structured answers on too (by default only their text, which is far shorter)";

export interface CliOptions { driver: "agent-browser" | "cua"; store: string; waitMs?: number; fullAnswers?: true; command: string; args: string[] }

export function parseArgs(argv: readonly string[]): CliOptions | string {
  if (argv[0] !== "mcp") return USAGE;
  const split = argv.indexOf("--");
  const own = split === -1 ? argv.slice(1) : argv.slice(1, split);
  const child = split === -1 ? [] : argv.slice(split + 1);
  let driver: CliOptions["driver"] = "agent-browser";
  let store = join(homedir(), ".agent-steps", "recipes");
  let waitMs: number | undefined;
  let fullAnswers = false;
  for (let index = 0; index < own.length; index++) {
    const flag = own[index];
    const value = own[index + 1];
    if (flag === "--full-answers") {
      fullAnswers = true;
      continue;
    }
    if (flag === "--driver" && (value === "agent-browser" || value === "cua")) driver = value;
    else if (flag === "--store" && value) store = value;
    else if (flag === "--wait" && value && Number(value) > 0 && Number(value) <= 120) waitMs = Math.round(Number(value) * 1000);
    else return USAGE;
    index++;
  }
  const [command, ...args] = child;
  if (!command) return USAGE;
  return { driver, store, ...(waitMs !== undefined ? { waitMs } : {}), ...(fullAnswers ? { fullAnswers: true as const } : {}), command, args };
}

export async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (typeof options === "string") {
    process.stderr.write(`${options}\n`);
    process.exitCode = 2;
    return;
  }
  const client = new StdioMcpClient(options.command, options.args);
  await client.start();
  const driver = options.driver === "cua" ? cuaDriver(client) : agentBrowserDriver(client);
  const server = createStepsServer({ driver, upstream: client, store: new FileStore({ folder: options.store, policy: "standard" }), ...(options.waitMs !== undefined ? { waitMs: options.waitMs } : {}), ...(options.fullAnswers ? { slim: false } : {}) });
  serveStdio(server.handle);
  process.stdin.on("end", () => client.close());
}
