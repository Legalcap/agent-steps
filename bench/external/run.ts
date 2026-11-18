// The external suite: the model suite's measurement (bench/model.ts) on pages somebody else wrote. Each task is an
// `act` task from Stagehand's eval suite on Stagehand's public eval sites (bench/external/tasks.ts). Per task:
//   A         "agent every time": Claude does the task with agent-browser's MCP tools, once;
//   B-record  Claude does it once through agent-steps' MCP server (steps_start ... steps_stop): was a recipe saved,
//             and if not, why steps_stop refused it;
//   B-replay  a saved recipe is replayed with no model, each time from one blank tab.
// Success is judged apart from what Claude or agent-steps says: after each run the page's address and its whole-page
// snapshot are read through agent-browser and the task's own condition is applied.
// node bench/external/run.ts [--tasks shadow_dom,ionwave] [--budget 2] [--replays 3] [--model anthropic/claude-sonnet-5.5]
//   [--out <file>] [--resume]
// Claude Code runs with a clean environment pointed at OpenRouter (OPENROUTER_API_KEY from bench/.env). The budget is
// kept against the OpenRouter key's own usage, read after every run, or the CLI's count of what the runs cost when that
// is higher (the key's count arrives a minute or two late). --resume carries on from a results file, keeping what it
// already measured and what it already spent; with nothing left to run it only reads the key's spend again.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { agentBrowserDriver, FileStore, parseRecipe, replay, StdioMcpClient, type Recipe } from "../../src/index.ts";
import { describeOutcome } from "../contenders/agent-steps.ts";
import { agentBrowserVersion, findAgentBrowser } from "../lib/agent-browser.ts";
import { benchMeta } from "../lib/meta.ts";
import { requestFor, SITES, STAGEHAND_COMMIT, TASKS, taskById, type ExternalTask, type PageRead } from "./tasks.ts";

/** USD per million tokens for claude-sonnet-5-5: the same constants as bench/model.ts, which cannot be imported
 * without running the model suite. */
const PRICES = { input: 2, output: 10, cacheWrite: 2.5, cacheRead: 0.1 };
/** This suite's own browser, so it never touches the other suites' or the person's. */
const SESSION = { AGENT_BROWSER_SESSION: "agent-steps-external", AGENT_BROWSER_NAMESPACE: "agent-steps-external" };
/** A run starts only while this much of the budget is left, and may itself spend no more than what is left. */
const RESERVE_USD = 0.15;
/** The most one run may cost (`claude --max-budget-usd`): a run that is still trying after this is stopped, and said so. */
const RUN_CAP_USD = 0.2;
const RUN_TIMEOUT_MS = 6 * 60_000;
/** How long the judge keeps reading a page that does not meet the condition yet (a page still loading). */
const JUDGE_WAIT_MS = 3_000;
/** One call to this suite's own agent-browser may take this long; a browser that hangs fails the call instead. */
const BROWSER_TIMEOUT_MS = 60_000;

const startMeta = benchMeta();
const { values } = parseArgs({
  options: {
    tasks: { type: "string" },
    model: { type: "string", default: "anthropic/claude-sonnet-5.5" },
    budget: { type: "string", default: "2" },
    replays: { type: "string", default: "3" },
    out: { type: "string" },
    resume: { type: "boolean", default: false },
    // With --resume: measure the replays again with the library as it is now, keeping the earlier ones as "B-replay-before".
    "replay-again": { type: "boolean", default: false },
  },
});
const model = values.model;
const budget = Number(values.budget);
const replays = Number(values.replays);
const tasks = values.tasks ? values.tasks.split(",").map((id) => taskById(id)).filter((task): task is ExternalTask => task !== undefined) : TASKS;
const out = values.out ?? join(import.meta.dirname, "..", "results", `external-${startMeta.date.slice(0, 10)}.json`);

