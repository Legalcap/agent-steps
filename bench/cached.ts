// The "cache, then replay" packages: Stagehand (act() with cacheDir) and Midscene.js (cache with an id). Each task is
// done once on BASE with the model, which fills the package's own cache; then that cache is replayed on every variant.
// A replay that hits the cache needs no model; one that misses falls back to the model (Stagehand's self-heal,
// Midscene's AI locate), which a local pass-through proxy counts. Every replay starts from a fresh copy of the BASE
// cache, so a fallback on one variant never helps the next.
// Needs OPENROUTER_API_KEY (or OPENAI_API_KEY with OPENAI_BASE_URL) in bench/.env or the environment.
// node bench/cached.ts [--n 5] [--tools stagehand,midscene] [--tasks ...] [--variants ...] [--model google/gemini-3-flash-preview] [--budget 9]
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { chromium, type Browser } from "playwright";
import { startFixture } from "./fixture/server.ts";
import { instructionFor, judge, TASKS, VARIANTS, type Intent, type Outcome, type Task, type Variant } from "./fixture/site.ts";
import { startLlmProxy, type LlmUsage } from "./lib/llm-proxy.ts";
import { benchMeta } from "./lib/meta.ts";

// Read before anything runs, so the commit is the one that was measured.
const startMeta = benchMeta();
const { values } = parseArgs({
  options: {
    n: { type: "string", default: "5" },
    tools: { type: "string", default: "stagehand,midscene" },
    tasks: { type: "string" },
    variants: { type: "string" },
    model: { type: "string", default: "google/gemini-3-flash-preview" },
    family: { type: "string", default: "gemini" },
    budget: { type: "string", default: "9" },
    out: { type: "string" },
  },
});

const envFile = join(import.meta.dirname, ".env");
if (existsSync(envFile)) process.loadEnvFile(envFile);
const apiKey = process.env.OPENROUTER_API_KEY ?? process.env.OPENAI_API_KEY;
const upstream = process.env.OPENAI_BASE_URL ?? "https://openrouter.ai/api/v1";
if (!apiKey) {
  process.stderr.write("cached suite: no OPENROUTER_API_KEY or OPENAI_API_KEY; nothing run.\n");
  process.exit(2);
}
const redact = (text: string) => text.split(apiKey).join("[redacted]");

const n = Number(values.n);
const tools = values.tools.split(",") as Array<"stagehand" | "midscene">;
const tasks = values.tasks ? TASKS.filter((task) => values.tasks!.split(",").includes(task.id)) : TASKS;
const variants = values.variants ? VARIANTS.filter((variant) => values.variants!.split(",").includes(variant)) : [...VARIANTS];
const log = (text: string) => process.stderr.write(`${redact(text)}\n`);

/** The model's listed price on OpenRouter, for when a response carries no cost. */
async function listedPrice(model: string): Promise<{ prompt: number; completion: number }> {
  try {
    const listed = (await (await fetch(`${upstream.replace(/\/$/u, "")}/models`)).json()) as { data: Array<{ id: string; pricing: { prompt: string; completion: string } }> };
    const found = listed.data.find((entry) => entry.id === model);
    if (found) return { prompt: Number(found.pricing.prompt) * 1e6, completion: Number(found.pricing.completion) * 1e6 };
  } catch {
    // fall through
  }
  return { prompt: 5, completion: 25 }; // deliberately high when unknown, so the budget guard errs on the safe side
}

/** OpenRouter only: what can still be spent, read with free calls, so nothing runs when there is none left. An account
 * that reports its own credits is read from them; one that reports none (a key paid some other way) from the key's limit. */
async function balanceLeft(): Promise<number | null> {
  if (!upstream.includes("openrouter.ai")) return null;
  const read = async <T>(path: string): Promise<T | undefined> =>
    ((await (await fetch(`${upstream.replace(/\/$/u, "")}${path}`, { headers: { authorization: `Bearer ${apiKey}` } })).json()) as { data?: T }).data;
  try {
    const account = await read<{ total_credits: number; total_usage: number }>("/credits");
    if (account && account.total_credits > 0) return account.total_credits - account.total_usage;
    const key = await read<{ limit_remaining: number | null }>("/key");
    return key?.limit_remaining ?? null;
  } catch {
    return null;
  }
}
const balance = await balanceLeft();
if (balance !== null && balance <= 0.05) {
  process.stderr.write(`cached suite: the OpenRouter account has no balance left ($${balance.toFixed(2)}); nothing run.\n`);
  process.exit(3);
}

