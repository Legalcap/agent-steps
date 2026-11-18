// Renders the newest results in bench/results/ into the README's benchmark section (between the bench markers) and
// draws the three charts it shows (bench/results/*.svg). node bench/render.ts
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { outcomeBars, pairedBars, singleBars } from "./charts.ts";
import { VARIANTS, type Outcome } from "./fixture/site.ts";

const RESULTS = join(import.meta.dirname, "results");
const README = join(import.meta.dirname, "..", "README.md");
const START = "<!-- bench:start -->";
const END = "<!-- bench:end -->";

const newest = (prefix: string) => {
  if (!existsSync(RESULTS)) return null;
  const file = readdirSync(RESULTS).filter((name) => name.startsWith(prefix) && name.endsWith(".json")).sort().at(-1);
  return file ? { file, data: JSON.parse(readFileSync(join(RESULTS, file), "utf8")) } : null;
};

interface Run { task: string; variant: string; contender: string; outcome: Outcome; ms: number; error: string | null }
const LABEL: Record<string, string> = {
  "agent-steps": "agent-steps",
  coordinates: "Coordinate macro",
  css: "CSS selectors (DevTools style)",
  role: "Playwright role locators",
};
const PERTURBED = ["moved", "renamed", "relabeled", "overlay", "duplicate"];
const median = (values: number[]) => {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
};
const count = (runs: Run[], outcome: Outcome) => runs.filter((run) => run.outcome === outcome).length;
const pct = (part: number, whole: number) => (whole ? `${Math.round((100 * part) / whole)}%` : "-");
const trio = (runs: Run[]) => `${count(runs, "success")} / ${count(runs, "safe")} / ${count(runs, "dangerous")}`;

function noModelSection(result: { file: string; data: { meta: Record<string, unknown>; runs: Run[]; recordings: Record<string, Record<string, { ok: boolean; reason?: string }>>; selfCheck: Array<{ task: string; groundTruth: string; reported: string }> } }): string {
  const { meta, runs, recordings, selfCheck } = result.data;
  const contenders = [...new Set(runs.map((run) => run.contender))];
  const tasks = [...new Set(runs.map((run) => run.task))];
  const perVariant = runs.filter((run) => run.contender === contenders[0] && run.task === tasks[0]).length / VARIANTS.length;
  const lines: string[] = [];
  lines.push(`Results file: [\`bench/results/${result.file}\`](bench/results/${result.file}) · ${meta.date} · Node ${meta.node} · Playwright ${meta.playwright} (Chromium ${meta.chromium}) · agent-browser ${meta.agentBrowser} · agent-steps ${meta.agentStepsCommit} · ${meta.machine}, ${meta.os} · N = ${meta.n} per cell · action timeout ${meta.actionTimeoutMs} ms.`);
  lines.push("");
  lines.push(`**Summary.** ${tasks.length} tasks × ${VARIANTS.length} variants × ${perVariant} runs per contender. "Perturbed" is the five variants where the task can still be done (moved, renamed, relabeled, overlay, duplicate); on "removed" the only good outcome is a safe stop.`);
  lines.push("");
  lines.push("| Contender | Success on BASE | Success on perturbed | Dangerous on perturbed | Safe stop on removed | Dangerous on removed | Median time on BASE |");
  lines.push("| --- | --- | --- | --- | --- | --- | --- |");
  for (const contender of contenders) {
    const mine = runs.filter((run) => run.contender === contender);
    const base = mine.filter((run) => run.variant === "base");
    const perturbed = mine.filter((run) => PERTURBED.includes(run.variant));
    const removed = mine.filter((run) => run.variant === "removed");
    const baseMs = base.filter((run) => run.outcome === "success").map((run) => run.ms);
    lines.push(`| ${LABEL[contender] ?? contender} | ${count(base, "success")}/${base.length} (${pct(count(base, "success"), base.length)}) | ${count(perturbed, "success")}/${perturbed.length} (${pct(count(perturbed, "success"), perturbed.length)}) | ${count(perturbed, "dangerous")}/${perturbed.length} (${pct(count(perturbed, "dangerous"), perturbed.length)}) | ${count(removed, "safe")}/${removed.length} | ${count(removed, "dangerous")}/${removed.length} | ${baseMs.length ? `${Math.round(median(baseMs))} ms` : "-"} |`);
  }
  lines.push("");
  lines.push(`**By variant** (success / safe failure / dangerous, out of ${tasks.length * perVariant} runs: ${tasks.length} tasks × ${perVariant}):`);
  lines.push("");
  lines.push(`| Contender | ${VARIANTS.join(" | ")} |`);
  lines.push(`| --- | ${VARIANTS.map(() => "---").join(" | ")} |`);
  for (const contender of contenders) {
    lines.push(`| ${LABEL[contender] ?? contender} | ${VARIANTS.map((variant) => trio(runs.filter((run) => run.contender === contender && run.variant === variant))).join(" | ")} |`);
  }
  lines.push("");
  lines.push("<details><summary>Every task × variant (S success, s safe failure, D dangerous; one letter per run)</summary>");
  lines.push("");
  lines.push(`| Task | Contender | ${VARIANTS.join(" | ")} |`);
  lines.push(`| --- | --- | ${VARIANTS.map(() => "---").join(" | ")} |`);
  const letter: Record<Outcome, string> = { success: "S", safe: "s", dangerous: "D" };
  for (const task of tasks) {
    for (const contender of contenders) {
      const cells = VARIANTS.map((variant) => runs.filter((run) => run.task === task && run.contender === contender && run.variant === variant).map((run) => letter[run.outcome]).join(""));
      lines.push(`| ${task} | ${LABEL[contender] ?? contender} | ${cells.join(" | ")} |`);
    }
  }
  lines.push("");
  lines.push("</details>");
  lines.push("");
  const refused = Object.entries(recordings["agent-steps"] ?? {}).filter(([, value]) => !value.ok);
  if (refused.length) {
    lines.push(`**Not recorded by agent-steps:** ${refused.map(([task, value]) => `\`${task}\` (${value.reason})`).join("; ")}. Those rows count as safe failures for agent-steps on every variant, BASE included: it never acted.`);
    lines.push("");
  }
  if (selfCheck.length) {
    const wrong = selfCheck.filter((entry) => (entry.groundTruth === "success") !== (entry.reported === "done"));
    lines.push(`**agent-steps' own checks:** replaying each recipe once on BASE *with* its text check, agent-steps reported the right result for ${selfCheck.length - wrong.length} of ${selfCheck.length} tasks.${wrong.length ? ` For ${wrong.map((entry) => `\`${entry.task}\``).join(", ")} the task was done but it reported "${wrong[0]!.reported.replace(/\|/gu, "\\|").slice(0, 140)}".` : ""}`);
    lines.push("");
  }
  return lines.join("\n");
}

