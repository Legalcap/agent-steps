// The model suite, through the locally signed-in `claude` CLI (headless, `claude -p`). For a few tasks it compares:
//   A  "agent every time": Claude does the task with agent-browser's MCP tools on every repetition;
//   B  "agent-steps": Claude does it once while agent-steps records (steps_start / steps_stop through agent-steps' MCP
//      server in front of agent-browser), then the recipe is replayed with no model for the remaining repetitions;
//   B2 the same recipe, but the repeat is asked of Claude, which finds it with steps_list and runs it with steps_run.
// node bench/model.ts [--reps 10] [--b2 2] [--tasks invites,checkout,search] [--model claude-sonnet-5-5] [--max-runs 40]
//   [--via subscription|openrouter] [--budget 6]
// With --via openrouter, Claude Code runs with a clean environment pointed at OpenRouter (OPENROUTER_API_KEY from
// bench/.env), the model defaults to anthropic/claude-sonnet-5.5, and the real spend is read from the key's usage.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { agentBrowserDriver, FileStore, replay } from "../src/index.ts";
import { describeOutcome } from "./contenders/agent-steps.ts";
import { startFixture } from "./fixture/server.ts";
import { judge, taskById, type Outcome, type Task } from "./fixture/site.ts";
import { agentBrowserVersion, BENCH_SESSION, findAgentBrowser, startAgentBrowser } from "./lib/agent-browser.ts";
import { benchMeta } from "./lib/meta.ts";

/** USD per million tokens for claude-sonnet-5-5 (Anthropic API list prices, November 2026). Cache writes are the
 * 5-minute kind, at 1.25x the input price. */
export const PRICES = { input: 2, output: 10, cacheWrite: 2.5, cacheRead: 0.1 };

// Read before anything runs, so the commit is the one that was measured.
const startMeta = benchMeta();
const { values } = parseArgs({
  options: {
    reps: { type: "string", default: "10" },
    b2: { type: "string", default: "2" },
    tasks: { type: "string", default: "invites,checkout,search" },
    model: { type: "string" },
    via: { type: "string", default: "subscription" },
    budget: { type: "string", default: "6" },
    "max-runs": { type: "string", default: "40" },
    port: { type: "string", default: "4317" },
    out: { type: "string" },
  },
});
const viaOpenRouter = values.via === "openrouter";
const model = values.model ?? (viaOpenRouter ? "anthropic/claude-sonnet-5.5" : "claude-sonnet-5-5");
const budget = Number(values.budget);
const envFile = join(import.meta.dirname, ".env");
if (viaOpenRouter && existsSync(envFile)) process.loadEnvFile(envFile);
const openRouterKey = process.env.OPENROUTER_API_KEY;
if (viaOpenRouter && !openRouterKey) throw new Error("--via openrouter needs OPENROUTER_API_KEY in bench/.env or the environment");
/** What the OpenRouter key has spent so far, read with a free call. */
async function openRouterUsage(): Promise<number | null> {
  try {
    const answer = (await (await fetch("https://openrouter.ai/api/v1/key", { headers: { authorization: `Bearer ${openRouterKey}` } })).json()) as { data?: { usage: number } };
    return answer.data?.usage ?? null;
  } catch {
    return null;
  }
}
const reps = Number(values.reps);
const b2Reps = Number(values.b2);
const maxRuns = Number(values["max-runs"]);
const tasks = values.tasks.split(",").map((id) => taskById(id)).filter((task): task is Task => task !== undefined);

const abBin = findAgentBrowser();
if (!abBin) throw new Error("agent-browser not found: set AGENT_BROWSER_BIN or put agent-browser on PATH");
const fixture = await startFixture(Number(values.port));
const work = mkdtempSync(join(tmpdir(), "agent-steps-model-bench-"));
const storeFolder = join(work, "recipes");
const repo = join(import.meta.dirname, "..");
const log = (text: string) => process.stderr.write(`${text}\n`);

const env = { ...BENCH_SESSION };
/** The environment Claude Code runs in: the caller's, or a clean one pointed at OpenRouter, so a desktop app's or a
 * subscription's sign-in is never used and never billed. */
