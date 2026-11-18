// An MCP server that sits in front of a driver's own MCP server (agent-browser, cua-driver): it passes every tool through
// and adds steps_start, steps_stop, steps_list, steps_run and steps_repair. While a recording is on, every passed-through
// call is kept; steps_run repeats a recipe with no model in the loop. Tool calls are answered one at a time, in the order
// they came, so a recording holds them in the order the agent made them; a cancelled request stops what it was doing.
// A browser's answers are passed on as their text alone: agent-browser repeats each answer several times over in its
// structured part, which makes a large page too long for the agent to read.
import { requestKey } from "../key.ts";
import { reviseRecipe, parseRecipe, stepLabel } from "../recipe.ts";
import { createRecorder, recordedResult, type Recorder } from "../recorder.ts";
import { replay, seesSoon } from "../replay.ts";
import type { FileStore } from "../store.ts";
import type { Driver, Patience, Recipe, Refusal } from "../types.ts";
import { MCP_PROTOCOL, VERSION } from "../version.ts";
import { callOutcome, type McpTool } from "./client.ts";

export interface Upstream {
  tools(): Promise<McpTool[]>;
  callRaw(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown>;
}

type RpcId = string | number | null;
type ToolResult = { content: Array<{ type: "text"; text: string }>; structuredContent?: Record<string, unknown>; isError?: boolean };

const inputsSchema = { type: "object", additionalProperties: { type: "string" }, description: "Values for the recipe's {placeholders}, by name." };
export const STEPS_TOOLS: McpTool[] = [
  {
    name: "steps_start",
    description: "Start recording. Do the task with the other tools; every call is kept until steps_stop. Name it by what it does. Give inputs for values that change between runs (a recipient, a date); they become {placeholders}.",
    inputSchema: { type: "object", required: ["name"], additionalProperties: false, properties: { name: { type: "string", minLength: 1 }, inputs: inputsSchema } },
  },
  {
    name: "steps_stop",
    description: "Stop recording and save the recipe. checks: text that must be visible when the steps are done. discard: drop the recording.",
    inputSchema: { type: "object", additionalProperties: false, properties: { checks: { type: "array", items: { type: "string", minLength: 1 } }, discard: { type: "boolean" } } },
  },
  { name: "steps_list", description: "List saved recipes: name, steps, inputs and revision.", inputSchema: { type: "object", additionalProperties: false, properties: {} } },
  {
    name: "steps_run",
    description: "Repeat a saved recipe without a model: each step is found again on screen by its role and name. If a step fails, the result says which; do that part yourself, or call steps_repair to record the rest again.",
    inputSchema: { type: "object", required: ["name"], additionalProperties: false, properties: { name: { type: "string", minLength: 1 }, inputs: inputsSchema } },
  },
  {
    name: "steps_repair",
    description: "Record a recipe again from step `at` (1-based): the steps before it stay, then do the rest with the other tools and call steps_stop. The recipe keeps its name and its revision goes up by one.",
    inputSchema: { type: "object", required: ["name", "at"], additionalProperties: false, properties: { name: { type: "string", minLength: 1 }, at: { type: "integer", minimum: 1 }, inputs: inputsSchema } },
  },
];
const STEPS_NAMES = new Set(STEPS_TOOLS.map((tool) => tool.name));

/** What the agent can do about a recording that was not saved. */
export const REFUSAL_HELP: Record<Refusal, string> = {
  "final-action": "A step pressed something that cannot be undone (send, delete, pay, submit and their like), or Return where that would. Those are never repeated without you: stop the recording before that step and do it yourself each time.",
  "secret-field": "A step typed into a password-like field, or typed something that looks like a key. Sign in yourself before recording, and pass values like that as inputs so they are never stored.",
  "toggle-element": "A step clicked a checkbox or switch, which flips it from whatever state it is in. Use check or uncheck so it sets a state.",
  "ambiguous-element": "A step acted on an element that shares its role and name with another one and has no heading of its own above it.",
  "unlabelled-element": "A step acted on an element with no name (an icon with no label).",
  "unknown-target": "A step acted on something that was not in the snapshot read before it. Read a snapshot, then act on a ref from it (not a CSS selector).",
  "stale-element": "A step acted on an element from an older read of the window. Read the window again before acting.",
  "unknown-tool": "The recording used a tool that cannot be repeated (running JavaScript, tabs, find with an action). Do that part outside the recording.",
  "typing-appends": "A step typed at the cursor, which adds to what the field holds. Use fill (or set_value) so the field ends up with exactly the text.",
  "extra-arguments": "A step used an argument that cannot be repeated safely.",
  "pixel-or-drag": "A step used a point on the screen or a drag. Act on elements instead.",
  "no-steps": "Nothing was done between steps_start and steps_stop.",
  "too-many-steps": "The recording is too long. Record a shorter part of the task.",
  "partial-tree": "A window was only partly read before a step. Read it whole first.",
  "key-without-window": "A key press did not say which window it goes to.",
  "unreadable-field": "A step replaced a field's text without reading what it held first.",
  "missing-input": "A {placeholder} has no input named for it.",
  "moment-words": "The name points at a moment (this, latest, today), so it would not mean the same next time.",
  "typed-text-not-in-request": "A step typed words that the name does not hold.",
  "url-not-in-request": "A step opened a link that the name does not hold.",
  "incomplete-journal": "Part of the recording is missing.",
  "denied": "A step was refused while recording.",
  "tool-error": "A call failed while recording.",
};

// Some clients show the agent only the structured part of an answer, so the words go there too.
const say = (text: string, structured?: Record<string, unknown>, isError = false): ToolResult => ({
  content: [{ type: "text", text }], structuredContent: { ...structured, message: text }, ...(isError ? { isError: true } : {}),
});

/** What to keep to while recording, said when a recording starts: each of these is a refusal at steps_stop otherwise. */
const RULES: Record<Driver["kind"], string> = {
  "agent-browser": "While recording: read a snapshot and act on the @refs it gives, not on CSS selectors; use fill (not type) and check or uncheck (not click) on boxes; do not run JavaScript, switch tabs, or press a final button (send, delete, pay, submit). Do those parts before steps_start or after steps_stop.",
  cua: "While recording: read the window, then act on elements from that read, not on points of the screen; use set_value (not type_text); do not press a final button (send, delete, pay, submit).",
};
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const stringMap = (value: unknown): Record<string, string> | undefined =>
  isRecord(value) && Object.values(value).every((item) => typeof item === "string") ? (value as Record<string, string>) : undefined;
const summary = (recipe: Recipe) => ({ name: recipe.name, id: recipe.id, revision: recipe.revision, steps: recipe.steps.length, inputs: recipe.inputs, checks: recipe.checks.map((check) => check.text) });
/** Every step in words, so whoever saved the recipe sees what a repeat will do without asking. */
const stepList = (recipe: Recipe) => recipe.steps.map((step, index) => `${index + 1}. ${step.tool} ${stepLabel(step)}`).join("; ");
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

export function createStepsServer(deps: { driver: Driver; upstream: Upstream; store: FileStore; now?: () => number; id?: () => string; patience?: Patience; waitMs?: number; slim?: boolean }) {
  const now = deps.now ?? Date.now;
  let recording: { recorder: Recorder; name: string; inputs?: Record<string, string>; repair?: { recipe: Recipe; at: number }; unsavable?: Refusal } | null = null;
  const slim = deps.slim ?? deps.driver.kind === "agent-browser";
  const begin = (name: string, inputs?: Record<string, string>, repair?: { recipe: Recipe; at: number }) => {
    recording = { recorder: createRecorder({ driver: deps.driver, policy: "standard", now, ...(deps.id ? { id: deps.id } : {}) }), name, ...(inputs ? { inputs } : {}), ...(repair ? { repair } : {}) };
  };

  async function stepsCall(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<ToolResult> {
    if (name === "steps_list") {
      const recipes = deps.store.list().map(summary);
      return say(recipes.length ? recipes.map((recipe) => `${recipe.name} (${recipe.steps} steps, revision ${recipe.revision})`).join("\n") : "No saved recipes.", { recipes });
    }
    if (name === "steps_start") {
      if (typeof args.name !== "string" || !args.name.trim()) return say("Give the recipe a name.", undefined, true);
      if (recording) return say(`Already recording "${recording.name}". Call steps_stop first.`, undefined, true);
      begin(args.name.trim(), stringMap(args.inputs));
      return say(`Recording "${args.name.trim()}". Do the task, then call steps_stop. ${RULES[deps.driver.kind]}`);
    }
    if (name === "steps_stop") {
      const current = recording;
      if (!current) return say("Nothing is being recorded.", undefined, true);
      recording = null;
      if (args.discard === true) return say("Recording dropped.");
      const checks = Array.isArray(args.checks) ? args.checks.filter((check): check is string => typeof check === "string" && check.trim() !== "") : [];
      const built = current.recorder.stop({ name: current.repair?.recipe.name ?? current.name, ...(current.inputs ? { inputs: current.inputs } : {}), checks });
      if (!built.ok) return say(`Not saved (${built.reason}). ${REFUSAL_HELP[built.reason]}`, { saved: false, reason: built.reason }, true);
      let recipe = built.recipe;
      // A check is only worth keeping if it is true now, on the screen the recording ended on.
      const unmet: string[] = [];
      for (const check of recipe.checks) {
        if (await seesSoon(deps.driver, check, signal ?? new AbortController().signal, deps.patience, deps.waitMs)) unmet.push(check.text);
      }
      if (unmet.length) recipe = { ...recipe, checks: recipe.checks.filter((check) => !unmet.includes(check.text)) };
      const failedCalls = current.recorder.calls().filter((call) => call.result.isError).length;
      const notes = [
        ...(unmet.length ? [`Not kept as a check, because the page does not say it now: ${unmet.map((text) => `"${text}"`).join(", ")}.`] : []),
        ...(failedCalls ? [`${failedCalls} call${failedCalls === 1 ? "" : "s"} that failed while recording ${failedCalls === 1 ? "was" : "were"} left out.`] : []),
      ];
      if (current.repair) {
        const { recipe: old, at } = current.repair;
        const steps = [...old.steps.slice(0, at - 1), ...recipe.steps];
        recipe = reviseRecipe({ ...old, inputs: [...new Set([...old.inputs, ...recipe.inputs])] }, { steps, checks: checks.length ? recipe.checks : old.checks }, now());
        if (!parseRecipe(recipe, "standard")) return say("Not saved: the repaired recipe is not valid.", { saved: false }, true);
      }
      try {
        deps.store.save(recipe);
      } catch (error) {
        return say(`Not saved: ${errorText(error)}.`, { saved: false }, true);
      }
      return say([`Saved "${recipe.name}", revision ${recipe.revision}. steps_run repeats these steps without asking: ${stepList(recipe)}.`, ...notes].join(" "), { saved: true, recipe: summary(recipe) });
    }
    const recipe = typeof args.name === "string" ? deps.store.find(requestKey(args.name)) : undefined;
    if (!recipe) return say(`No saved recipe named "${String(args.name ?? "")}". steps_list shows them.`, undefined, true);
    if (name === "steps_repair") {
      const at = typeof args.at === "number" && Number.isInteger(args.at) ? args.at : 0;
      if (at < 1 || at > recipe.steps.length + 1) return say(`at must be a step number from 1 to ${recipe.steps.length + 1}.`, undefined, true);
      if (recording) return say(`Already recording "${recording.name}". Call steps_stop first.`, undefined, true);
      begin(recipe.name, stringMap(args.inputs), { recipe, at });
      return say(`Recording "${recipe.name}" again from step ${at}. Do the rest of the task, then call steps_stop. ${RULES[deps.driver.kind]}`);
    }
    const outcome = await replay(recipe, { driver: deps.driver, inputs: stringMap(args.inputs) ?? {}, policy: "standard", ...(signal ? { signal } : {}), ...(deps.patience ? { patience: deps.patience } : {}), ...(deps.waitMs !== undefined ? { waitMs: deps.waitMs } : {}), now });
    if (outcome.kind === "done") {
      deps.store.touch(recipe.id);
      return say(`Done: ran ${recipe.steps.length} steps of "${recipe.name}".`, { outcome: "done", steps: recipe.steps.length });
    }
    if (outcome.kind === "failed") {
      const where = outcome.check ? `the check ${outcome.label}` : `step ${outcome.index + 1} of ${outcome.total} (${outcome.tool} ${outcome.label})`;
      return say(`Stopped at ${where}: ${outcome.error}. Steps 1-${outcome.done} are done. Finish the task yourself, or call steps_repair with at=${outcome.index + 1} to record the rest.`,
        { outcome: "failed", at: outcome.index + 1, done: outcome.done, total: outcome.total, step: outcome.check ? null : stepLabel(recipe.steps[outcome.index]!), error: outcome.error }, true);
    }
    return say(`Stopped (${outcome.kind}).`, { outcome: outcome.kind }, true);
  }

  /** The tool calls being answered or waiting their turn, by request id, so a cancellation can stop one. */
  const calls = new Map<RpcId, AbortController>();
  let turn: Promise<unknown> = Promise.resolve();

  async function toolCall(name: string, args: Record<string, unknown>, signal: AbortSignal): Promise<unknown> {
    if (signal.aborted) throw new Error("stopped");
    if (STEPS_NAMES.has(name)) return stepsCall(name, args, signal);
    const raw = await deps.upstream.callRaw(name, args, signal);
    const result = slim && isRecord(raw) && Array.isArray(raw.content) && raw.content.some((part) => isRecord(part) && part.type === "text")
      ? Object.fromEntries(Object.entries(raw).filter(([key]) => key !== "structuredContent"))
      : raw;
    if (!recording) return result;
    recording.recorder.record({ tool: name, arguments: args, result: recordedResult(callOutcome(raw), deps.driver.kind) });
    if (recording.unsavable || !isRecord(result) || !Array.isArray(result.content)) return result;
    // Say so at the call that makes the recording unsavable, not at steps_stop when the whole task has been done.
    const learned = deps.driver.learn(recording.recorder.calls(), { request: recording.name, policy: "standard" });
    if (learned.ok) return result;
    recording.unsavable = learned.reason;
    const warning = `agent-steps: after this call the recording cannot be saved (${learned.reason}). ${REFUSAL_HELP[learned.reason]} To record it, call steps_stop with discard, then steps_start, and do the task again without this.`;
    return {
      ...result, content: [...result.content, { type: "text", text: warning }],
      ...(isRecord(result.structuredContent) ? { structuredContent: { ...result.structuredContent, agentSteps: warning } } : {}),
    };
  }

  async function handle(frame: unknown): Promise<unknown> {
    if (!isRecord(frame) || typeof frame.method !== "string") return { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid request." } };
    if (!Object.hasOwn(frame, "id")) {
      if (frame.method === "notifications/cancelled" && isRecord(frame.params)) calls.get(frame.params.requestId as RpcId)?.abort();
      return undefined;
    }
    const id = (frame.id ?? null) as RpcId;
    const answer = (result: unknown) => ({ jsonrpc: "2.0", id, result });
    const fail = (message: string, code = -32603) => ({ jsonrpc: "2.0", id, error: { code, message } });
    try {
      if (frame.method === "initialize") return answer({ protocolVersion: MCP_PROTOCOL, capabilities: { tools: {} }, serverInfo: { name: "agent-steps", version: VERSION } });
      if (frame.method === "ping") return answer({});
      if (frame.method === "tools/list") return answer({ tools: [...(await deps.upstream.tools()).filter((tool) => !STEPS_NAMES.has(tool.name)), ...STEPS_TOOLS] });
      if (frame.method !== "tools/call") return fail("Method not found.", -32601);
      const params = isRecord(frame.params) ? frame.params : {};
      const name = typeof params.name === "string" ? params.name : "";
      const args = isRecord(params.arguments) ? params.arguments : {};
      const stopper = new AbortController();
      calls.set(id, stopper);
      const mine = turn.then(() => toolCall(name, args, stopper.signal));
      turn = mine.catch(() => {});
      try {
        return answer(await mine);
      } finally {
        calls.delete(id);
      }
    } catch (error) {
      return fail(errorText(error));
    }
  }

  return { handle, recording: () => recording?.name ?? null };
}

/** Serves `handle` on stdin and stdout, one JSON-RPC message per line. */
export function serveStdio(handle: (frame: unknown) => Promise<unknown>, input: NodeJS.ReadableStream = process.stdin, output: NodeJS.WritableStream = process.stdout): void {
  let buffer = "";
  input.setEncoding("utf8");
  input.on("data", (chunk: string) => {
    buffer += chunk;
    let newline: number;
    while ((newline = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      let frame: unknown;
      try {
        frame = JSON.parse(line);
      } catch {
        output.write(`${JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error." } })}\n`);
        continue;
      }
      void handle(frame).then((reply) => { if (reply !== undefined) output.write(`${JSON.stringify(reply)}\n`); });
    }
  });
}