const MODEL_NAME: Record<string, string> = { "anthropic/claude-sonnet-5.5": "Claude Sonnet 5.5", "claude-sonnet-5-5": "Claude Sonnet 5.5" };
const TASK_LABEL: Record<string, string> = { invites: "Accept one invitation", checkout: "Fill a 3-page order form", search: "Search, open a result" };
interface ModelRecord { task: string; arm: string; rep: number; outcome: Outcome; ms: number; tokens: number | null; estCostUsd: number | null; cliCostUsd: number | null; note: string }
function modelSection(result: { file: string; data: { meta: Record<string, unknown>; records: ModelRecord[]; recordings: Record<string, string> } }): string {
  const { meta, records, recordings } = result.data;
  const lines: string[] = [];
  const prices = meta.prices as Record<string, number>;
  lines.push(`Results file: [\`bench/results/${result.file}\`](bench/results/${result.file}) · ${meta.date} · model \`${meta.model}\` through Claude Code ${meta.claudeCli} (\`claude -p\`, ${meta.via === "openrouter" ? "routed through OpenRouter" : "signed in with a subscription"}) · agent-browser ${meta.agentBrowser} · ${meta.claudeRuns} Claude runs in total.`);
  lines.push("");
  lines.push(`Cost is estimated from the token counts Claude Code reports, at $${prices.input} / $${prices.output} per million input / output tokens, $${prices.cacheWrite} per million cache-write and $${prices.cacheRead} per million cache-read tokens (API list prices for this model). "CLI cost" is Claude Code's own \`total_cost_usd\`. ${meta.via === "openrouter" ? `Billed by OpenRouter for the whole suite: $${Number(meta.openRouterSpendUsd).toFixed(2)}.` : "Neither was billed: the runs used a subscription."}`);
  lines.push("");
  lines.push("| Task | Approach | Runs | Success | Dangerous | Tokens (total) | Est. cost | CLI cost | Wall time (total) |");
  lines.push("| --- | --- | --- | --- | --- | --- | --- | --- | --- |");
  const tasks = [...new Set(records.map((record) => record.task))];
  const sum = (items: ModelRecord[], key: "tokens" | "estCostUsd" | "cliCostUsd" | "ms") => items.reduce((total, item) => total + (item[key] ?? 0), 0);
  const row = (task: string, label: string, items: ModelRecord[]) => {
    if (!items.length) return;
    lines.push(`| ${task} | ${label} | ${items.length} | ${count(items as never, "success")}/${items.length} | ${count(items as never, "dangerous")} | ${sum(items, "tokens").toLocaleString("en-US")} | $${sum(items, "estCostUsd").toFixed(2)} | $${sum(items, "cliCostUsd").toFixed(2)} | ${(sum(items, "ms") / 1000).toFixed(0)} s |`);
  };
  for (const task of tasks) {
    const mine = records.filter((record) => record.task === task);
    row(task, "A: agent every time", mine.filter((record) => record.arm === "A"));
    row(task, "B: agent once (recording) + replays", mine.filter((record) => record.arm === "B-record" || record.arm === "B-replay"));
    row(task, "B2: repeat asked of the agent (steps_run)", mine.filter((record) => record.arm === "B2"));
  }
  lines.push("");
  const recorded = Object.entries(recordings).map(([task, note]) => `\`${task}\`: ${note}`).join("; ");
  if (recorded) lines.push(`Recordings made by the agent in B: ${recorded}.`);
  lines.push("");
  return lines.join("\n");
}

