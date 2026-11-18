// The README's benchmark charts, as static SVG: horizontal bars, light and dark (the SVG follows the reader's color
// scheme), a 4 px rounded data end, 2 px gaps between stacked segments, direct value labels and a legend for two or
// more series. Colors: status green / gray / red for outcomes, categorical blue and orange for the two approaches.

const W = 720;
const LEFT = 210;
const RIGHT = 70;
const PLOT = W - LEFT - RIGHT;
const BAR = 22;
const ROW = 36;
const R = 4;

export const STATUS = { good: "#0ca30c", neutral: "#a3a29c", critical: "#d03b3b" };

const esc = (text: string) => text.replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;");

/** A bar rounded only at its data end (the right), square on the baseline. */
function bar(x: number, y: number, w: number, h: number, cls: string, rounded = true): string {
  if (w <= 0) return "";
  const r = rounded ? Math.min(R, w, h / 2) : 0;
  return `<path class="${cls}" d="M${x.toFixed(1)},${y} h${(w - r).toFixed(1)} a${r},${r} 0 0 1 ${r},${r} v${h - 2 * r} a${r},${r} 0 0 1 -${r},${r} h-${(w - r).toFixed(1)} z"/>`;
}

function frame(title: string, subtitle: string, height: number, body: string[], extraStyle = ""): string {
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${height}" viewBox="0 0 ${W} ${height}" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif" font-size="13" role="img" aria-label="${esc(title)}">`,
    "<style>",
    ".surface{fill:#fcfcfb}.ink{fill:#0b0b0b}.ink2{fill:#52514e}.axis{stroke:#d9d8d3}.gap{stroke:#fcfcfb}",
    ".on-neutral{fill:#0b0b0b}.good{fill:#0ca30c}.neutral{fill:#a3a29c}.critical{fill:#d03b3b}.s1{fill:#2a78d6}.s2{fill:#eb6834}",
    extraStyle,
    "@media (prefers-color-scheme: dark){.surface{fill:#1a1a19}.ink{fill:#f0efec}.ink2{fill:#c3c2b7}.axis{stroke:#3a3936}.gap{stroke:#1a1a19}.neutral{fill:#6f6e69}.on-neutral{fill:#f0efec}.s1{fill:#3987e5}.s2{fill:#d95926}}",
    "</style>",
    `<rect class="surface" width="100%" height="100%" rx="8"/>`,
    `<text class="ink" x="20" y="30" font-size="16" font-weight="600">${esc(title)}</text>`,
    `<text class="ink2" x="20" y="50">${esc(subtitle)}</text>`,
    ...body,
    "</svg>",
    "",
  ].join("\n");
}

function legend(items: Array<[cls: string, label: string]>, y: number): string[] {
  let x = LEFT;
  return items.flatMap(([cls, label]) => {
    const parts = [`<rect class="${cls}" x="${x}" y="${y - 10}" width="12" height="12" rx="2"/>`, `<text class="ink2" x="${x + 18}" y="${y}">${esc(label)}</text>`];
    x += 30 + label.length * 7;
    return parts;
  });
}

/** One bar per row, one measure; the value printed at the bar's end. */
export function singleBars(title: string, subtitle: string, rows: Array<{ label: string; value: number }>, max: number, cls: string): string {
  const top = 74;
  const body: string[] = [];
  rows.forEach((row, index) => {
    const y = top + index * ROW;
    const w = (row.value / max) * PLOT;
    body.push(`<text class="ink" x="${LEFT - 12}" y="${y + 15}" text-anchor="end">${esc(row.label)}</text>`);
    body.push(bar(LEFT, y, w, BAR, cls));
    body.push(`<text class="ink" x="${LEFT + w + 8}" y="${y + 15}" font-weight="600">${row.value}</text>`);
  });
  body.push(`<line class="axis" x1="${LEFT}" x2="${LEFT}" y1="${top - 6}" y2="${top + rows.length * ROW - 8}" stroke-width="1"/>`);
  return frame(title, subtitle, top + rows.length * ROW + 10, body);
}

/** One 100 % bar per row, split into success / safe stop / wrong action, with each share printed inside. */
export function outcomeBars(title: string, subtitle: string, rows: Array<{ label: string; success: number; safe: number; dangerous: number }>): string {
  const top = 92;
  const body = legend([["good", "finished"], ["neutral", "stopped safely"], ["critical", "wrong action"]], 76);
  rows.forEach((row, index) => {
    const y = top + index * ROW;
    const total = row.success + row.safe + row.dangerous;
    body.push(`<text class="ink" x="${LEFT - 12}" y="${y + 15}" text-anchor="end">${esc(row.label)}</text>`);
    let x = LEFT;
    const segments: Array<[keyof typeof STATUS, number]> = [["good", row.success], ["neutral", row.safe], ["critical", row.dangerous]];
    const last = segments.filter(([, value]) => value > 0).at(-1)?.[0];
    for (const [cls, value] of segments) {
      if (!value) continue;
      const w = (value / total) * PLOT;
      body.push(bar(x, y, w - (cls === last ? 0 : 2), BAR, cls, cls === last));
      if (w > 38) body.push(`<text x="${(x + 8).toFixed(1)}" y="${y + 15}" ${cls === "neutral" ? 'class="on-neutral"' : 'fill="#ffffff"'} font-weight="600">${Math.round((100 * value) / total)}%</text>`);
      x += w;
    }
  });
  return frame(title, subtitle, top + rows.length * ROW + 10, body);
}

/** Two bars per group (series 1 and 2), values printed at the bars' ends with `format`. */
export function pairedBars(title: string, subtitle: string, names: [string, string], groups: Array<{ label: string; values: [number, number] }>, format: (value: number) => string): string {
  const top = 92;
  const pair = 2 * 18 + 4;
  const groupH = pair + 18;
  const max = Math.max(...groups.flatMap((group) => group.values));
  const body = legend([["s1", names[0]], ["s2", names[1]]], 76);
  groups.forEach((group, index) => {
    const y = top + index * groupH;
    body.push(`<text class="ink" x="${LEFT - 12}" y="${y + 24}" text-anchor="end">${esc(group.label)}</text>`);
    group.values.forEach((value, series) => {
      const w = (value / max) * PLOT;
      const by = y + series * 22;
      body.push(bar(LEFT, by, w, 18, series ? "s2" : "s1"));
      body.push(`<text class="ink" x="${LEFT + w + 8}" y="${by + 13}" font-weight="600">${esc(format(value))}</text>`);
    });
  });
  body.push(`<line class="axis" x1="${LEFT}" x2="${LEFT}" y1="${top - 6}" y2="${top + groups.length * groupH - 14}" stroke-width="1"/>`);
  return frame(title, subtitle, top + groups.length * groupH, body);
}
