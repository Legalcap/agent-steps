// Renders the newest results in bench/results/ into the README's benchmark section (between the bench markers) and
// draws the three charts it shows (bench/results/*.svg). node bench/render.ts
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { groupedBars, outcomeBars, singleBars } from "./charts.ts";
import { VARIANTS, type Outcome } from "./fixture/site.ts";

const RESULTS = join(import.meta.dirname, "results");
const README = join(import.meta.dirname, "..", "README.md");
const START = "<!-- bench:start -->";
const END = "<!-- bench:end -->";

/** Every results file of a suite, oldest first. */
const every = (prefix: string) => (existsSync(RESULTS) ? readdirSync(RESULTS).filter((name) => name.startsWith(prefix) && name.endsWith(".json")).sort() : [])
  .map((file) => ({ file, data: JSON.parse(readFileSync(join(RESULTS, file), "utf8")) }));
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

const MODEL_NAME: Record<string, string> = {
  "anthropic/claude-sonnet-5.5": "Claude Sonnet 5.5", "claude-sonnet-5-5": "Claude Sonnet 5.5", "google/gemini-3-flash-preview": "Gemini 3 Flash",
};
const modelName = (id: unknown) => MODEL_NAME[String(id)] ?? String(id);
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
function cachedSection(result: { file: string; data: { meta: Record<string, unknown>; records: CachedRecord[] } } | null): string {
  if (!result) return "**Not run yet.** The adapters and the runner are in `bench/cached.ts`; they need a funded `OPENROUTER_API_KEY` (or `OPENAI_API_KEY` + `OPENAI_BASE_URL`) in `bench/.env`.\n";
  const { meta, records } = result.data;
  const lines: string[] = [];
  lines.push(`Results file: [\`bench/results/${result.file}\`](bench/results/${result.file}) · model \`${meta.model}\` via ${meta.endpoint} · Stagehand ${meta.stagehand} · Midscene ${meta.midscene} · N = ${meta.n} · spend $${meta.spendUsd}.`);
  lines.push("");
  lines.push("| Tool | Variant | Runs: success / safe / dangerous | Runs with a model call | Model cost |");
  lines.push("| --- | --- | --- | --- | --- |");
  for (const tool of new Set(records.map((record) => record.tool))) {
    for (const variant of ["first-run", ...VARIANTS]) {
      const items = records.filter((record) => record.tool === tool && record.variant === variant);
      if (!items.length) continue;
      lines.push(`| ${tool} | ${variant} | ${trio(items as never)} | ${items.filter((item) => item.llmCalls > 0).length}/${items.length} | $${items.reduce((total, item) => total + item.costUsd, 0).toFixed(3)} |`);
    }
  }
  lines.push("");
  return lines.join("\n");
}

/** Every approach side by side, counted in scenarios (one task on one version of the page). */
function scenarioTable(rows: Row[]): string {
  const lines = ["#### Every approach, in scenarios", "", "A scenario is one task on one version of the page. It counts as finished only if every repeat finished, and as wrong if any repeat did something the task didn't ask for.", ""];
  lines.push("| Approach | Same page: finished | Changed pages: finished / stopped / wrong | Target gone: stopped / wrong |");
  lines.push("| --- | --- | --- | --- |");
  for (const row of rows) {
    const base = tally(row, (variant) => variant === "base");
    const moved = tally(row, changed);
    const gone = tally(row, (variant) => variant === "removed");
    lines.push(`| ${row.label} | ${base.success}/${base.total} | ${moved.success} / ${moved.safe} / ${moved.dangerous} of ${moved.total} | ${gone.safe} / ${gone.dangerous} of ${gone.total} |`);
  }
  lines.push("");
  return lines.join("\n");
}

interface RepairRecord { task: string; variant: string; outcome: Outcome; by: "steps" | "agent"; stepsMs: number; agentMs: number; tokens: number; estCostUsd: number }
function repairSection(result: { file: string; data: { meta: Record<string, unknown>; records: RepairRecord[] } }): string {
  const { meta, records } = result.data;
  const lines: string[] = [];
  lines.push(`Results file: [\`bench/results/${result.file}\`](bench/results/${result.file}) · ${meta.date} · the saved steps run first with no model; where they stop, \`${meta.model}\` (Claude Code ${meta.claudeCli}) is told how far they got and finishes in the same browser · N = ${meta.n} per scenario · ${meta.claudeRuns} Claude runs · spend $${Number(meta.spendUsd).toFixed(2)}.`);
  lines.push("");
  lines.push("| Variant | Runs: success / safe / dangerous | Finished by the saved steps alone | Handed to the AI | AI cost per handover |");
  lines.push("| --- | --- | --- | --- | --- |");
  for (const variant of VARIANTS) {
    const items = records.filter((record) => record.variant === variant);
    if (!items.length) continue;
    const handed = items.filter((item) => item.by === "agent");
    lines.push(`| ${variant} | ${trio(items as never)} | ${items.length - handed.length}/${items.length} | ${handed.length}/${items.length} | ${handed.length ? `$${(handed.reduce((total, item) => total + item.estCostUsd, 0) / handed.length).toFixed(3)}` : "-"} |`);
  }
  lines.push("");
  return lines.join("\n");
}

