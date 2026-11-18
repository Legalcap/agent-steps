// The no-model suite: every contender records each task once on BASE, then replays it N times on every variant.
// node bench/run.ts [--n 5] [--tasks a,b] [--variants a,b] [--contenders a,b] [--out file]
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { AgentStepsBench, describeOutcome, type AgentStepsRecording } from "./contenders/agent-steps.ts";
import { ACTION_TIMEOUT_MS, PlaywrightBench, type PlaywrightRecording } from "./contenders/playwright.ts";
import { startFixture } from "./fixture/server.ts";
import { judge, TASKS, VARIANTS, type Outcome, type Variant } from "./fixture/site.ts";
import { agentBrowserVersion, findAgentBrowser, startAgentBrowser } from "./lib/agent-browser.ts";
import { benchMeta } from "./lib/meta.ts";

export const CONTENDERS = ["agent-steps", "coordinates", "css", "role"] as const;
export type ContenderId = (typeof CONTENDERS)[number];

export interface RunRecord {
  task: string;
  variant: Variant;
  contender: ContenderId;
  rep: number;
  outcome: Outcome;
  reason: string;
  /** Wall time of the replay itself, in milliseconds. */
  ms: number;
  /** What the contender itself said: null when it finished without an error. */
  error: string | null;
}

// Read before anything runs, so the commit is the one that was measured.
const startMeta = benchMeta();
const { values } = parseArgs({
  options: {
    n: { type: "string", default: "5" },
    tasks: { type: "string" },
    variants: { type: "string" },
    contenders: { type: "string" },
    out: { type: "string" },
  },
});
const n = Number(values.n);
const tasks = values.tasks ? TASKS.filter((task) => values.tasks!.split(",").includes(task.id)) : TASKS;
const variants = values.variants ? VARIANTS.filter((variant) => values.variants!.split(",").includes(variant)) : [...VARIANTS];
const contenders = values.contenders ? CONTENDERS.filter((id) => values.contenders!.split(",").includes(id)) : [...CONTENDERS];

const fixture = await startFixture();
const playwright = new PlaywrightBench();
const chromiumVersion = await playwright.start();
const abBin = findAgentBrowser();
const ab = contenders.includes("agent-steps") ? (abBin ? await startAgentBrowser(abBin) : null) : null;
if (contenders.includes("agent-steps") && !ab) throw new Error("agent-browser not found: set AGENT_BROWSER_BIN or put agent-browser on PATH");
const steps = ab ? new AgentStepsBench(ab) : null;
const log = (text: string) => process.stderr.write(`${text}\n`);

const runs: RunRecord[] = [];
const recordings: Record<string, Record<string, { ok: boolean; reason?: string; steps?: number }>> = {};
const selfCheck: Array<{ task: string; groundTruth: Outcome; reported: string }> = [];

try {
  for (const task of tasks) {
    fixture.reset(task.id, "base");
    const pw: PlaywrightRecording = await playwright.record(task, fixture.url);
    for (const id of ["coordinates", "css", "role"] as const) (recordings[id] ??= {})[task.id] = { ok: true, steps: pw.steps.length };
    let asRecording: AgentStepsRecording | null = null;
    if (steps) {
      fixture.reset(task.id, "base");
      asRecording = await steps.record(task, fixture.url);
      (recordings["agent-steps"] ??= {})[task.id] = asRecording.ok ? { ok: true, steps: asRecording.recipe.steps.length } : { ok: false, reason: asRecording.reason };
      log(`[${task.id}] agent-steps recording: ${asRecording.ok ? `${asRecording.recipe.steps.length} steps` : asRecording.reason}`);
      if (asRecording.ok) {
        // Does the recipe's own check agree with the ground truth? Once, on BASE.
        fixture.reset(task.id, "base");
        const { outcome } = await steps.replay(asRecording.recipe, true);
        selfCheck.push({ task: task.id, groundTruth: judge(task, "base", fixture.events()).outcome, reported: describeOutcome(outcome) ?? "done" });
      }
    }

    for (const variant of variants) {
      for (const contender of contenders) {
        for (let rep = 0; rep < n; rep++) {
          fixture.reset(task.id, variant);
          let ms = 0;
          let error: string | null = null;
          if (contender === "agent-steps") {
            if (!asRecording?.ok) {
              error = `not recorded: ${asRecording?.reason ?? "no recording"}`;
            } else {
              const replayed = await steps!.replay(asRecording.recipe, false);
              ms = replayed.ms;
              error = describeOutcome(replayed.outcome);
            }
          } else {
            const replayed = await playwright.replay(contender, pw, fixture.url);
            ms = replayed.ms;
            error = replayed.error;
          }
          const verdict = judge(task, variant, fixture.events());
          runs.push({ task: task.id, variant, contender, rep, outcome: verdict.outcome, reason: verdict.reason, ms: Math.round(ms), error });
          log(`[${task.id}/${variant}] ${contender} #${rep + 1}: ${verdict.outcome} (${Math.round(ms)} ms)${error ? ` · ${error.slice(0, 120)}` : ""}${verdict.outcome === "dangerous" ? ` · ${verdict.reason}` : ""}`);
        }
      }
    }
  }
} finally {
  ab?.close();
  await playwright.stop();
  await fixture.close();
}

const result = {
  suite: "no-model",
  meta: {
    ...startMeta,
    playwright: (await import("playwright/package.json", { with: { type: "json" } })).default.version,
    chromium: chromiumVersion,
    agentBrowser: abBin ? agentBrowserVersion(abBin) : null,
    actionTimeoutMs: ACTION_TIMEOUT_MS,
    n,
  },
  recordings,
  selfCheck,
  runs,
};
const out = values.out ?? join(import.meta.dirname, "results", `no-model-${result.meta.date.slice(0, 10)}.json`);
mkdirSync(join(out, ".."), { recursive: true });
writeFileSync(out, `${JSON.stringify(result, null, 1)}\n`);
log(`wrote ${out}`);
