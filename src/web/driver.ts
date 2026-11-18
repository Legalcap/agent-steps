// The browser driver: agent-browser's tools (agent_browser_snapshot, agent_browser_click, ...), reached through whatever
// Caller the host gives it. Each targeted step reads a fresh snapshot and acts on the one element with its role and name.
import type { Caller, CallOutcome, Driver, Resolved, WebStep } from "../types.ts";
import { WEB_PREFIX, learnWeb, webLabel, webOwns, webRefusal, webWords } from "./rules.ts";
import { matching, pageOf, readSnapshot, saidText } from "./snapshot.ts";

export interface AgentBrowserDriverOptions {
  /** The tools' name prefix, `agent_browser_` by default. */
  prefix?: string;
}

const textOf = (outcome: Extract<CallOutcome, { ok: true }>): string => outcome.text ?? "";
/** agent-browser's refusal to act on an element another one covers at its click point. */
const COVERED = /\bis covered by\b/iu;
const UNCOVER_PX = 300;
/** Keys with no element of their own go to whatever has focus, and a page that has just opened is not listening yet. */
const KEY_SETTLE_MS = 300;

export function agentBrowserDriver(caller?: Caller, options: AgentBrowserDriverOptions = {}): Driver<WebStep> {
  const prefix = options.prefix ?? WEB_PREFIX;
  const live = (): Caller => {
    if (!caller) throw new Error("this agent-browser driver was made without a caller, so it can only learn");
    return caller;
  };
  const snapshot = (signal: AbortSignal) => live().call(`${prefix}snapshot`, {}, signal);
  // A check reads the whole page: the default snapshot holds only what can be acted on, not text such as "Saved".
  const wholePage = (signal: AbortSignal) => live().call(`${prefix}snapshot`, { interactive: false }, signal);
  return {
    kind: "agent-browser",
    owns: prefix === WEB_PREFIX ? webOwns : (tool) => tool.startsWith(prefix),
    learn: (calls, context) => learnWeb(prefix === WEB_PREFIX ? calls : calls.map((call) => ({ ...call, tool: WEB_PREFIX + call.tool.slice(prefix.length) })), context),
    refusal: webRefusal,
    words: webWords,
    label: webLabel,
    async resolve(step, signal): Promise<Resolved> {
      const tool = `${prefix}${step.tool}`;
      const { target } = step;
      if (!target) {
        if (step.tool === "press") await live().call(`${prefix}wait_ms`, { ms: KEY_SETTLE_MS }, signal);
        return { ok: true, tool, args: step.args };
      }
      if (target.url) {
        // A step recorded on one page never runs on another, so a page that cannot be read stops it too.
        const where = await live().call(`${prefix}get_url`, {}, signal);
        if (!where.ok) return where;
        const here = pageOf(textOf(where).trim());
        if (here !== target.url) return { ok: false, error: `the page is ${here ?? "unknown"}, not ${target.url}`, missing: true };
      }
      const seen = await snapshot(signal);
      if (!seen.ok) return seen;
      const found = matching(readSnapshot(textOf(seen)), target);
      const named = `"${target.name}" (${target.role})${target.near ? ` under "${target.near}"` : ""}`;
      if (found.length === 0) return { ok: false, error: `no ${named} on the page`, missing: true };
      if (found.length > 1) return { ok: false, error: `more than one ${named} on the page` };
      return { ok: true, tool, args: { ...step.args, selector: `@${found[0]!.ref}` } };
    },
    async perform(tool, args, signal) {
      const done = await live().call(tool, args, signal);
      if (done.ok || !COVERED.test(done.error) || typeof args.selector !== "string") return done;
      // Something fixed to the window (a cookie banner, a sticky bar) sits over the element. Scrolling moves the element
      // out from under it; nothing else is touched, and agent-browser still refuses a click that would land elsewhere.
      for (const direction of ["down", "up"]) {
        const scrolled = await live().call(`${prefix}scroll`, { direction, amount: direction === "down" ? UNCOVER_PX : 2 * UNCOVER_PX }, signal);
        if (!scrolled.ok) return done;
        const again = await live().call(tool, args, signal);
        if (again.ok || !COVERED.test(again.error)) return again;
      }
      return done;
    },
    async sees(check, signal) {
      const seen = await wholePage(signal);
      return seen.ok ? { ok: true, seen: saidText(textOf(seen)).includes(check.text) } : seen;
    },
  };
}