const envFile = join(import.meta.dirname, "..", ".env");
if (existsSync(envFile)) process.loadEnvFile(envFile);
const openRouterKey = process.env.OPENROUTER_API_KEY;
if (!openRouterKey) throw new Error("the external suite needs OPENROUTER_API_KEY in bench/.env or the environment");
/** Nothing this suite writes or prints may hold the key. */
const redact = (text: string): string => text.replaceAll(openRouterKey, "[redacted]");
/** What the OpenRouter key has spent so far, read with a free call. */
async function openRouterUsage(): Promise<number | null> {
  try {
    const answer = (await (await fetch("https://openrouter.ai/api/v1/key", { headers: { authorization: `Bearer ${openRouterKey}` } })).json()) as { data?: { usage: number } };
    return answer.data?.usage ?? null;
  } catch {
    return null;
  }
}

const abBin = findAgentBrowser();
if (!abBin) throw new Error("agent-browser not found: set AGENT_BROWSER_BIN or put agent-browser on PATH");
const work = mkdtempSync(join(tmpdir(), "agent-steps-external-bench-"));
const repo = join(import.meta.dirname, "..", "..");
const log = (text: string) => process.stderr.write(`${redact(text)}\n`);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The environment Claude Code runs in: a clean one pointed at OpenRouter, so a desktop app's or a subscription's
 * sign-in is never used and never billed. */
const claudeEnv: NodeJS.ProcessEnv = {
  HOME: process.env.HOME, PATH: process.env.PATH, CLAUDE_CONFIG_DIR: join(work, "claude-config"),
  ANTHROPIC_BASE_URL: "https://openrouter.ai/api", ANTHROPIC_AUTH_TOKEN: openRouterKey, ANTHROPIC_API_KEY: "",
};
const browserOnly = join(work, "mcp-browser.json");
writeFileSync(browserOnly, JSON.stringify({ mcpServers: { browser: { command: abBin, args: ["mcp"], env: SESSION } } }));
/** Each task records into its own folder, so the recipe found there is the one this task's recording saved. */
const storeFolder = (task: ExternalTask) => join(work, "recipes", task.id);
function withSteps(task: ExternalTask): string {
  const file = join(work, `mcp-steps-${task.id}.json`);
  writeFileSync(file, JSON.stringify({
    mcpServers: { browser: { command: process.execPath, args: [join(repo, "src", "bin.ts"), "mcp", "--driver", "agent-browser", "--store", storeFolder(task), "--", abBin, "mcp"], env: SESSION } },
  }));
  return file;
}

interface ClaudeUsage { input_tokens?: number; output_tokens?: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number }
/** One tool call Claude made and what it was answered. */
interface ToolCall { tool: string; error: boolean; text: string }
interface ClaudeRun {
  ok: boolean;
  ms: number;
  turns: number | null;
  usage: ClaudeUsage | null;
  cliCostUsd: number | null;
  result: string;
  calls: ToolCall[];
  error?: string;
}
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const partsText = (content: unknown): string =>
  typeof content === "string" ? content : Array.isArray(content) ? content.flatMap((part) => (isRecord(part) && typeof part.text === "string" ? [part.text] : [])).join("\n") : "";

/** Claude's stream (`--output-format stream-json`): every tool call with its answer, and the closing result. */
function readStream(stdout: string): Pick<ClaudeRun, "ok" | "turns" | "usage" | "cliCostUsd" | "result" | "calls"> | null {
  const names = new Map<string, string>();
  const calls: ToolCall[] = [];
  let closing: Record<string, unknown> | null = null;
  for (const line of stdout.split("\n")) {
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(event)) continue;
    if (event.type === "result") closing = event;
    const content = isRecord(event.message) && Array.isArray(event.message.content) ? event.message.content : [];
    for (const part of content) {
      if (!isRecord(part)) continue;
      if (part.type === "tool_use" && typeof part.id === "string" && typeof part.name === "string") names.set(part.id, part.name.replace(/^mcp__browser__(?:agent_browser_)?/u, ""));
      if (part.type === "tool_result" && typeof part.tool_use_id === "string") {
        calls.push({ tool: names.get(part.tool_use_id) ?? "unknown", error: part.is_error === true, text: redact(partsText(part.content)).slice(0, 2_000) });
      }
    }
  }
  if (!closing) return null;
  // A run the CLI ended itself (the cost cap, an error) says how in `subtype`; its last words may be missing.
  const ended = typeof closing.subtype === "string" && closing.subtype !== "success" ? `[the run ended with ${closing.subtype}] ` : "";
  return {
    ok: closing.is_error !== true, turns: typeof closing.num_turns === "number" ? closing.num_turns : null, usage: isRecord(closing.usage) ? (closing.usage as ClaudeUsage) : null,
    cliCostUsd: typeof closing.total_cost_usd === "number" ? closing.total_cost_usd : null, result: redact(`${ended}${typeof closing.result === "string" ? closing.result : ""}`).slice(0, 400), calls,
  };
}

