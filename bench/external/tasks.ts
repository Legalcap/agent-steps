// The external suite's tasks: pages somebody else wrote. Each one is an `act` task from Stagehand's own eval suite
// (browserbase/stagehand, packages/evals/tasks/bench/act), on Stagehand's public eval sites. The request is the eval's
// act() instructions joined into one sentence, and `done` is the eval's own success condition, read from the page's
// address and its whole-page accessibility snapshot instead of from Playwright or a model.

/** The commit of browserbase/stagehand the tasks were read from. */
export const STAGEHAND_COMMIT = "8901460d69e2aef8eb639daa0b2dda3fe2e47a8f";
/** Where the eval sites are served. At that commit the eval files name a mirror of the same pages
 * (https://stagehand-eval-sites.vercel.app/sites/); the paths below it are the same. */
export const SITES = "https://browserbase.github.io/stagehand-eval-sites/sites/";
const ACT = "packages/evals/tasks/bench/act/";

/** What the judge reads after a run: the active tab's address and its snapshot with `interactive: false`. */
export interface PageRead {
  url: string;
  snapshot: string;
}

export interface PageNode {
  role: string;
  name: string;
  /** What stands between the brackets: `checked=true`, `selected`, `ref=e5`. */
  attrs: string[];
  /** A field's value: what follows `: ` at the end of its line. */
  value: string;
}

