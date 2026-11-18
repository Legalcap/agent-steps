// agent-steps the way an app uses it: the saved steps run first with no model, and only when they stop is the task
// handed to the agent, in the browser where they stopped. This is the arm to set beside the tools that call a model
// when their cache misses (Stagehand, Midscene). Every task, on BASE and on every changed variant.
// node bench/repair.ts [--n 1] [--tasks a,b] [--variants a,b] [--via subscription|openrouter] [--budget 2.5] [--out file]
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { AgentStepsBench, describeOutcome, type AgentStepsRecording } from "./contenders/agent-steps.ts";
import { startFixture } from "./fixture/server.ts";
import { judge, TASKS, VARIANTS, type Outcome, type Task, type Variant } from "./fixture/site.ts";
import { agentBrowserVersion, BENCH_SESSION, findAgentBrowser, startAgentBrowser } from "./lib/agent-browser.ts";
import { claudeRunner, estimateUsd, PRICES, tokensOf } from "./lib/claude.ts";
import { benchMeta } from "./lib/meta.ts";

const startMeta = benchMeta();
const { values } = parseArgs({
  options: {
    n: { type: "string", default: "1" },
    tasks: { type: "string" },
    variants: { type: "string" },
    via: { type: "string", default: "subscription" },
    model: { type: "string" },
    budget: { type: "string", default: "2.5" },
    out: { type: "string" },
  },
});
const n = Number(values.n);
const budget = Number(values.budget);
const tasks = values.tasks ? TASKS.filter((task) => values.tasks!.split(",").includes(task.id)) : TASKS;
const variants = values.variants ? VARIANTS.filter((variant) => values.variants!.split(",").includes(variant)) : [...VARIANTS];

const abBin = findAgentBrowser();
if (!abBin) throw new Error("agent-browser not found: set AGENT_BROWSER_BIN or put agent-browser on PATH");
const work = mkdtempSync(join(tmpdir(), "agent-steps-repair-bench-"));
const fixture = await startFixture();
const ab = await startAgentBrowser(abBin);
const steps = new AgentStepsBench(ab);
const claude = await claudeRunner({ work, via: values.via, ...(values.model ? { model: values.model } : {}) });
const log = (text: string) => process.stderr.write(`${text}\n`);

// The agent gets agent-browser's own tools, in the session the saved steps just used, so it sees the page they left.
const browserOnly = join(work, "mcp-browser.json");
writeFileSync(browserOnly, JSON.stringify({ mcpServers: { browser: { command: abBin, args: ["mcp"], env: { ...BENCH_SESSION } } } }));

const DONE = "Use only the browser tools. Read a snapshot before acting and act on the @refs it gives. When you are finished, answer DONE or FAILED and one sentence.";
const requestFor = (task: Task) => task.request.replaceAll("{base}", fixture.url);
/** What an app tells the agent when saved steps stopped: how far they got and why, nothing about what to do instead. */
const handover = (task: Task, stopped: string) =>
  `${requestFor(task)}\n\nSaved steps for this were tried first, with no AI, and ${stopped}. The browser is where they stopped. Do what is left of the task yourself.\n\n${DONE}`;

interface RepairRecord {
  task: string;
  variant: Variant;
  rep: number;
  outcome: Outcome;
  reason: string;
  /** Whether the saved steps finished on their own, or the agent was called. */
  by: "steps" | "agent";
  stepsMs: number;
  agentMs: number;
  tokens: number;
  estCostUsd: number;
  note: string;
}
const records: RepairRecord[] = [];
const recordings: Record<string, { ok: boolean; reason?: string; steps?: number }> = {};
let aborted: string | null = null;

try {
  const recipes = new Map<string, AgentStepsRecording>();
  for (const task of tasks) {
    fixture.reset(task.id, "base");
    const recording = await steps.record(task, fixture.url);
    recipes.set(task.id, recording);
    recordings[task.id] = recording.ok ? { ok: true, steps: recording.recipe.steps.length } : { ok: false, reason: recording.reason };
    log(`[${task.id}] recording: ${recording.ok ? `${recording.recipe.steps.length} steps` : recording.reason}`);
  }
  // Repetitions on the outside: if the budget runs out, every scenario has had the same number of runs.
  for (let rep = 0; rep < n; rep++) {
    for (const task of tasks) {
      for (const variant of variants) {
        if (claude.spentUsd() >= budget) throw new Error(`budget reached ($${claude.spentUsd().toFixed(2)})`);
        fixture.reset(task.id, variant);
        const recording = recipes.get(task.id)!;
        let stopped: string | null = recording.ok ? null : `there were none to run (${recording.reason})`;
        let stepsMs = 0;
        if (recording.ok) {
          const replayed = await steps.replay(recording.recipe, false);
          stepsMs = replayed.ms;
          stopped = describeOutcome(replayed.outcome);
        }
        let agentMs = 0;
        let tokens = 0;
        let cost = 0;
        let note = "saved steps finished";
        if (stopped !== null) {
          const run = await claude.run(handover(task, stopped), browserOnly);
          agentMs = run.ms;
          tokens = tokensOf(run.usage) ?? 0;
          cost = estimateUsd(run.usage) ?? 0;
          note = `${stopped} → agent: ${run.error ?? run.result}`;
          await new Promise((resolve) => setTimeout(resolve, 400));
        }
        const verdict = judge(task, variant, fixture.events());
        records.push({ task: task.id, variant, rep, outcome: verdict.outcome, reason: verdict.reason, by: stopped === null ? "steps" : "agent", stepsMs: Math.round(stepsMs), agentMs: Math.round(agentMs), tokens, estCostUsd: cost, note });
        log(`[${task.id}/${variant}] #${rep + 1}: ${verdict.outcome} · ${stopped === null ? "steps" : "agent"} · ${Math.round(stepsMs + agentMs)} ms · ${tokens} tokens${verdict.outcome === "dangerous" ? ` · ${verdict.reason}` : ""} · ${note.slice(0, 200)}`);
      }
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
  log(`repair suite: nothing measured (${aborted ?? "no runs"}); no results file written.`);
  process.exit(3);
}

const result = {
  suite: "repair",
  meta: {
    ...startMeta, model: claude.model, via: claude.via, claudeCli: await claude.version(), agentBrowser: agentBrowserVersion(abBin), n, claudeRuns: claude.runs(),
    spendUsd: Number(claude.spentUsd().toFixed(4)), prices: PRICES, aborted,
  },
  recordings,
  records,
};
const out = values.out ?? join(import.meta.dirname, "results", `repair-${result.meta.date.slice(0, 10)}.json`);
mkdirSync(join(out, ".."), { recursive: true });
writeFileSync(out, `${JSON.stringify(result, null, 1)}\n`);
log(`wrote ${out} (${claude.runs()} claude runs, $${claude.spentUsd().toFixed(2)})`);