/** Why a steps_stop did not save, from its answer. Claude Code hands the model a tool's structured content when it has
 * one (`{"saved":false,"reason":"final-action"}`), and its text otherwise ("Not saved (final-action). ..."). */
function refusalOf(answer: string): string | null {
  const said = /Not saved \(([a-z-]+)\)/u.exec(answer)?.[1];
  if (said) return said;
  try {
    const parsed: unknown = JSON.parse(answer);
    if (isRecord(parsed) && parsed.saved === false) return typeof parsed.reason === "string" ? parsed.reason : "no reason given";
  } catch {
    // not JSON: some other answer
  }
  return answer.startsWith("Not saved") ? "no reason given" : null;
}

let claudeRuns = 0;
function runClaude(prompt: string, mcpConfig: string, label: string, capUsd: number): Promise<ClaudeRun> {
  claudeRuns++;
  const args = [
    "-p", prompt, "--model", model, "--output-format", "stream-json", "--verbose",
    "--strict-mcp-config", "--mcp-config", mcpConfig, "--tools", "", "--allowedTools", "mcp__browser",
    "--disable-slash-commands", "--no-session-persistence", "--max-budget-usd", capUsd.toFixed(2),
  ];
  const cwd = mkdtempSync(join(work, "cwd-"));
  const started = performance.now();
  return new Promise((resolve) => {
    const child = spawn("claude", args, { cwd, env: claudeEnv, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    const timer = setTimeout(() => child.kill("SIGTERM"), RUN_TIMEOUT_MS);
    child.on("close", () => {
      clearTimeout(timer);
      const ms = performance.now() - started;
      // The whole stream stays in the work folder, for reading a run again afterwards.
      writeFileSync(join(work, `${label}.jsonl`), redact(stdout));
      const read = readStream(stdout);
      resolve(read ? { ...read, ms } : { ok: false, ms, turns: null, usage: null, cliCostUsd: null, result: "", calls: [], error: redact(`${stderr || stdout}`).slice(0, 400) });
    });
  });
}

const tokens = (usage: ClaudeUsage | null) => usage ? (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) : null;
const estimate = (usage: ClaudeUsage | null) => usage
  ? ((usage.input_tokens ?? 0) * PRICES.input + (usage.output_tokens ?? 0) * PRICES.output + (usage.cache_creation_input_tokens ?? 0) * PRICES.cacheWrite + (usage.cache_read_input_tokens ?? 0) * PRICES.cacheRead) / 1e6
  : null;
/** As in bench/model.ts, and one sentence more: the judge reads the page the run leaves, so the browser must stay on it. */
const DONE = "Use only the browser tools. Read a snapshot before acting and act on the @refs it gives. Leave the browser open on the page you end on. When you are finished, answer DONE or FAILED and one sentence.";

interface ExternalRecord {
  task: string;
  arm: "A" | "B-record" | "B-replay" | "B-replay-before";
  rep: number;
  /** A and B-replay: whether the judge found the task done. B-record: success when a recipe was saved, refused when
   * steps_stop refused it, failed when it was never asked or never answered. */
  outcome: "success" | "failed" | "refused";
  reason: string;
  ms: number;
  tokens: number | null;
  estCostUsd: number | null;
  note: string;
  usage: ClaudeUsage | null;
  cliCostUsd: number | null;
  turns: number | null;
  /** B-record only: whether the judge found the task done on the page the recording run left. */
  taskDone?: boolean;
}
interface Recording {
  saved: boolean;
  /** Every reason a steps_stop of this run refused with, in order. */
  refusals: string[];
  /** What each steps_stop answered. */
  stops: string[];
  recipe: Recipe | null;
}
interface Results {
  suite: "external";
  meta: Record<string, unknown> & { date: string; agentStepsCommit: string; openRouterUsageAtStart?: number; openRouterSpendUsd: number; cliCostUsd: number; claudeRuns: number };
  tasks: Array<Pick<ExternalTask, "id" | "title" | "url" | "source" | "successCondition"> & { request: string }>;
  recordings: Record<string, Recording>;
  records: ExternalRecord[];
}

const prior: Results | null = values.resume && existsSync(out) ? (JSON.parse(readFileSync(out, "utf8")) as Results) : null;
const records: ExternalRecord[] = (prior?.records ?? []).map((record) => (values["replay-again"] && record.arm === "B-replay" ? { ...record, arm: "B-replay-before" as const } : record));
const recordings: Record<string, Recording> = prior?.recordings ?? {};
/** Why a task this invocation reached was left without its runs. */
const skipped = new Map<string, string>();
/** How many records this invocation added. */
let measured = 0;
let aborted: string | null = null;

const usageNow = await openRouterUsage();
if (usageNow === null) throw new Error("the OpenRouter key's usage cannot be read, so the budget cannot be kept");
/** What the key had spent before this suite's first run. A resumed file keeps it, so the spend is one difference over
 * the whole suite however late the key's count arrives. */
const usageAtStart = prior?.meta.openRouterUsageAtStart ?? usageNow - (prior?.meta.openRouterSpendUsd ?? 0);
/** The suite's spend by the key's own count, and by what the CLI said each run cost. The key is shared: anything else
 * spending on it at the same time shows in the first and not in the second. The key's count trails the runs, so the
 * budget is kept against whichever of the two is higher. */
let keySpent = usageNow - usageAtStart;
let cliSpent = 0;
let dearest = 0;
const keyTotal = () => keySpent;
const cliTotal = () => (prior?.meta.cliCostUsd ?? 0) + cliSpent;
const room = () => budget - Math.max(keyTotal(), cliTotal());
const needed = () => Math.max(RESERVE_USD, 1.5 * dearest);
const budgetLeft = () => room() >= needed();
const outOfBudget = () => `budget: $${room().toFixed(2)} of $${budget} left, and a run is not started with less than $${needed().toFixed(2)}`;

const ab = new StdioMcpClient(abBin, ["mcp"], { ...process.env, ...SESSION }, { timeoutMs: BROWSER_TIMEOUT_MS });
await ab.start();
const driver = agentBrowserDriver(ab);
const never = new AbortController().signal;
const browser = async (tool: string, args: Record<string, unknown> = {}): Promise<string> => {
  const answer = await ab.call(`agent_browser_${tool}`, args, never);
  return answer.ok ? (answer.text ?? "") : "";
};
/** Every run starts from one blank tab: the tabs a run before it opened are closed and the one left shows nothing.
 * The browser itself stays up: agent-browser 0.37.0 can hang when a close is followed at once by another command. */
async function freshBrowser(): Promise<void> {
  let tabs: Array<{ tabId?: unknown }> = [];
  try {
    tabs = (JSON.parse(await browser("tab_list")) as { data?: { tabs?: Array<{ tabId?: unknown }> } }).data?.tabs ?? [];
  } catch {
    // no list: the open below still leaves a blank page, and the check after it says whether it did
  }
  for (const tab of tabs.slice(1)) await browser("tab_close", { tab: tab.tabId });
  await browser("open", { url: "about:blank" });
  const here = (await browser("get_url")).trim();
  if (here !== "about:blank") throw new Error(`the browser could not be reset to a blank tab (it is at ${here || "nothing readable"})`);
}
const readPage = async (): Promise<PageRead> => ({ url: (await browser("get_url")).trim(), snapshot: await browser("snapshot", { interactive: false }) });
/** The judge: the task's own condition on the page as agent-browser reads it now. */
async function judge(task: ExternalTask): Promise<{ done: boolean; reason: string }> {
  const deadline = Date.now() + JUDGE_WAIT_MS;
  for (;;) {
    const page = await readPage();
    if (task.done(page)) return { done: true, reason: task.successCondition };
    if (Date.now() > deadline) return { done: false, reason: `not met (${task.successCondition}); the page is ${page.url || "unreadable"}` };
    await sleep(300);
  }
}

function write(): void {
  const result: Results = {
    suite: "external",
    meta: {
      // A resumed file keeps where it began and says where it carried on, commit included. A resume that measured
      // nothing (run only to read the key's spend again) leaves both as they were.
      ...(prior ? prior.meta : startMeta),
      ...(prior && measured ? { resumed: [...((prior.meta.resumed as unknown[] | undefined) ?? []), { date: startMeta.date, agentStepsCommit: startMeta.agentStepsCommit }] } : {}),
      ...(measured || !prior ? { agentStepsCommitAtEnd: benchMeta().agentStepsCommit } : {}),
      spendReadAt: new Date().toISOString(),
      model, via: "openrouter", openRouterUsageAtStart: usageAtStart, openRouterSpendUsd: Number(keyTotal().toFixed(4)), cliCostUsd: Number(cliTotal().toFixed(4)), budgetUsd: budget, runCapUsd: RUN_CAP_USD,
      claudeCli: cliVersion, agentBrowser: agentBrowserVersion(abBin!), replays, claudeRuns: (prior?.meta.claudeRuns ?? 0) + claudeRuns, prices: PRICES,
      source: `browserbase/stagehand evals @ ${STAGEHAND_COMMIT}`, sites: SITES, session: SESSION.AGENT_BROWSER_SESSION, aborted, notRun: notRun(),
    },
    tasks: TASKS.map((task) => ({ id: task.id, title: task.title, url: task.url, source: task.source, successCondition: task.successCondition, request: requestFor(task) })),
    recordings,
    records,
  };
  mkdirSync(join(out, ".."), { recursive: true });
  writeFileSync(out, `${redact(JSON.stringify(result, null, 1))}\n`);
}
const push = (record: ExternalRecord) => {
  records.push(record);
  measured++;
  log(`[${record.task}] ${record.arm} #${record.rep + 1}: ${record.outcome} · ${record.reason.slice(0, 90)} · ${record.ms} ms · ${record.tokens ?? "-"} tokens · $${record.estCostUsd?.toFixed(4) ?? "-"} · ${record.note.slice(0, 200)}`);
  write();
};
const has = (task: ExternalTask, arm: ExternalRecord["arm"]) => records.filter((record) => record.task === task.id && record.arm === arm).length;
/** What the results still lack, over the whole task list, and why. */
function notRun(): string[] {
  return TASKS.flatMap((task) => {
    const missing = [
      ...(has(task, "A") ? [] : ["A"]), ...(has(task, "B-record") ? [] : ["B-record"]),
      ...(recordings[task.id]?.recipe && has(task, "B-replay") < replays ? [`B-replay x${replays - has(task, "B-replay")}`] : []),
    ];
    return missing.length ? [`${task.id}: ${missing.join(", ")} (${skipped.get(task.id) ?? aborted ?? "not asked for in this run"})`] : [];
  });
}

/** One Claude run from a blank tab, counted against the budget. A run that failed without spending a token means
 * the CLI cannot work (signed out, a usage limit): stop at once. */
async function claude(task: ExternalTask, arm: "A" | "B-record", prompt: string, mcpConfig: string): Promise<ClaudeRun> {
  await freshBrowser();
  const run = await runClaude(prompt, mcpConfig, `${task.id}-${arm}`, Math.min(RUN_CAP_USD, room() - 0.03));
  if (!run.ok && !tokens(run.usage)) throw new Error(`claude CLI unavailable: ${(run.error ?? run.result).slice(0, 200)}`);
  cliSpent += run.cliCostUsd ?? estimate(run.usage) ?? 0;
  dearest = Math.max(dearest, run.cliCostUsd ?? estimate(run.usage) ?? 0);
  keySpent = ((await openRouterUsage()) ?? usageAtStart + keySpent) - usageAtStart;
  return run;
}
/** The tools a run called, in order; `!` marks a call that was answered with an error. */
const toolsOf = (run: ClaudeRun) => run.calls.map((call) => `${call.tool}${call.error ? "!" : ""}`).join(" ");
const fromClaude = (task: ExternalTask, arm: "A" | "B-record", run: ClaudeRun): Omit<ExternalRecord, "outcome" | "reason" | "note"> => ({
  task: task.id, arm, rep: 0, ms: Math.round(run.ms), tokens: tokens(run.usage), estCostUsd: estimate(run.usage), usage: run.usage, cliCostUsd: run.cliCostUsd, turns: run.turns,
});

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

try {
  for (const task of tasks) {
    // A: the agent does it, with agent-browser's tools alone.
    if (!has(task, "A")) {
      if (!budgetLeft()) {
        skipped.set(task.id, outOfBudget());
        continue;
      }
      const run = await claude(task, "A", `${requestFor(task)}\n\n${DONE}`, browserOnly);
      const verdict = await judge(task);
      push({ ...fromClaude(task, "A", run), outcome: verdict.done ? "success" : "failed", reason: verdict.reason, note: `tools: ${toolsOf(run)} · Claude: ${run.error ?? run.result}` });
    }

    // B-record: the agent once more, through agent-steps, asked to save what it does.
    if (!has(task, "B-record")) {
      if (!budgetLeft()) {
        skipped.set(task.id, outOfBudget());
        continue;
      }
      const prompt = `${requestFor(task)}\n\nRecord this as a reusable recipe: first call steps_start with name "${task.title}", then do the task, then call steps_stop with checks listing one short text that is visible on the page when the task is done. ${DONE}`;
      const run = await claude(task, "B-record", prompt, withSteps(task));
      const verdict = await judge(task);
      const stops = run.calls.filter((call) => call.tool === "steps_stop").map((call) => call.text);
      const refusals = stops.flatMap((text) => refusalOf(text) ?? []);
      const recipe = new FileStore({ folder: storeFolder(task), policy: "standard" }).list()[0] ?? null;
      recordings[task.id] = { saved: recipe !== null, refusals, stops, recipe };
      const outcome = recipe ? "success" : refusals.length ? "refused" : "failed";
      const reason = recipe ? (refusals.length ? `saved after steps_stop refused (${refusals.join(", ")})` : `saved: ${recipe.steps.length} steps, checks ${JSON.stringify(recipe.checks.map((check) => check.text))}`)
        : refusals.length ? refusals.at(-1)!
        : stops.length ? `steps_stop answered: ${stops.at(-1)!.slice(0, 200)}` : "steps_stop was never answered";
      push({ ...fromClaude(task, "B-record", run), outcome, reason, taskDone: verdict.done, note: `task ${verdict.done ? "done" : "not done"} on the page it left · tools: ${toolsOf(run)} · Claude: ${run.error ?? run.result}` });
    }

    // B-replay: the saved recipe, with no model, each time from one blank tab.
    const kept = recordings[task.id]?.recipe;
    const recipe = kept ? parseRecipe(kept, "standard") : null;
    if (kept && !recipe) log(`[${task.id}] the saved recipe no longer loads`);
    for (let rep = has(task, "B-replay"); recipe && rep < replays; rep++) {
      await freshBrowser();
      const started = performance.now();
      const outcome = await replay(recipe, { driver, policy: "standard", inputs: {} });
      const ms = performance.now() - started;
      const verdict = await judge(task);
      push({
        task: task.id, arm: "B-replay", rep, outcome: verdict.done ? "success" : "failed", reason: verdict.reason, ms: Math.round(ms), tokens: 0, estCostUsd: 0, usage: null, cliCostUsd: 0, turns: 0,
        note: `agent-steps said: ${describeOutcome(outcome) ?? "done"}`,
      });
    }
  }
} catch (caught) {
  aborted = caught instanceof Error ? caught.message : String(caught);
  log(`stopped: ${aborted}`);
} finally {
  await freshBrowser().catch(() => {});
  ab.close();
}

// The key's count can trail the last run; `--resume` with nothing left to run reads it again later.
await sleep(5_000);
keySpent = ((await openRouterUsage()) ?? usageAtStart + keySpent) - usageAtStart;
write();
log(`wrote ${out} (${claudeRuns} claude runs, $${keyTotal().toFixed(4)} by the key's usage, $${cliTotal().toFixed(4)} by the CLI's count; transcripts in ${work})`);
if (notRun().length) log(`not run:\n  ${notRun().join("\n  ")}`);