const claudeEnv: NodeJS.ProcessEnv = viaOpenRouter
  ? {
    HOME: process.env.HOME, PATH: process.env.PATH, CLAUDE_CONFIG_DIR: join(work, "claude-config"),
    ANTHROPIC_BASE_URL: "https://openrouter.ai/api", ANTHROPIC_AUTH_TOKEN: openRouterKey, ANTHROPIC_API_KEY: "",
  }
  : process.env;
const browserOnly = join(work, "mcp-browser.json");
writeFileSync(browserOnly, JSON.stringify({ mcpServers: { browser: { command: abBin, args: ["mcp"], env } } }));
const withSteps = join(work, "mcp-steps.json");
writeFileSync(withSteps, JSON.stringify({
  mcpServers: { browser: { command: process.execPath, args: [join(repo, "src", "bin.ts"), "mcp", "--driver", "agent-browser", "--store", storeFolder, "--", abBin, "mcp"], env } },
}));

interface ClaudeUsage { input_tokens?: number; output_tokens?: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number }
interface ClaudeRun {
  ok: boolean;
  ms: number;
  turns: number | null;
  usage: ClaudeUsage | null;
  cliCostUsd: number | null;
  result: string;
  error?: string;
}

let claudeRuns = 0;
function runClaude(prompt: string, mcpConfig: string): Promise<ClaudeRun> {
  claudeRuns++;
  const args = [
    "-p", prompt, "--model", model, "--output-format", "json",
    "--strict-mcp-config", "--mcp-config", mcpConfig, "--tools", "", "--allowedTools", "mcp__browser",
    "--disable-slash-commands", "--no-session-persistence",
  ];
  const cwd = mkdtempSync(join(work, "cwd-"));
  const started = performance.now();
  return new Promise((resolve) => {
    const child = spawn("claude", args, { cwd, env: claudeEnv, stdio: ["ignore", "pipe", "pipe"] });
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
}

const tokens = (usage: ClaudeUsage | null) => usage ? (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) : null;
const estimate = (usage: ClaudeUsage | null) => usage
  ? ((usage.input_tokens ?? 0) * PRICES.input + (usage.output_tokens ?? 0) * PRICES.output + (usage.cache_creation_input_tokens ?? 0) * PRICES.cacheWrite + (usage.cache_read_input_tokens ?? 0) * PRICES.cacheRead) / 1e6
  : null;

const requestFor = (task: Task) => task.request.replaceAll("{base}", fixture.url);
const DONE = "Use only the browser tools. Read a snapshot before acting and act on the @refs it gives. When you are finished, answer DONE or FAILED and one sentence.";

interface ModelRecord {
  task: string;
  arm: "A" | "B-record" | "B-replay" | "B2";
  rep: number;
  outcome: Outcome;
  reason: string;
  ms: number;
  tokens: number | null;
  usage: ClaudeUsage | null;
  estCostUsd: number | null;
  cliCostUsd: number | null;
  turns: number | null;
  note: string;
}
const records: ModelRecord[] = [];
const push = (record: ModelRecord) => {
  records.push(record);
  log(`[${record.task}] ${record.arm} #${record.rep + 1}: ${record.outcome} · ${Math.round(record.ms)} ms · ${record.tokens ?? "-"} tokens · ${record.note.slice(0, 160)}`);
};
const fromClaude = (task: Task, arm: ModelRecord["arm"], rep: number, run: ClaudeRun): ModelRecord => {
  const verdict = judge(task, "base", fixture.events());
  return {
    task: task.id, arm, rep, outcome: verdict.outcome, reason: verdict.reason, ms: Math.round(run.ms), tokens: tokens(run.usage), usage: run.usage,
    estCostUsd: estimate(run.usage), cliCostUsd: run.cliCostUsd, turns: run.turns, note: run.error ?? run.result,
  };
};
const usageAtStart = viaOpenRouter ? await openRouterUsage() : null;
let spent = 0;
const budgetLeft = () => claudeRuns < maxRuns && spent < budget;
/** A run that failed without spending a token means the CLI cannot work (signed out, a usage limit): stop at once. */
const usable = async (pending: Promise<ClaudeRun>): Promise<ClaudeRun> => {
  const run = await pending;
  if (!run.ok && !tokens(run.usage)) throw new Error(`claude CLI unavailable: ${(run.error ?? run.result).slice(0, 200)}`);
  if (viaOpenRouter && usageAtStart !== null) spent = ((await openRouterUsage()) ?? usageAtStart) - usageAtStart;
  else spent += estimate(run.usage) ?? 0;
  return run;
};
let aborted: string | null = null;

const ab = await startAgentBrowser(abBin);
const driver = agentBrowserDriver(ab);
const store = new FileStore({ folder: storeFolder, policy: "standard" });
const recordingNotes: Record<string, string> = {};

try {
  for (const task of tasks) {
    // A: the agent does it every time.
    for (let rep = 0; rep < reps && budgetLeft(); rep++) {
      fixture.reset(task.id, "base");
      push(fromClaude(task, "A", rep, await usable(runClaude(`${requestFor(task)}\n\n${DONE}`, browserOnly))));
    }

    // B: the agent once, recorded; then replays with no model.
    if (!budgetLeft()) continue;
    fixture.reset(task.id, "base");
    const recordPrompt = `${requestFor(task)}\n\nRecord this as a reusable recipe: first call steps_start with name "${task.title}", then do the task, then call steps_stop with checks listing one short text that is visible on the page when the task is done. ${DONE}`;
    const recorded = await usable(runClaude(recordPrompt, withSteps));
    push(fromClaude(task, "B-record", 0, recorded));
    const recipe = store.list().find((candidate) => candidate.name === task.title);
    recordingNotes[task.id] = recipe ? `${recipe.steps.length} steps, checks ${JSON.stringify(recipe.checks.map((check) => check.text))}` : `no recipe saved (${recorded.result.slice(0, 200)})`;
    for (let rep = 1; rep < reps; rep++) {
      fixture.reset(task.id, "base");
      if (!recipe) {
        push({ task: task.id, arm: "B-replay", rep, outcome: "safe", reason: "no recipe", ms: 0, tokens: 0, usage: null, estCostUsd: 0, cliCostUsd: 0, turns: 0, note: "nothing to replay" });
        continue;
      }
      const started = performance.now();
      const outcome = await replay(recipe, { driver, policy: "standard" });
      const ms = performance.now() - started;
      await new Promise((resolve) => setTimeout(resolve, 400));
      const verdict = judge(task, "base", fixture.events());
      push({ task: task.id, arm: "B-replay", rep, outcome: verdict.outcome, reason: verdict.reason, ms: Math.round(ms), tokens: 0, usage: null, estCostUsd: 0, cliCostUsd: 0, turns: 0, note: `agent-steps said: ${describeOutcome(outcome) ?? "done"}` });
    }

    // B2: the repeat is asked of the agent, which should use the recipe.
    for (let rep = 0; rep < b2Reps && recipe && budgetLeft(); rep++) {
      fixture.reset(task.id, "base");
      const prompt = `${requestFor(task)}\n\nA saved recipe may already do this: check steps_list and, if one fits, run it with steps_run instead of doing the steps yourself. ${DONE}`;
      push(fromClaude(task, "B2", rep, await usable(runClaude(prompt, withSteps))));
    }
  }
} catch (caught) {
  aborted = caught instanceof Error ? caught.message : String(caught);
  log(`stopped: ${aborted}`);
} finally {
  ab.close();
  await fixture.close();
}
if (!records.length) {
  log(`model suite: nothing measured (${aborted ?? "no runs"}); no results file written.`);
  process.exit(3);
}

let cliVersion = "unknown";
try {
  cliVersion = (await new Promise<string>((resolve) => {
    const child = spawn("claude", ["--version"]);
    let text = "";
    child.stdout.on("data", (chunk: Buffer) => { text += chunk.toString(); });
    child.on("close", () => resolve(text.trim()));
  }));
} catch {
  // keep unknown
}

const result = {
  suite: "model",
  meta: { ...startMeta, model, via: values.via, openRouterSpendUsd: viaOpenRouter ? Number(spent.toFixed(4)) : null, claudeCli: cliVersion, agentBrowser: agentBrowserVersion(abBin), reps, b2Reps, claudeRuns, prices: PRICES, aborted },
  recordings: recordingNotes,
  records,
};
const out = values.out ?? join(import.meta.dirname, "results", `model-${result.meta.date.slice(0, 10)}.json`);
mkdirSync(join(out, ".."), { recursive: true });
writeFileSync(out, `${JSON.stringify(result, null, 1)}\n`);
log(`wrote ${out} (${claudeRuns} claude runs)`);