const price = await listedPrice(values.model);
const proxy = await startLlmProxy({ upstream, budgetUsd: Number(values.budget), price });
const fixture = await startFixture();
const work = mkdtempSync(join(tmpdir(), "agent-steps-cached-bench-"));
const browser: Browser = await chromium.launch({ headless: true });
const VIEWPORT = { width: 1280, height: 720 };
/** Stagehand launches Chrome itself: give it the Chromium Playwright launches (the headless shell is what is installed). */
const chromePath = (): string => {
  const full = chromium.executablePath();
  if (existsSync(full)) return full;
  const shell = join(full.split("/ms-playwright/")[0]!, "ms-playwright");
  const found = readdirSync(shell).filter((name) => name.startsWith("chromium_headless_shell-")).sort().at(-1);
  if (!found) throw new Error("no Chromium for Stagehand: run npx playwright install chromium-headless-shell");
  const dir = join(shell, found);
  const sub = readdirSync(dir).find((name) => name.startsWith("chrome-headless-shell"));
  return join(dir, sub ?? "", "chrome-headless-shell");
};

type Act = Exclude<Intent, { do: "open" }>;
interface Attempt { error: string | null; ms: number }

// --------------------------------------------------------------------------------------------------------- stagehand

async function stagehandRun(task: Task, cacheDir: string): Promise<Attempt> {
  const { Stagehand } = await import("@browserbasehq/stagehand");
  const stagehand = new Stagehand({
    env: "LOCAL",
    model: { modelName: `openai/${values.model}`, apiKey, baseURL: proxy.url, openaiEndpointFormat: "chat" } as never,
    cacheDir,
    selfHeal: true,
    verbose: 0,
    disablePino: true,
    logger: () => {},
    localBrowserLaunchOptions: { executablePath: chromePath(), headless: true, viewport: VIEWPORT },
  });
  let error: string | null = null;
  let ms = 0;
  try {
    await stagehand.init();
    const page = stagehand.context.pages()[0]!;
    const started = performance.now();
    try {
      for (const intent of task.intents) {
        if (intent.do === "open") {
          await page.goto(fixture.url + intent.path);
          continue;
        }
        const { instruction, variables } = stagehandInstruction(intent);
        const result = await stagehand.act(instruction, { page, timeout: 60_000, ...(variables ? { variables } : {}) });
        if (!result.success) throw new Error(`act failed: ${result.message}`);
      }
    } catch (caught) {
      error = caught instanceof Error ? caught.message : String(caught);
    }
    ms = performance.now() - started;
    await new Promise((resolve) => setTimeout(resolve, 400));
  } catch (caught) {
    error = `setup: ${caught instanceof Error ? caught.message : String(caught)}`;
  } finally {
    await stagehand.close().catch(() => {});
  }
  return { error: error ? redact(error).split("\n")[0]!.slice(0, 300) : null, ms };
}

/** Secrets go in as Stagehand variables, so the model only sees %password%. */
function stagehandInstruction(intent: Act): { instruction: string; variables?: Record<string, string> } {
  if (intent.do === "fill" && /password/iu.test(intent.name)) return { instruction: `Type %password% into the "${intent.name}" field`, variables: { password: intent.value ?? "" } };
  return { instruction: instructionFor(intent) };
}

// ---------------------------------------------------------------------------------------------------------- midscene

async function midsceneRun(task: Task, cacheDir: string, strategy: "read-write" | "read-only"): Promise<Attempt> {
  process.env.MIDSCENE_MODEL_NAME = values.model;
  process.env.MIDSCENE_MODEL_API_KEY = apiKey;
  process.env.MIDSCENE_MODEL_BASE_URL = proxy.url;
  process.env.MIDSCENE_MODEL_FAMILY = values.family;
  process.env.MIDSCENE_RUN_DIR = join(work, "midscene_run");
  const { PlaywrightAgent } = await import("@midscene/web/playwright");
  const context = await browser.newContext({ viewport: VIEWPORT });
  const page = await context.newPage();
  const agent = new PlaywrightAgent(page, { cache: { id: task.id, strategy, cacheDir }, generateReport: false, autoPrintReportMsg: false });
  let error: string | null = null;
  const started = performance.now();
  try {
    for (const intent of task.intents) {
      if (intent.do === "open") {
        await page.goto(fixture.url + intent.path);
        continue;
      }
      const prompt = instructionFor(intent).replace(/^(Click|Type "[^"]*" into|Select "[^"]*" in|Select) /u, "");
      if (intent.do === "fill") await agent.aiInput(prompt, { value: intent.value ?? "" });
      else if (intent.do === "click" || intent.do === "check") await agent.aiTap(prompt);
      else await agent.aiAct(instructionFor(intent));
    }
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught);
  }
  const ms = performance.now() - started;
  await page.waitForTimeout(400);
  await agent.destroy().catch(() => {});
  await context.close();
  return { error: error ? redact(error).split("\n")[0]!.slice(0, 300) : null, ms };
}

