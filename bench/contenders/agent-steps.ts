// agent-steps through the real agent-browser MCP server. Recording plays the part of an agent: before each action it
// reads a snapshot, picks the ref of the element the intent names, and acts on `@ref` through agent-steps' recorder, so
// the recipe is learned from exactly the calls an agent would have made. Replay is agent-steps' own `replay`.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentBrowserDriver, createRecorder, FileStore, readSnapshot, replay, type Caller, type Recipe, type ReplayOutcome } from "../../src/index.ts";
import type { Intent, Task } from "../fixture/site.ts";

const TOOL: Record<Exclude<Intent, { do: "open" }>["do"], string> = { click: "click", fill: "fill", select: "select", check: "check" };

export type AgentStepsRecording = { ok: true; recipe: Recipe } | { ok: false; reason: string };

export class AgentStepsBench {
  private readonly store = new FileStore({ folder: mkdtempSync(join(tmpdir(), "agent-steps-bench-")), policy: "standard" });
  private readonly caller: Caller;
  constructor(caller: Caller) {
    this.caller = caller;
  }

  async record(task: Task, baseUrl: string): Promise<AgentStepsRecording> {
    const driver = agentBrowserDriver(this.caller);
    const recorder = createRecorder({ driver, policy: "standard" });
    const signal = new AbortController().signal;
    for (const intent of task.intents) {
      if (intent.do === "open") {
        const opened = await recorder.call("agent_browser_open", { url: baseUrl + intent.path }, signal);
        if (!opened.ok) return { ok: false, reason: `open failed: ${opened.error}` };
        continue;
      }
      const ref = await this.findRef(recorder, intent, signal);
      if (!ref) return { ok: false, reason: `the recording agent found no ${intent.role} "${intent.name}"` };
      const args: Record<string, unknown> = { selector: `@${ref}` };
      if (intent.do === "fill") args.text = intent.value;
      if (intent.do === "select") args.values = [intent.value];
      const done = await recorder.call(`agent_browser_${TOOL[intent.do]}`, args, signal);
      if (!done.ok) return { ok: false, reason: `${intent.do} failed: ${done.error}` };
    }
    const saved = recorder.stop({ name: task.title, checks: task.checks });
    if (!saved.ok) return { ok: false, reason: `agent-steps refused to save the recipe: ${saved.reason}` };
    this.store.save(saved.recipe);
    const loaded = this.store.find(saved.recipe.key);
    if (!loaded) return { ok: false, reason: "the saved recipe did not load back" };
    return { ok: true, recipe: loaded };
  }

  /** What an agent does before acting: read the page, find the element. It waits up to 3 s for a page to load. */
  private async findRef(recorder: ReturnType<typeof createRecorder>, intent: Exclude<Intent, { do: "open" }>, signal: AbortSignal): Promise<string | undefined> {
    const deadline = Date.now() + 3_000;
    for (;;) {
      const seen = await recorder.call("agent_browser_snapshot", {}, signal);
      if (seen.ok) {
        const nodes = readSnapshot(seen.text ?? "").filter((node) => node.role === intent.role && node.name === intent.name);
        const pick = nodes.length > 1 && intent.near ? nodes.filter((node) => node.near === intent.near) : nodes;
        if (pick.length === 1) return pick[0]!.ref;
      }
      if (Date.now() > deadline) return undefined;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }

  /** Replays with no model and no repair. `withChecks: false` drops the recipe's text checks, so only actions are timed. */
  async replay(recipe: Recipe, withChecks: boolean): Promise<{ ms: number; outcome: ReplayOutcome }> {
    const driver = agentBrowserDriver(this.caller);
    const started = performance.now();
    const outcome = await replay(withChecks ? recipe : { ...recipe, checks: [] }, { driver, policy: "standard" });
    const ms = performance.now() - started;
    await new Promise((resolve) => setTimeout(resolve, 400)); // let any request the last action started reach the server (not timed)
    return { ms, outcome };
  }
}

export function describeOutcome(outcome: ReplayOutcome): string | null {
  if (outcome.kind === "done") return null;
  if (outcome.kind === "failed") return `stopped at step ${outcome.index + 1}/${outcome.total} (${outcome.tool} ${outcome.label}): ${outcome.error}`;
  return outcome.kind;
}