interface CachedRecord { tool: string; task: string; variant: string; outcome: Outcome; llmCalls: number; costUsd: number; ms: number }
function cachedSection(result: { file: string; data: { meta: Record<string, unknown>; records: CachedRecord[]; firstRuns: Record<string, Record<string, { ok: boolean; attempts: number }>> } } | null, noModelRuns: Run[]): string {
  if (!result) {
    return "**Not run yet.** The adapters and the runner are in `bench/cached.ts`; they need a funded `OPENROUTER_API_KEY` (or `OPENAI_API_KEY` + `OPENAI_BASE_URL`) in `bench/.env`. When this was written the key was present but the OpenRouter account had no balance (the runner checks the balance with a free call first and stops), so there are no numbers for Stagehand or Midscene here.";
  }
  const { meta, records } = result.data;
  const lines: string[] = [];
  lines.push(`Results file: [\`bench/results/${result.file}\`](bench/results/${result.file}) · model \`${meta.model}\` via ${meta.endpoint} · Stagehand ${meta.stagehand} · Midscene ${meta.midscene} · spend $${meta.spendUsd}.`);
  lines.push("");
  // Side by side with agent-steps' own no-model replays of the same tasks and variants.
  lines.push("Side by side, all six tasks, N = 5 (success / safe failure / dangerous):");
  lines.push("");
  lines.push("| Tool | How it replays | 5 changed variants | Target removed (stopping is right) | Replays that called a model |");
  lines.push("| --- | --- | --- | --- | --- |");
  const mine = noModelRuns.filter((run) => run.contender === "agent-steps");
  lines.push(`| agent-steps | saved steps, no model | ${trio(mine.filter((run) => PERTURBED.includes(run.variant)))} | ${trio(mine.filter((run) => run.variant === "removed"))} | 0 |`);
  for (const tool of [...new Set(records.map((record) => record.tool))]) {
    const replays = records.filter((record) => record.tool === tool && record.variant !== "first-run");
    lines.push(`| ${tool} | cache, model when the cache misses | ${trio(replays.filter((record) => PERTURBED.includes(record.variant)) as never)} | ${trio(replays.filter((record) => record.variant === "removed") as never)} | ${replays.filter((record) => record.llmCalls > 0).length}/${replays.length} |`);
  }
  lines.push("");
  lines.push("Every run, by variant:");
  lines.push("");
  lines.push("| Tool | Variant | Success / safe / dangerous | Runs with a model call | Model cost |");
  lines.push("| --- | --- | --- | --- | --- |");
  for (const tool of [...new Set(records.map((record) => record.tool))]) {
    for (const variant of ["first-run", ...VARIANTS]) {
      const items = records.filter((record) => record.tool === tool && record.variant === variant);
      if (!items.length) continue;
      lines.push(`| ${tool} | ${variant} | ${trio(items as never)} | ${items.filter((item) => item.llmCalls > 0).length}/${items.length} | $${items.reduce((total, item) => total + item.costUsd, 0).toFixed(3)} |`);
    }
  }
  lines.push("");
  return lines.join("\n");
}

const noModel = newest("no-model-");
const model = newest("model-");
const cached = newest("cached-");
if (!noModel) throw new Error("no no-model results in bench/results/: run npm run bench first");

// The three charts: the same six tools, in the same order, everywhere.
const runsOf = (tool: string): Run[] => tool === "stagehand" || tool === "midscene"
  ? ((cached?.data.records ?? []) as CachedRecord[]).filter((record) => record.tool === tool && record.variant !== "first-run").map((record) => ({ ...record, contender: tool, error: null }))
  : (noModel.data.runs as Run[]).filter((run) => run.contender === tool);