interface ExternalRecord { task: string; arm: "A" | "B-record" | "B-replay"; outcome: "success" | "failed" | "refused"; reason: string; ms: number; estCostUsd: number | null }
function externalSection(result: { file: string; data: { meta: Record<string, unknown>; tasks: Array<{ id: string; title: string }>; records: ExternalRecord[] } }): string {
  const { meta, tasks, records } = result.data;
  const arm = (name: ExternalRecord["arm"]) => records.filter((record) => record.arm === name);
  const recorded = arm("B-record");
  const saved = recorded.filter((record) => record.outcome === "success");
  const refused = recorded.filter((record) => record.outcome === "refused");
  const reasons = new Map<string, number>();
  for (const record of refused) reasons.set(record.reason, (reasons.get(record.reason) ?? 0) + 1);
  const replays = arm("B-replay");
  const done = replays.filter((record) => record.outcome === "success");
  const lines: string[] = [];
  lines.push(`**On pages we did not write** (${tasks.length} tasks from ${meta.source}, ${modelName(meta.model)}): the AI did ${arm("A").filter((record) => record.outcome === "success").length} of ${arm("A").length} on its own. agent-steps saved a recipe for ${saved.length} of ${recorded.length}${refused.length ? ` and refused ${refused.length} (${[...reasons].map(([reason, n]) => `${reason}: ${n}`).join(", ")})` : ""}; ${done.length} of ${replays.length} replays of the saved ones finished the task with no AI. Results: [\`bench/results/${result.file}\`](bench/results/${result.file}).`);
  return lines.join("\n");
}

const noModel = newest("no-model-");
const model = newest("model-");
const repair = newest("repair-");
const external = newest("external-");
// A cached-replay file holds one model's runs; a tool measured with two models has a row for each (newest file wins).
const cachedFiles = every("cached-");
if (!noModel) throw new Error("no no-model results in bench/results/: run npm run bench first");

// ---------------------------------------------------------------------------------------------- scenarios, not repeats
// A replay with no model is deterministic, so five repeats of one task on one page are one scenario, not five results.
// A scenario's outcome is the worst its repeats had: wrong if any repeat did something wrong, finished only if all did.
const WORST: Outcome[] = ["dangerous", "safe", "success"];
interface Row { label: string; scenarios: Map<string, Outcome>; variantOf: Map<string, string> }
function rowOf(label: string, runs: Array<{ task: string; variant: string; outcome: Outcome }>): Row {
  const scenarios = new Map<string, Outcome>();
  const variantOf = new Map<string, string>();
  for (const run of runs) {
    const key = `${run.task}/${run.variant}`;
    const known = scenarios.get(key);
    if (known === undefined || WORST.indexOf(run.outcome) < WORST.indexOf(known)) scenarios.set(key, run.outcome);
    variantOf.set(key, run.variant);
  }
  return { label, scenarios, variantOf };
}
const tally = (row: Row, keep: (variant: string) => boolean = () => true) => {
  const outcomes = [...row.scenarios].filter(([key]) => keep(row.variantOf.get(key)!)).map(([, outcome]) => outcome);
  return { total: outcomes.length, success: outcomes.filter((o) => o === "success").length, safe: outcomes.filter((o) => o === "safe").length, dangerous: outcomes.filter((o) => o === "dangerous").length };
};
const changed = (variant: string) => PERTURBED.includes(variant);

const noModelRuns = noModel.data.runs as Run[];
const of = (contender: string) => noModelRuns.filter((run) => run.contender === contender);
const rows: Row[] = [rowOf("agent-steps, no AI", of("agent-steps"))];
if (repair) rows.push(rowOf(`agent-steps + ${modelName(repair.data.meta.model)}`, repair.data.records));
rows.push(rowOf("Playwright role locators", of("role")), rowOf("CSS selectors", of("css")), rowOf("Click positions (macro)", of("coordinates")));
const cachedRows = new Map<string, Row>();
for (const { data } of cachedFiles) {
  for (const tool of new Set((data.records as CachedRecord[]).map((record) => record.tool))) {
    const replays = (data.records as CachedRecord[]).filter((record) => record.tool === tool && record.variant !== "first-run");
    if (replays.length) cachedRows.set(`${tool}/${data.meta.model}`, rowOf(`${tool[0]!.toUpperCase()}${tool.slice(1)} + ${modelName(data.meta.model)}`, replays));
  }
}
rows.push(...cachedRows.values());
const shown = rows.filter((row) => row.scenarios.size > 0);
const scenariosEach = Math.max(...shown.map((row) => row.scenarios.size));
const changedEach = Math.max(...shown.map((row) => tally(row, changed).total));

