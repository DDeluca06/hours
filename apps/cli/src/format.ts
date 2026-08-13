// ---------------------------------------------------------------------------
// Terminal rendering.
//
// Kept free of any dependency: the review table is the main interface, and it
// should never be the reason an install breaks. Colour is opt-out via NO_COLOR
// and auto-disabled when stdout is not a TTY, so `hours day | tee` stays clean.
// ---------------------------------------------------------------------------

import { formatClockRanges, formatMinutesShort, type Entry } from '@hours/core';
import type { StoredEntry } from '@hours/lib-db';

const useColor = process.stdout.isTTY === true && !process.env['NO_COLOR'];

const codes = {
  reset: '\u001b[0m',
  dim: '\u001b[2m',
  bold: '\u001b[1m',
  red: '\u001b[31m',
  yellow: '\u001b[33m',
  green: '\u001b[32m',
  cyan: '\u001b[36m',
} as const;

function paint(text: string, code: keyof typeof codes): string {
  return useColor ? `${codes[code]}${text}${codes.reset}` : text;
}

export const dim = (s: string): string => paint(s, 'dim');
export const bold = (s: string): string => paint(s, 'bold');
export const red = (s: string): string => paint(s, 'red');
export const yellow = (s: string): string => paint(s, 'yellow');
export const green = (s: string): string => paint(s, 'green');
export const cyan = (s: string): string => paint(s, 'cyan');

const STATUS_MARK: Record<Entry['status'], string> = {
  draft: '·',
  approved: '✓',
  pushed: '↗',
};

/** Visible width, ignoring the ANSI escapes so columns still line up. */
function width(s: string): number {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\u001b\[[0-9;]*m/g, '').length;
}

function pad(s: string, to: number): string {
  const gap = to - width(s);
  return gap > 0 ? s + ' '.repeat(gap) : s;
}

export function renderTable(headers: readonly string[], rows: readonly string[][]): string {
  const widths = headers.map((h, i) =>
    Math.max(width(h), ...rows.map((r) => width(r[i] ?? ''))),
  );
  const line = (cells: readonly string[]): string =>
    cells.map((c, i) => pad(c ?? '', widths[i] ?? 0)).join('  ').trimEnd();

  return [
    dim(line(headers)),
    ...rows.map((r) => line(r)),
  ].join('\n');
}

/** Short, stable id prefix — enough to type, long enough not to collide. */
export function shortId(id: string): string {
  return id.slice(-6);
}

export function renderEntries(entries: readonly StoredEntry[], opts: { showProvenance?: boolean } = {}): string {
  if (entries.length === 0) return dim('  (nothing)');

  const rows = entries.map((e) => [
    dim(shortId(e.id)),
    // The task ref sits right after the id, same slot as describeEntries —
    // "[#136] " is 7 wide, padded so refs of different lengths still align.
    e.taskId ? `[#${e.taskId}]`.padEnd(7) : '',
    STATUS_MARK[e.status],
    e.day,
    e.projectKey,
    e.activity,
    formatMinutesShort(e.minutes),
    e.ranges.length ? formatClockRanges(e.ranges) : dim('—'),
    e.description ?? dim('(no note)'),
  ]);

  const table = renderTable(
    ['ID', 'TASK', '', 'DAY', 'PROJECT', 'ACTIVITY', 'TIME', 'WHEN', 'NOTES'],
    rows,
  );

  if (!opts.showProvenance) return table;

  const notes = entries
    .filter((e) => e.provenance)
    .map((e) => dim(`  ${shortId(e.id)}  ${e.provenance ?? ''}`))
    .join('\n');
  return notes ? `${table}\n\n${dim('why:')}\n${notes}` : table;
}

export function renderTotals(entries: readonly StoredEntry[]): string {
  const byProject = new Map<string, number>();
  const byActivity = new Map<string, number>();
  let total = 0;
  for (const e of entries) {
    total += e.minutes;
    byProject.set(e.projectKey, (byProject.get(e.projectKey) ?? 0) + e.minutes);
    byActivity.set(e.activity, (byActivity.get(e.activity) ?? 0) + e.minutes);
  }

  const part = (m: ReadonlyMap<string, number>): string =>
    [...m.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `${k} ${formatMinutesShort(v)}`)
      .join(', ');

  return [
    `${bold('total')} ${formatMinutesShort(total)}`,
    byProject.size ? dim(`  by project: ${part(byProject)}`) : '',
    byActivity.size ? dim(`  by activity: ${part(byActivity)}`) : '',
  ]
    .filter(Boolean)
    .join('\n');
}