// --------------------------------------------------------------------------------------------------------------- run

interface CachedRecord {
  tool: string;
  task: string;
  variant: Variant | "first-run";
  rep: number;
  outcome: Outcome;
  reason: string;
  ms: number;
  error: string | null;
  llmCalls: number;
  promptTokens: number;
  completionTokens: number;
  costUsd: number;
}
const records: CachedRecord[] = [];
const delta = (before: LlmUsage, after: LlmUsage) => ({
  llmCalls: after.calls - before.calls,
  promptTokens: after.promptTokens - before.promptTokens,
  completionTokens: after.completionTokens - before.completionTokens,
  costUsd: after.costUsd - before.costUsd,
});
const firstRuns: Record<string, Record<string, { ok: boolean; attempts: number }>> = {};

try {
  for (const tool of tools) {
    for (const task of tasks) {
      const baseCache = join(work, tool, task.id, "base");
      let ok = false;
      let attempts = 0;
      while (!ok && attempts < 2) {
        attempts++;
        rmSync(baseCache, { recursive: true, force: true });
        mkdirSync(baseCache, { recursive: true });
        fixture.reset(task.id, "base");
        const before = proxy.usage();
        const attempt = tool === "stagehand" ? await stagehandRun(task, baseCache) : await midsceneRun(task, baseCache, "read-write");
        const verdict = judge(task, "base", fixture.events());
        ok = verdict.outcome === "success";
        records.push({ tool, task: task.id, variant: "first-run", rep: attempts - 1, outcome: verdict.outcome, reason: verdict.reason, ms: Math.round(attempt.ms), error: attempt.error, ...delta(before, proxy.usage()) });
        log(`[${tool}/${task.id}] first run #${attempts}: ${verdict.outcome} · ${records.at(-1)!.llmCalls} model calls · ${attempt.error ?? ""}`);
      }
      (firstRuns[tool] ??= {})[task.id] = { ok, attempts };
      if (!ok) continue;

      for (const variant of variants) {
        for (let rep = 0; rep < n; rep++) {
          if (proxy.usage().costUsd >= Number(values.budget)) throw new Error("budget reached");
          const cache = join(work, tool, task.id, `run-${variant}-${rep}`);
          rmSync(cache, { recursive: true, force: true });
          cpSync(baseCache, cache, { recursive: true });
          fixture.reset(task.id, variant);
          const before = proxy.usage();
          const attempt = tool === "stagehand" ? await stagehandRun(task, cache) : await midsceneRun(task, cache, "read-only");
          const verdict = judge(task, variant, fixture.events());
          records.push({ tool, task: task.id, variant, rep, outcome: verdict.outcome, reason: verdict.reason, ms: Math.round(attempt.ms), error: attempt.error, ...delta(before, proxy.usage()) });
          const record = records.at(-1)!;
          log(`[${tool}/${task.id}/${variant}] #${rep + 1}: ${verdict.outcome} · ${record.llmCalls} model calls · ${Math.round(attempt.ms)} ms${attempt.error ? ` · ${attempt.error.slice(0, 120)}` : ""}${verdict.outcome === "dangerous" ? ` · ${verdict.reason}` : ""}`);
        }
      }
    }
  }
} catch (caught) {
  log(`stopped: ${caught instanceof Error ? caught.message : String(caught)}`);
} finally {
  await browser.close();
  await fixture.close();
  await proxy.close();
}

const version = async (name: string) => {
  try {
    return (await import(`${name}/package.json`, { with: { type: "json" } })).default.version as string;
  } catch {
    return "unknown";
  }
};
const result = {
  suite: "cached",
  meta: {
    ...startMeta,
    model: values.model,
    modelFamily: values.family,
    endpoint: upstream.replace(/\/\/[^/]*@/u, "//"),
    price,
    stagehand: await version("@browserbasehq/stagehand"),
    midscene: await version("@midscene/web"),
    playwright: await version("playwright"),
    n,
    spendUsd: Number(proxy.usage().costUsd.toFixed(4)),
    budgetUsd: Number(values.budget),
  },
  firstRuns,
  records,
};
const out = values.out ?? join(import.meta.dirname, "results", `cached-${result.meta.date.slice(0, 10)}.json`);
mkdirSync(join(out, ".."), { recursive: true });
writeFileSync(out, redact(`${JSON.stringify(result, null, 1)}\n`));
log(`wrote ${out} · spend $${result.meta.spendUsd}`);