writeFileSync(join(RESULTS, "wrong-actions.svg"), singleBars(
  "Wrong actions", `Scenarios where it did something the task didn't ask for, out of ${scenariosEach} (lower is better)`,
  shown.map((row) => ({ label: row.label, value: tally(row).dangerous })), scenariosEach, "critical",
));
writeFileSync(join(RESULTS, "changed-pages.svg"), outcomeBars(
  "When the page changed", `Moved, renamed, relabeled, covered by a banner, or with a look-alike: ${changedEach} scenarios each`,
  shown.map((row) => ({ label: row.label, ...tally(row, changed) })),
));

// ------------------------------------------------------------------------------------------- what one repeat costs
const modelRecords = (model?.data.records ?? []) as ModelRecord[];
const modelTasks = [...new Set(modelRecords.map((record) => record.task))];
const armOf = (task: string, arm: string) => modelRecords.filter((record) => record.task === task && record.arm === arm);
const mean = (values: number[]) => (values.length ? values.reduce((total, value) => total + value, 0) / values.length : 0);
const costPerRun = (task: string, arm: string) => mean(armOf(task, arm).map((record) => record.estCostUsd ?? 0));
const cents = (usd: number) => (usd === 0 ? "$0" : `${(usd * 100).toFixed(1)}¢`);
if (modelTasks.length) {
  writeFileSync(join(RESULTS, "cost.svg"), groupedBars(
    "What one repeat costs", `${modelName(model!.data.meta.model)}; every run finished the task (lower is better)`,
    ["AI does it every time", "AI runs the saved recipe (MCP)", "Your app replays it, no AI"],
    modelTasks.map((task) => ({ label: TASK_LABEL[task] ?? task, values: [costPerRun(task, "A"), costPerRun(task, "B2"), costPerRun(task, "B-replay")] })),
    cents,
  ));
}
const perRun = (arm: string) => mean(modelTasks.map((task) => costPerRun(task, arm)));
const seconds = (arm: string) => median(modelRecords.filter((record) => record.arm === arm).map((record) => record.ms)) / 1000;
const recordingCost = mean(modelTasks.map((task) => costPerRun(task, "B-record")));

const first = shown[0]!;
const guessers = shown.filter((row) => tally(row).dangerous > 0).map((row) => `${row.label}: ${tally(row).dangerous}`);
const share = (row: Row) => { const t = tally(row, changed); return pct(t.success, t.total); };
const withAi = repair ? shown[1]! : null;

const generated = [
  START,
  "<!-- Generated by `node bench/render.ts` from bench/results/. Edit the text around it, not inside. -->",
  "",
  "![Wrong actions](bench/results/wrong-actions.svg)",
  "",
  `${tally(first).dangerous === 0 ? "On its own, agent-steps never did the wrong thing" : `On its own, agent-steps did the wrong thing in ${tally(first).dangerous} scenarios`}${withAi ? `; with the AI finishing what stops, ${tally(withAi).dangerous} of ${tally(withAi).total}` : ""}. ${guessers.filter((text) => !text.startsWith("agent-steps")).length ? `The ones that guess: ${guessers.filter((text) => !text.startsWith("agent-steps")).join(", ")}.` : ""}`,
  "",
  "![When the page changed](bench/results/changed-pages.svg)",
  "",
  `Alone, agent-steps finishes ${share(first)} of changed pages and stops on the rest${withAi ? `. With the AI taking over where it stops, ${share(withAi)}` : ""}.`,
  "",
  ...(modelTasks.length ? [
    "![What one repeat costs](bench/results/cost.svg)",
    "",
    `A repeat costs nothing and takes ${seconds("B-replay").toFixed(1)} s when your app runs the recipe, against ${cents(perRun("A"))} and ${seconds("A").toFixed(0)} s for the AI doing it again. When the AI itself calls the recipe over MCP the saving is small (${cents(perRun("B2"))}, ${seconds("B2").toFixed(0)} s): most of the cost is the AI's own turn. Recording once costs ${cents(recordingCost)}.`,
    "",
  ] : []),
  ...(external ? [externalSection(external), ""] : []),
  "<details><summary>All the numbers</summary>",
  "",
  scenarioTable(shown),
  "#### No model: replays on BASE and on perturbed pages",
  "",
  noModelSection(noModel),
  ...(repair ? ["#### agent-steps with the AI finishing what stops", "", repairSection(repair)] : []),
  "#### With a model: the agent every time vs. agent-steps",
  "",
  model ? modelSection(model) : "**Not run yet.** `npm run bench:model` needs the `claude` CLI, signed in.\n",
  "#### Other \"cache, then replay\" tools: Stagehand and Midscene.js",
  "",
  cachedFiles.length ? cachedFiles.map((file) => cachedSection(file)).join("\n") : cachedSection(null),
  "</details>",
  "",
  END,
].join("\n");

const readme = readFileSync(README, "utf8");
const start = readme.indexOf(START);
const end = readme.indexOf(END);
if (start === -1 || end === -1) throw new Error(`README.md has no ${START} … ${END} markers`);
writeFileSync(README, readme.slice(0, start) + generated + readme.slice(end + END.length));
process.stderr.write(`README.md benchmark section rendered from ${[noModel.file, model?.file, repair?.file, external?.file, ...cachedFiles.map((file) => file.file)].filter(Boolean).join(", ")}\n`);
