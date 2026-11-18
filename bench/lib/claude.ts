// Runs Claude Code headless (`claude -p`) for the suites that need a model, either signed in as the caller is or with a
// clean environment pointed at OpenRouter (OPENROUTER_API_KEY from bench/.env), where the real spend is read from the
// key's own usage before and after.
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { join } from "node:path";

/** USD per million tokens for Claude Sonnet 5.5 (API list prices, November 2026). Cache writes are the 5-minute kind. */
export const PRICES = { input: 2, output: 10, cacheWrite: 2.5, cacheRead: 0.1 };

export interface ClaudeUsage { input_tokens?: number; output_tokens?: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number }
export interface ClaudeRun {
  ok: boolean;
  ms: number;
  turns: number | null;
  usage: ClaudeUsage | null;
  cliCostUsd: number | null;
  result: string;
  error?: string;
}

export const tokensOf = (usage: ClaudeUsage | null): number | null =>
  usage ? (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) : null;
export const estimateUsd = (usage: ClaudeUsage | null): number | null => usage
  ? ((usage.input_tokens ?? 0) * PRICES.input + (usage.output_tokens ?? 0) * PRICES.output + (usage.cache_creation_input_tokens ?? 0) * PRICES.cacheWrite + (usage.cache_read_input_tokens ?? 0) * PRICES.cacheRead) / 1e6
  : null;

export interface ClaudeRunner {
  model: string;
  via: "subscription" | "openrouter";
  /** One headless run with the MCP servers in `mcpConfig` as its only tools. Throws when the CLI cannot work at all. */
  run(prompt: string, mcpConfig: string): Promise<ClaudeRun>;
  runs(): number;
  /** What the suite has spent so far: OpenRouter's own bill, or the estimate from token counts. */
  spentUsd(): number;
  version(): Promise<string>;
}

export async function claudeRunner(options: { work: string; via: string; model?: string }): Promise<ClaudeRunner> {
  const viaOpenRouter = options.via === "openrouter";
  const model = options.model ?? (viaOpenRouter ? "anthropic/claude-sonnet-5.5" : "claude-sonnet-5-5");
  const envFile = join(import.meta.dirname, "..", ".env");
  if (viaOpenRouter && existsSync(envFile)) process.loadEnvFile(envFile);
  const key = process.env.OPENROUTER_API_KEY;
  if (viaOpenRouter && !key) throw new Error("--via openrouter needs OPENROUTER_API_KEY in bench/.env or the environment");
  const usage = async (): Promise<number | null> => {
    try {
      const answer = (await (await fetch("https://openrouter.ai/api/v1/key", { headers: { authorization: `Bearer ${key}` } })).json()) as { data?: { usage: number } };
      return answer.data?.usage ?? null;
    } catch {
      return null;
    }
  };
  // A clean environment, so a desktop app's or a subscription's sign-in is never used and never billed.
  const env: NodeJS.ProcessEnv = viaOpenRouter
    ? { HOME: process.env.HOME, PATH: process.env.PATH, CLAUDE_CONFIG_DIR: join(options.work, "claude-config"), ANTHROPIC_BASE_URL: "https://openrouter.ai/api", ANTHROPIC_AUTH_TOKEN: key, ANTHROPIC_API_KEY: "" }
    : process.env;
  const atStart = viaOpenRouter ? await usage() : null;
  let count = 0;
  let spent = 0;

  const once = (prompt: string, mcpConfig: string): Promise<ClaudeRun> => {
    const args = [
      "-p", prompt, "--model", model, "--output-format", "json", "--strict-mcp-config", "--mcp-config", mcpConfig, "--tools", "", "--allowedTools", "mcp__browser",
      "--disable-slash-commands", "--no-session-persistence",
    ];
    const cwd = mkdtempSync(join(options.work, "cwd-"));
    const started = performance.now();
    return new Promise((resolve) => {
      const child = spawn("claude", args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
      child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
      const timer = setTimeout(() => child.kill("SIGTERM"), 8 * 60_000);
      child.on("close", () => {
        clearTimeout(timer);
        const ms = performance.now() - started;
        try {
          const parsed = JSON.parse(stdout) as { is_error?: boolean; num_turns?: number; usage?: ClaudeUsage; total_cost_usd?: number; result?: string };
          resolve({ ok: parsed.is_error !== true, ms, turns: parsed.num_turns ?? null, usage: parsed.usage ?? null, cliCostUsd: parsed.total_cost_usd ?? null, result: (parsed.result ?? "").slice(0, 400) });
        } catch {
          resolve({ ok: false, ms, turns: null, usage: null, cliCostUsd: null, result: "", error: `${stderr || stdout}`.slice(0, 400) });
        }
      });
    });
  };

  return {
    model,
    via: viaOpenRouter ? "openrouter" : "subscription",
    async run(prompt, mcpConfig) {
      count++;
      const run = await once(prompt, mcpConfig);
      // A run that failed without spending a token means the CLI cannot work (signed out, a usage limit).
      if (!run.ok && !tokensOf(run.usage)) throw new Error(`claude CLI unavailable: ${(run.error ?? run.result).slice(0, 200)}`);
      if (viaOpenRouter && atStart !== null) spent = ((await usage()) ?? atStart + spent) - atStart;
      else spent += estimateUsd(run.usage) ?? 0;
      return run;
    },
    runs: () => count,
    spentUsd: () => spent,
    version: () => new Promise<string>((resolve) => {
      const child = spawn("claude", ["--version"]);
      let text = "";
      child.stdout.on("data", (chunk: Buffer) => { text += chunk.toString(); });
      child.on("close", () => resolve(text.trim() || "unknown"));
      child.on("error", () => resolve("unknown"));
    }),
  };
}
