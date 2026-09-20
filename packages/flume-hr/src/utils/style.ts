// Zero-dependency ANSI styling + iconography for pjangler CLI output.
//
// Color is emitted only to a capable TTY. We honor NO_COLOR
// (https://no-color.org/), FORCE_COLOR, TERM=dumb, and stdout TTY detection so
// that piped / redirected / `--json` / MCP (non-TTY) output stays clean and
// machine-parseable. Unicode glyphs are width-1 and rendered unconditionally so
// column alignment holds whether or not color is active.

const env = process.env;

function detectColor(): boolean {
  // NO_COLOR: present and non-empty disables color regardless of value.
  if ("NO_COLOR" in env && env.NO_COLOR !== "") return false;
  const force = env.FORCE_COLOR;
  if (force === "0" || force === "false") return false;
  if (force !== undefined && force !== "") return true;
  if (env.TERM === "dumb") return false;
  return Boolean(process.stdout.isTTY);
}

/** Whether ANSI color codes should be emitted for this process. */
export const colorEnabled: boolean = detectColor();

type Colorize = (value: string | number) => string;

function sgr(open: number, close: number): Colorize {
  const prefix = `\x1b[${open}m`;
  const suffix = `\x1b[${close}m`;
  return (value) => (colorEnabled ? `${prefix}${value}${suffix}` : String(value));
}

export const bold = sgr(1, 22);
export const dim = sgr(2, 22);
export const italic = sgr(3, 23);
export const underline = sgr(4, 24);
export const red = sgr(31, 39);
export const green = sgr(32, 39);
export const yellow = sgr(33, 39);
export const blue = sgr(34, 39);
export const magenta = sgr(35, 39);
export const cyan = sgr(36, 39);
export const gray = sgr(90, 39);

/** Small, alignment-safe (width-1) glyph vocabulary shared across commands. */
export const glyph = {
  pass: "✔",
  fail: "✖",
  warn: "⚠",
  skip: "○",
  info: "ℹ",
  arrow: "↳",
  bullet: "•",
  dot: "·",
  add: "+",
  chevron: "▸",
  pointer: "❯",
} as const;

export interface StatusStyle {
  glyph: string;
  color: Colorize;
  label: string;
}

// Covers both audit statuses (pass/fail/warn/skip) and migration result
// statuses (applied/noop/blocked/skipped/partial).
const STATUS_STYLES: Record<string, StatusStyle> = {
  pass: { glyph: glyph.pass, color: green, label: "pass" },
  fail: { glyph: glyph.fail, color: red, label: "fail" },
  warn: { glyph: glyph.warn, color: yellow, label: "warn" },
  skip: { glyph: glyph.skip, color: gray, label: "skip" },
  applied: { glyph: glyph.pass, color: green, label: "applied" },
  noop: { glyph: glyph.skip, color: gray, label: "noop" },
  blocked: { glyph: glyph.fail, color: red, label: "blocked" },
  skipped: { glyph: glyph.skip, color: gray, label: "skipped" },
  partial: { glyph: glyph.warn, color: yellow, label: "partial" },
};

/** Resolve icon + color + label for a rule/migration status string. */
export function statusStyle(status: string): StatusStyle {
  return STATUS_STYLES[status] ?? { glyph: glyph.dot, color: dim, label: status };
}

/** Color a short project lifecycle status (planned/active/archived/…). */
export function projectStatusColor(status: string): Colorize {
  switch (status) {
    case "active":
      return green;
    case "planned":
      return yellow;
    case "archived":
      return gray;
    default:
      return cyan;
  }
}

/** A section heading: colored marker + bold title. */
export function heading(title: string, marker: string = glyph.chevron): string {
  return `${cyan(bold(marker))} ${bold(title)}`;
}

/** Join fragments with a dim middot separator ( · ). */
export function joinDot(fragments: string[]): string {
  return fragments.join(dim(` ${glyph.dot} `));
}

// ---------------------------------------------------------------------------
// Width-aware layout
//
// The default idiom in this codebase is pad-then-color — pad the RAW string,
// then colorize the padded result — and it must stay that way, because
// String.padEnd counts the invisible escape bytes toward the target width.
// `cyan("mise").padEnd(12)` is a silent no-op: the colored string is already 14
// characters long, so nothing is added and the column collapses.
//
// The helpers below are for the case pad-then-color cannot cover: a cell built
// from SEVERAL colored fragments, where there is no single raw string left to
// pad. There the pad has to be measured against visible width and placed
// outside the color runs.
// ---------------------------------------------------------------------------

// eslint-disable-next-line no-control-regex
const ANSI_PATTERN = /\x1b\[[0-9;]*m/g;

/** Drop SGR escapes, leaving what the terminal actually shows. */
export function stripAnsi(value: string): string {
  return value.replace(ANSI_PATTERN, "");
}

/** Rendered column count of a possibly-colored string. */
export function visibleWidth(value: string): number {
  return stripAnsi(value).length;
}

/** Right-pad to `width` measured in VISIBLE columns; pad stays unstyled. */
export function padVisible(value: string, width: number): string {
  return value + " ".repeat(Math.max(0, width - visibleWidth(value)));
}

/** Truncate to `width` visible columns, marking the cut with an ellipsis. */
export function truncateVisible(value: string, width: number): string {
  if (width <= 0) return "";
  const plain = stripAnsi(value);
  if (plain.length <= width) return value;
  // Truncating mid-escape would leak color into the rest of the line, so only
  // plain strings are cut; a colored value is reduced to its visible text.
  if (plain.length !== value.length) return width <= 1 ? "…" : `${plain.slice(0, width - 1)}…`;
  return width <= 1 ? "…" : `${value.slice(0, width - 1)}…`;
}

/**
 * Usable terminal width.
 *
 * The `> 0` guard is load-bearing rather than defensive: `columns` is
 * undefined on a pipe AND can be reported as 0 by a real pty, so a plain
 * `?? fallback` still yields a zero-width layout.
 */
export function terminalWidth(stream: { columns?: number } = process.stdout, fallback = 100): number {
  const columns = stream.columns;
  return typeof columns === "number" && columns > 0 ? columns : fallback;
}

/** Greedy word wrap over visible width. Returns at least one (possibly empty) line. */
export function wrapVisible(text: string, width: number): string[] {
  if (width <= 0) return [text];
  const lines: string[] = [];
  let current = "";
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if (!current) {
      current = word;
    } else if (visibleWidth(current) + 1 + visibleWidth(word) <= width) {
      current = `${current} ${word}`;
    } else {
      lines.push(current);
      current = word;
    }
    // A single word longer than the column gets hard-split rather than
    // pushing the whole layout sideways.
    while (visibleWidth(current) > width) {
      lines.push(current.slice(0, width));
      current = current.slice(width);
    }
  }
  lines.push(current);
  return lines;
}
