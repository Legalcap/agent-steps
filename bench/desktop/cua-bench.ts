// Desktop bench (Cua): agent-steps vs. a coordinate macro on TextEdit and Notes, with the window moved and resized.
//
// NOT RUN by the bench authors: it takes over the screen (it moves windows, clicks and types for real). It is written
// against cua-driver's MCP tools as agent-steps' Cua driver uses them (list_apps, list_windows, get_window_state,
// launch_app, click, set_value) and macOS System Events for the coordinate macro and the ground truth. Expect to
// adjust element labels for your macOS version the first time; nothing here has been checked on a live screen.
//
// How to run (macOS, with cua-driver installed and Accessibility permission granted to the terminal):
//   node bench/desktop/cua-bench.ts [--n 5] [--driver "cua-driver mcp"]
// Close TextEdit and Notes first and do not touch the mouse or keyboard while it runs. Results go to
// bench/results/desktop-<date>.json; `node bench/render.ts` does not render them yet.
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { createRecorder, cuaDriver, replay, StdioMcpClient, type Caller } from "../../src/index.ts";
import { benchMeta } from "../lib/meta.ts";

const { values } = parseArgs({ options: { n: { type: "string", default: "5" }, driver: { type: "string", default: "cua-driver mcp" } } });
const n = Number(values.n);
const [command, ...args] = values.driver.split(" ");
const signal = new AbortController().signal;

const osa = (script: string): string => execFileSync("osascript", ["-e", script], { encoding: "utf8" }).trim();

interface DesktopTask {
  id: string;
  app: { bundleId: string; name: string };
  text: string;
  /** Opens a fresh window and returns its title. */
  prepare(): string;
  /** The element to click, then type into, as System Events names it (for the coordinate macro). */
  field: string;
  /** The label and role agent-steps should find in Cua's tree (what the recording agent would pick). */
  target: { role: string; label?: string };
  /** What the app holds afterwards: the ground truth. */
  read(): string;
  close(): void;
}

const TASKS: DesktopTask[] = [
  {
    id: "textedit-type",
    app: { bundleId: "com.apple.TextEdit", name: "TextEdit" },
    text: "Quarterly numbers look fine",
    prepare: () => {
      osa('tell application "TextEdit" to activate');
      osa('tell application "TextEdit" to make new document');
      return osa('tell application "TextEdit" to get name of front window');
    },
    field: 'text area 1 of scroll area 1 of front window',
    target: { role: "AXTextArea" },
    read: () => osa('tell application "TextEdit" to get text of front document'),
    close: () => { osa('tell application "TextEdit" to close every document saving no'); },
  },
  {
    id: "notes-new",
    app: { bundleId: "com.apple.Notes", name: "Notes" },
    text: "Call the venue about Friday",
    prepare: () => {
      osa('tell application "Notes" to activate');
      return osa('tell application "Notes" to get name of front window');
    },
    field: 'text area 1 of scroll area 1 of group 1 of splitter group 1 of front window',
    target: { role: "AXTextArea" },
    read: () => osa('tell application "Notes" to get plaintext of note 1'),
    close: () => {},
  },
];

/** The window's frame, moved and resized per variant. */
const VARIANTS = {
  base: { x: 100, y: 100, w: 900, h: 600 },
  moved: { x: 520, y: 260, w: 900, h: 600 },
  resized: { x: 100, y: 100, w: 640, h: 420 },
  "moved+resized": { x: 600, y: 300, w: 700, h: 480 },
} as const;
type Variant = keyof typeof VARIANTS;

function place(task: DesktopTask, variant: Variant): void {
  const { x, y, w, h } = VARIANTS[variant];
  osa(`tell application "System Events" to tell process "${task.app.name}" to set position of front window to {${x}, ${y}}`);
  osa(`tell application "System Events" to tell process "${task.app.name}" to set size of front window to {${w}, ${h}}`);
}

