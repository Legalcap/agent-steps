// The three no-model baselines, all driven by Playwright's Chromium. They are recorded together, once, on BASE: each
// intent is located there (with the role locator, which is exact on BASE), and what each baseline would have stored is
// kept: the click point, a DevTools-style CSS path, and a role locator.
import { chromium, type Browser, type Locator, type Page } from "playwright";
import type { Intent, Task } from "../fixture/site.ts";

export const ACTION_TIMEOUT_MS = 3_000;
/** A macro recorder replays with a fixed pause between steps; 300 ms is the bench's. */
const MACRO_PAUSE_MS = 300;
export const VIEWPORT = { width: 1280, height: 720 };

type Act = Exclude<Intent, { do: "open" }>;
export type PlaywrightStep =
  | { do: "open"; path: string }
  | { do: Act["do"]; value?: string; point: { x: number; y: number }; scrollY: number; css: string; intent: Act };

export interface PlaywrightRecording {
  steps: PlaywrightStep[];
}

export function roleLocator(page: Page, intent: Act): Locator {
  const scoped = intent.scope
    ? intent.scope.text ? page.getByRole(intent.scope.role as never).filter({ hasText: intent.scope.text }) : page.getByRole(intent.scope.role as never)
    : page;
  return scoped.getByRole(intent.role as never, { name: intent.name, exact: true });
}

/** The selector Chrome DevTools' "Copy selector" would give: an id where there is one, otherwise tag, a class unique
 * among its siblings, or :nth-child, up to the nearest ancestor with an id. */
const CSS_PATH = (element: Element): string => {
  const parts: string[] = [];
  let node: Element | null = element;
  while (node && node !== document.body) {
    if (node.id) {
      parts.unshift(`#${CSS.escape(node.id)}`);
      break;
    }
    const parent: Element | null = node.parentElement;
    if (!parent) break;
    const siblings = [...parent.children];
    const tag = node.localName;
    let part = tag;
    if (siblings.filter((sibling) => sibling.localName === tag).length > 1) {
      const current = node;
      const unique = [...node.classList].find((name) => !siblings.some((sibling) => sibling !== current && sibling.classList.contains(name)));
      part = unique ? `${tag}.${CSS.escape(unique)}` : `${tag}:nth-child(${siblings.indexOf(node) + 1})`;
    }
    parts.unshift(part);
    node = parent;
  }
  if (!parts[0]?.startsWith("#")) parts.unshift("body");
  return parts.join(" > ");
};

export class PlaywrightBench {
  private browser?: Browser;

  async start(): Promise<string> {
    this.browser = await chromium.launch({ headless: true });
    return this.browser.version();
  }

  async stop(): Promise<void> {
    await this.browser?.close();
  }

  private async page(): Promise<Page> {
    const context = await this.browser!.newContext({ viewport: VIEWPORT });
    const page = await context.newPage();
    page.setDefaultTimeout(ACTION_TIMEOUT_MS);
    page.setDefaultNavigationTimeout(10_000);
    return page;
  }

  /** Walks the intents on BASE and keeps what each baseline needs. */
  async record(task: Task, baseUrl: string): Promise<PlaywrightRecording> {
    const page = await this.page();
    const steps: PlaywrightStep[] = [];
    try {
      for (const intent of task.intents) {
        if (intent.do === "open") {
          await page.goto(baseUrl + intent.path);
          steps.push(intent);
          continue;
        }
        const target = roleLocator(page, intent);
        await target.waitFor({ state: "visible" });
        await target.scrollIntoViewIfNeeded();
        const box = await target.boundingBox();
        if (!box) throw new Error(`no box for ${intent.name}`);
        const css = await target.evaluate(CSS_PATH);
        const scrollY = await page.evaluate(() => window.scrollY);
        steps.push({ do: intent.do, ...(intent.value !== undefined ? { value: intent.value } : {}), point: { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) }, scrollY, css, intent });
        await perform(page, target, intent);
        await page.waitForLoadState("load");
      }
    } finally {
      await page.context().close();
    }
    return { steps };
  }

  /** Replays one baseline; resolves with the error that stopped it, or null. */
  async replay(kind: "coordinates" | "css" | "role", recording: PlaywrightRecording, baseUrl: string): Promise<{ ms: number; error: string | null }> {
    const page = await this.page();
    const started = performance.now();
    let error: string | null = null;
    try {
      for (const step of recording.steps) {
        if (step.do === "open") {
          await page.goto(baseUrl + step.path);
          continue;
        }
        if (kind === "coordinates") {
          await macroStep(page, step);
          continue;
        }
        const target = kind === "css" ? page.locator(step.css) : roleLocator(page, step.intent);
        await perform(page, target, step.intent);
      }
    } catch (caught) {
      error = caught instanceof Error ? caught.message.split("\n")[0]! : String(caught);
    }
    const ms = performance.now() - started;
    await page.waitForTimeout(400); // let any request the last action started reach the server (not timed)
    await page.context().close();
    return { ms, error };
  }
}

async function perform(page: Page, target: Locator, intent: Act): Promise<void> {
  if (intent.do === "click") await target.click();
  else if (intent.do === "fill") await target.fill(intent.value ?? "");
  else if (intent.do === "select") await target.selectOption({ label: intent.value ?? "" });
  else await target.check();
  void page;
}

/** A coordinate macro: click where the element was, type what was typed, with a fixed pause between steps. A native
 * select is driven the way a person does it with a keyboard and a recorder captures it: click it, then type the start
 * of the option's text (up to its first space or parenthesis), which selects it by type-ahead. */
async function macroStep(page: Page, step: Extract<PlaywrightStep, { point: unknown }>): Promise<void> {
  await page.waitForLoadState("load");
  if (step.scrollY) await page.evaluate((y) => window.scrollTo(0, y), step.scrollY);
  await page.mouse.click(step.point.x, step.point.y);
  if (step.do === "fill") await page.keyboard.type(step.value ?? "");
  if (step.do === "select") await page.keyboard.type((step.value ?? "").split(/[\s(]/u)[0]!);
  await page.waitForTimeout(MACRO_PAUSE_MS);
}