const NODE = /^\s*- ([^\s"[\]:]+)(?: "((?:[^"\\]|\\.)*)")?(?: \[([^\]]*)\])?(.*)$/u;
const unquote = (name: string): string => {
  try {
    return JSON.parse(`"${name}"`) as string;
  } catch {
    return name;
  }
};

/** A snapshot's lines as nodes, in page order. The judge's own reading, apart from agent-steps' parser. */
export function readPage(snapshot: string): PageNode[] {
  const nodes: PageNode[] = [];
  for (const line of snapshot.split("\n")) {
    const item = NODE.exec(line);
    if (!item) continue;
    const rest = item[4] ?? "";
    nodes.push({
      role: item[1]!, name: unquote(item[2] ?? ""), attrs: (item[3] ?? "").split(",").map((attr) => attr.trim()).filter(Boolean),
      value: rest.startsWith(": ") ? rest.slice(2).trim() : "",
    });
  }
  return nodes;
}

/** Text the page says: its text runs and headings, never the label of a button, link or field. */
const says = (page: PageRead, text: string): boolean =>
  readPage(page.snapshot).some((node) => (node.role === "StaticText" || node.role === "heading") && node.name.includes(text));
const field = (page: PageRead, role: string, name: RegExp): PageNode | undefined =>
  readPage(page.snapshot).find((node) => node.role === role && name.test(node.name.trim()));
const isChecked = (node: PageNode | undefined): boolean => node?.attrs.includes("checked=true") === true;
/** The checkbox that follows a text run: the page labels its boxes with plain text before each one. */
const boxAfter = (page: PageRead, label: RegExp): PageNode | undefined => {
  const nodes = readPage(page.snapshot);
  const at = nodes.findIndex((node) => node.role === "StaticText" && label.test(node.name.trim()));
  return at === -1 ? undefined : nodes.slice(at + 1).find((node) => node.role === "checkbox" || node.role === "StaticText");
};

export interface ExternalTask {
  id: string;
  /** The recipe's name when the task is recorded. */
  title: string;
  url: string;
  /** The Stagehand eval file the task came from. */
  source: string;
  /** What the agent is asked, after "Open <url>.". */
  ask: string;
  successCondition: string;
  done(page: PageRead): boolean;
}

const task = (id: string, site: string, title: string, ask: string, successCondition: string, done: ExternalTask["done"]): ExternalTask =>
  ({ id, title, url: SITES + site, source: `${ACT}${id}.ts`, ask, successCondition, done });
const CLICKED = "button successfully clicked";

/** In the order they run: the small pages first and the four dearest ones last (a click agent-browser refuses, two
 * long pages, a product page of 55 kB of snapshot), so a budget that runs out costs the fewest tasks. */
export const TASKS: ExternalTask[] = [
  task("shadow_dom", "shadow-dom/", "Click the button inside the shadow DOM", "Click the button.",
    `the page says "${CLICKED}"`, (page) => says(page, CLICKED)),
  task("osr_in_oopif", "open-shadow-root-in-oopif/", "Click the button inside the cross-site iframe", "Click the button.",
    `the page says "${CLICKED}"`, (page) => says(page, CLICKED)),
  task("ionwave", "ionwave/", "Open the closed bids", "Click on \"Closed Bids\".",
    `the address starts with ${SITES}ionwave/closed-bids.html`, (page) => page.url.startsWith(`${SITES}ionwave/closed-bids.html`)),
  task("simple_google_search", "google/", "Search for OpenAI", "Type \"OpenAI\" into the search bar, then press Enter.",
    `the address starts with ${SITES}google/openai.html`, (page) => page.url.startsWith(`${SITES}google/openai.html`)),
  task("custom_dropdown", "expand-dropdown/", "Choose Canada as the country", "Choose Canada from the 'Select a Country' dropdown.",
    "the page says \"You chose: Canada\" (the eval reads #chosenValue for \"Canada\")", (page) => says(page, "You chose: Canada")),
  task("hidden_input_dropdown", "hidden-input-dropdown/", "Expand the favourite colour dropdown", "Click to expand the 'Favourite Colour' dropdown.",
    "the page says \"Green\" (an option that only an expanded dropdown shows)",
    (page) => readPage(page.snapshot).some((node) => node.role === "StaticText" && node.name.trim() === "Green")),
  task("login", "login/", "Type the username", "Type \"business\" into the username field.",
    "the form's first field (\"Email address\") holds \"business\"", (page) => field(page, "textbox", /^Email address$/u)?.value === "business"),
  task("radio_btn", "paneer-pizza/", "Pick the medium pizza", "Click the 'medium' option.",
    "the \"Medium\" radio button is checked", (page) => isChecked(field(page, "radio", /^Medium\b/u))),
  task("checkboxes", "checkboxes/", "Tick baseball and netball", "Click the 'baseball' option, then click the 'netball' option.",
    "the checkboxes after \"Baseball:\" and \"Netball:\" are both checked",
    (page) => [/^Baseball:/u, /^Netball:/u].every((label) => {
      const box = boxAfter(page, label);
      return box?.role === "checkbox" && isChecked(box);
    })),
  task("iframe_same_proc", "iframe-same-proc/", "Fill the name and the favourite colour in the iframe",
    "Type 'stagehand' into the 'your name' field, then select 'Green' from the favorite colour dropdown.",
    "in the iframe, \"Your name\" holds \"stagehand\" and \"Favorite color\" shows \"Green\"",
    (page) => field(page, "textbox", /^Your name$/u)?.value.toLowerCase() === "stagehand" && field(page, "combobox", /^Favorite color$/u)?.value === "Green"),
  task("tab_handling", "new-tab/", "Open the other page in its new tab", "Click the button to open the other page.",
    `the active tab is ${SITES}new-tab/other.html and says "You’re on the other page"`,
    (page) => page.url === `${SITES}new-tab/other.html` && says(page, "You’re on the other page")),
  task("spif_in_osr", "spif-in-open-shadow-dom/", "Click the button inside the iframe in the shadow DOM", "Click the button.",
    `the page says "${CLICKED}"`, (page) => says(page, CLICKED)),
  task("os_dropdown", "nested-dropdown/", "Choose the smog check technician license type", "Choose 'Smog Check Technician' from the 'License Type' dropdown.",
    "the \"LICENSE TYPE\" dropdown shows \"Smog Check Technician\"", (page) => field(page, "combobox", /^LICENSE TYPE$/iu)?.value === "Smog Check Technician"),
  task("google_flights", "google-flights/", "Pick the first departing flight", "Click the first departing flight.",
    `the address is ${SITES}google-flights/return-flight.html`, (page) => page.url === `${SITES}google-flights/return-flight.html`),
  task("amazon_add_to_cart", "amazon/", "Add the laptop sleeve to the cart and go to checkout", "Click the 'Add to Cart' button, then click the 'Proceed to checkout' button.",
    `the address is ${SITES}amazon/sign-in.html`, (page) => page.url === `${SITES}amazon/sign-in.html`),
];

export const taskById = (id: string): ExternalTask | undefined => TASKS.find((candidate) => candidate.id === id);
export const requestFor = (item: ExternalTask): string => `Open ${item.url}\n\n${item.ask}`;