/** Where the field's centre is on screen, read through System Events (the coordinate macro's recording). */
function fieldCentre(task: DesktopTask): { x: number; y: number } {
  const [px, py] = osa(`tell application "System Events" to tell process "${task.app.name}" to get position of ${task.field}`).split(", ").map(Number);
  const [sw, sh] = osa(`tell application "System Events" to tell process "${task.app.name}" to get size of ${task.field}`).split(", ").map(Number);
  return { x: Math.round(px! + sw! / 2), y: Math.round(py! + Math.min(sh! / 2, 40)) };
}

function macroReplay(point: { x: number; y: number }, text: string): void {
  osa(`tell application "System Events" to click at {${point.x}, ${point.y}}`);
  osa(`tell application "System Events" to keystroke ${JSON.stringify(text)}`);
}

const client = new StdioMcpClient(command!, args);
await client.start();
const caller: Caller = client;
const driver = cuaDriver(caller);
const runs: Array<{ task: string; variant: Variant; contender: string; rep: number; outcome: string; error: string | null; ms: number }> = [];

try {
  for (const task of TASKS) {
    // Record both contenders on BASE.
    const title = task.prepare();
    place(task, "base");
    const point = fieldCentre(task);
    const recorder = createRecorder({ driver });
    const apps = await recorder.call("list_apps", {}, signal);
    const pid = apps.ok ? ((apps.structured.apps as Array<{ pid: number; bundle_id?: string }>).find((app) => app.bundle_id === task.app.bundleId)?.pid ?? 0) : 0;
    const windows = await recorder.call("list_windows", { pid }, signal);
    const windowId = windows.ok ? ((windows.structured.windows as Array<{ window_id: number; title: string }>).find((window) => window.title === title)?.window_id ?? 0) : 0;
    const state = await recorder.call("get_window_state", { pid, window_id: windowId }, signal);
    const elements = state.ok ? (state.structured.elements as Array<{ role: string; label?: string; element_token?: string }>) : [];
    const field = elements.find((element) => element.role === task.target.role && (task.target.label === undefined || element.label === task.target.label));
    if (!field?.element_token) throw new Error(`${task.id}: no ${task.target.role} in Cua's tree`);
    await recorder.call("click", { pid, window_id: windowId, element_token: field.element_token }, signal);
    await recorder.call("set_value", { pid, window_id: windowId, element_token: field.element_token, value: task.text }, signal);
    const saved = recorder.stop({ name: `${task.id} type ${task.text}` });
    task.close();
    if (!saved.ok) {
      runs.push({ task: task.id, variant: "base", contender: "agent-steps", rep: 0, outcome: "not-recorded", error: saved.reason, ms: 0 });
      continue;
    }

    for (const variant of Object.keys(VARIANTS) as Variant[]) {
      for (let rep = 0; rep < n; rep++) {
        for (const contender of ["agent-steps", "coordinates"] as const) {
          task.prepare();
          place(task, variant);
          const started = performance.now();
          let error: string | null = null;
          if (contender === "agent-steps") {
            const outcome = await replay(saved.recipe, { driver, policy: "standard" });
            if (outcome.kind !== "done") error = outcome.kind === "failed" ? outcome.error : outcome.kind;
          } else {
            macroReplay(point, task.text);
          }
          const ms = Math.round(performance.now() - started);
          const held = task.read();
          const outcome = held.includes(task.text) ? "success" : error ? "safe" : "dangerous";
          runs.push({ task: task.id, variant, contender, rep, outcome, error, ms });
          process.stderr.write(`[${task.id}/${variant}] ${contender} #${rep + 1}: ${outcome}${error ? ` · ${error}` : ""}\n`);
          task.close();
        }
      }
    }
  }
} finally {
  client.close();
}

const meta = benchMeta();
const out = join(import.meta.dirname, "..", "results", `desktop-${meta.date.slice(0, 10)}.json`);
mkdirSync(join(out, ".."), { recursive: true });
writeFileSync(out, `${JSON.stringify({ suite: "desktop", meta: { ...meta, n, driver: values.driver }, runs }, null, 1)}\n`);
process.stderr.write(`wrote ${out}\n`);
