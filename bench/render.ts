// Renders the newest results in bench/results/ into the README's benchmark section (between the bench markers) and
// draws bench/results/no-model.svg. node bench/render.ts [--check]
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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
  lines.push(`![Outcomes on the perturbed variants](bench/results/no-model.svg)`);
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

function chart(runs: Run[]): string {
  const contenders = [...new Set(runs.map((run) => run.contender))];
  const width = 720;
  const left = 230;
  const barWidth = width - left - 30;
  const row = 34;
  const top = 40;
  const height = top + contenders.length * row + 40;
  const colors = { success: "#2f8f4e", safe: "#9aa5b1", dangerous: "#c2412d" };
  const parts: string[] = [];
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="-apple-system, system-ui, sans-serif" font-size="13">`);
  parts.push(`<rect width="100%" height="100%" fill="#ffffff"/>`);
  parts.push(`<text x="16" y="24" font-weight="600" fill="#1b1f24">Outcomes on the five perturbed variants (no model)</text>`);
  contenders.forEach((contender, index) => {
    const mine = runs.filter((run) => run.contender === contender && PERTURBED.includes(run.variant));
    const y = top + index * row;
    parts.push(`<text x="16" y="${y + 18}" fill="#1b1f24">${LABEL[contender] ?? contender}</text>`);
    let x = left;
    for (const outcome of ["success", "safe", "dangerous"] as const) {
      const share = mine.length ? count(mine, outcome) / mine.length : 0;
      const w = share * barWidth;
      if (w > 0) parts.push(`<rect x="${x.toFixed(1)}" y="${y + 4}" width="${w.toFixed(1)}" height="20" fill="${colors[outcome]}"/>`);
      if (w > 34) parts.push(`<text x="${(x + 6).toFixed(1)}" y="${y + 18}" fill="#ffffff">${Math.round(share * 100)}%</text>`);
      x += w;
    }
  });
  const legendY = top + contenders.length * row + 18;
  [["success", "success"], ["safe", "safe failure (stopped)"], ["dangerous", "dangerous (wrong action)"]].forEach(([key, text], index) => {
    const x = 16 + index * 210;
    parts.push(`<rect x="${x}" y="${legendY - 11}" width="12" height="12" fill="${colors[key as Outcome]}"/><text x="${x + 18}" y="${legendY}" fill="#1b1f24">${text}</text>`);
  });
  parts.push("</svg>");
  return `${parts.join("\n")}\n`;
}

const noModel = newest("no-model-");
const model = newest("model-");
const cached = newest("cached-");
if (!noModel) throw new Error("no no-model results in bench/results/: run npm run bench first");
writeFileSync(join(RESULTS, "no-model.svg"), chart(noModel.data.runs));

const generated = [
  START,
  "<!-- Generated by `node bench/render.ts` from bench/results/. Edit the text around it, not inside. -->",
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
  END,
].join("\n");

const readme = readFileSync(README, "utf8");
const start = readme.indexOf(START);
const end = readme.indexOf(END);
if (start === -1 || end === -1) throw new Error(`README.md has no ${START} … ${END} markers`);
writeFileSync(README, readme.slice(0, start) + generated + readme.slice(end + END.length));
process.stderr.write(`README.md benchmark section rendered from ${noModel.file}${model ? `, ${model.file}` : ""}${cached ? `, ${cached.file}` : ""}\n`);