const TOOLS: Array<[string, string]> = [
  ["agent-steps", "agent-steps"], ["role", "Playwright role locators"], ["css", "CSS selectors"], ["coordinates", "Click positions (macro)"],
  ["stagehand", "Stagehand (cache + AI)"], ["midscene", "Midscene (cache + AI)"],
];
const shown = TOOLS.filter(([tool]) => runsOf(tool).length > 0);
const all = shown.map(([tool, label]) => ({ label, runs: runsOf(tool) }));
const runsEach = all[0]!.runs.length;
writeFileSync(join(RESULTS, "wrong-actions.svg"), singleBars(
  "Wrong actions", `Did something the task didn't ask for, out of ${runsEach} replays each (lower is better)`,
  all.map(({ label, runs }) => ({ label, value: count(runs, "dangerous") })), runsEach, "critical",
));
writeFileSync(join(RESULTS, "changed-pages.svg"), outcomeBars(
  "When the page changed", "Moved, renamed, relabeled, covered by a banner, or with a look-alike: 150 replays each",
  all.map(({ label, runs }) => { const changed = runs.filter((run) => PERTURBED.includes(run.variant)); return { label, success: count(changed, "success"), safe: count(changed, "safe"), dangerous: count(changed, "dangerous") }; }),
));
const modelRecords = (model?.data.records ?? []) as ModelRecord[];
const modelTasks = [...new Set(modelRecords.map((record) => record.task))];
const tokensOf = (task: string, arms: string[]) => modelRecords.filter((record) => record.task === task && arms.includes(record.arm)).reduce((total, record) => total + (record.tokens ?? 0), 0);
if (modelTasks.length) {
  writeFileSync(join(RESULTS, "tokens.svg"), pairedBars(
    "Tokens to do a task 10 times", `${MODEL_NAME[String(model!.data.meta.model)] ?? model!.data.meta.model}, and every run finished the task (lower is better)`,
    ["AI does it every time", "agent-steps: AI once, then 9 replays with no AI"],
    modelTasks.map((task) => ({ label: TASK_LABEL[task] ?? task, values: [tokensOf(task, ["A"]), tokensOf(task, ["B-record", "B-replay"])] })),
    (value) => `${(value / 1e6).toFixed(2)} M`,
  ));
}
const wrong = (label: string) => count(all.find((item) => item.label === label)?.runs ?? [], "dangerous");
const changedShare = (label: string) => { const runs = (all.find((item) => item.label === label)?.runs ?? []).filter((run) => PERTURBED.includes(run.variant)); return pct(count(runs, "success"), runs.length); };
const saved = modelTasks.length ? 1 - modelTasks.reduce((total, task) => total + tokensOf(task, ["B-record", "B-replay"]), 0) / modelTasks.reduce((total, task) => total + tokensOf(task, ["A"]), 0) : 0;
const replayMs = median(modelRecords.filter((record) => record.arm === "B-replay").map((record) => record.ms));
const agentMs = median(modelRecords.filter((record) => record.arm === "A").map((record) => record.ms));

const generated = [
  START,
  "<!-- Generated by `node bench/render.ts` from bench/results/. Edit the text around it, not inside. -->",
  "",
  "![Wrong actions](bench/results/wrong-actions.svg)",
  "",
  `agent-steps never did the wrong thing. The others guessed when the page changed: ${shown.filter(([tool]) => tool !== "agent-steps" && wrong(TOOLS.find(([id]) => id === tool)![1]) > 0).map(([, label]) => `${label.replace(/ \(.*\)$/u, "")}: ${wrong(label)}`).join(", ")}.`,
  "",
  "![When the page changed](bench/results/changed-pages.svg)",
  "",
  `The price: alone, agent-steps finishes fewer changed pages (${changedShare("agent-steps")}). It stops instead of guessing, and hands the step back to the agent to fix.`,
  "",
  ...(modelTasks.length ? [
    "![Tokens to do a task 10 times](bench/results/tokens.svg)",
    "",
    `With an AI agent, a saved recipe does the same work with ${Math.round(saved * 100)}% fewer tokens, and a replay takes ${(replayMs / 1000).toFixed(1)} s instead of ${(agentMs / 1000).toFixed(0)} s.`,
    "",
  ] : []),
  "<details><summary>All the numbers</summary>",
  "",
  "#### No model: replays on BASE and on perturbed pages",
  "",
  noModelSection(noModel),
  "#### With a model: the agent every time vs. agent-steps",
  "",
  model ? modelSection(model) : "**Not run yet.** `npm run bench:model` needs the `claude` CLI, signed in.\n",
  "#### Other \"cache, then replay\" tools: Stagehand and Midscene.js",
  "",
  cachedSection(cached, noModel.data.runs),
  "</details>",
  "",
  END,
].join("\n");

const readme = readFileSync(README, "utf8");
const start = readme.indexOf(START);
const end = readme.indexOf(END);
if (start === -1 || end === -1) throw new Error(`README.md has no ${START} … ${END} markers`);
writeFileSync(README, readme.slice(0, start) + generated + readme.slice(end + END.length));
process.stderr.write(`README.md benchmark section rendered from ${noModel.file}${model ? `, ${model.file}` : ""}${cached ? `, ${cached.file}` : ""}\n`);
