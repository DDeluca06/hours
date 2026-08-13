// ---------------------------------------------------------------------------
// Reading existing rows.
//
// Two jobs: showing you what the sheet already says (so you don't double-log),
// and computing how much of a contract is spent. Deliberately read-only and
// non-destructive — this connector never reconciles by deleting sheet rows, in
// contrast to the LP repo's upsert + stale-cleanup sync, because here the sheet
// holds other people's rows too.
// ---------------------------------------------------------------------------

import { parseDurationToMinutes, parseClockRanges, type ClockRange } from '@hours/core';
import { getRows, listTabTitles, resolveTabTitle } from './client.js';
import { discoverLayout, quoteTab, type TabLayout } from './layout.js';

export interface ExistingRow {
  /** 1-indexed sheet row, so a correction can be pointed at the right place. */
  sheetRow: number;
  /** Raw Date cell, e.g. "8/12" or "2/26/26" — the sheet mixes both. */
  dateText: string;
  person: string;
  minutes: number | null;
  activity: string;
  notes: string;
  ranges: ClockRange[];
}

export async function loadLayout(spreadsheetId: string, wantTab: string): Promise<TabLayout> {
  const titles = await listTabTitles(spreadsheetId);
  const tabTitle = resolveTabTitle(wantTab, titles);
  const grid = await getRows(spreadsheetId, `${quoteTab(tabTitle)}!A1:Z12`);
  const layout = discoverLayout(tabTitle, grid);
  if (!layout) {
    throw new Error(
      `tab "${tabTitle}" has no recognizable Date/Person/Hours/Activity header in its first 12 rows`,
    );
  }
  return layout;
}

export async function readTab(
  spreadsheetId: string,
  wantTab: string,
): Promise<{ layout: TabLayout; rows: ExistingRow[] }> {
  const layout = await loadLayout(spreadsheetId, wantTab);
  const lastCol = String.fromCharCode(65 + Math.min(25, layout.dataWidth - 1));
  const values = await getRows(
    spreadsheetId,
    `${quoteTab(layout.tabTitle)}!A${layout.headerRow + 1}:${lastCol}`,
  );

  const rows: ExistingRow[] = [];
  values.forEach((row, i) => {
    const dateText = (row[layout.dateCol] ?? '').trim();
    const person = (row[layout.personCol] ?? '').trim();
    // A row with no date and no person is spacing, not data.
    if (!dateText && !person) return;
    const notes = layout.notesCol !== null ? (row[layout.notesCol] ?? '').trim() : '';
    rows.push({
      sheetRow: layout.headerRow + 1 + i,
      dateText,
      person,
      minutes: parseDurationToMinutes(row[layout.hoursCol]),
      activity: (row[layout.activityCol] ?? '').trim(),
      notes,
      ranges: parseClockRanges(notes),
    });
  });

  return { layout, rows };
}

export interface TabTotals {
  totalMinutes: number;
  byPerson: Map<string, number>;
  byActivity: Map<string, number>;
  /** Rows whose Hours cell could not be parsed — surfaced, never silently dropped. */
  unparsedRows: number[];
}

export function summarize(rows: readonly ExistingRow[]): TabTotals {
  const byPerson = new Map<string, number>();
  const byActivity = new Map<string, number>();
  const unparsedRows: number[] = [];
  let totalMinutes = 0;

  for (const r of rows) {
    if (r.minutes === null) {
      if (r.person) unparsedRows.push(r.sheetRow);
      continue;
    }
    totalMinutes += r.minutes;
    // The sheet contains casing duplicates (Kristian/kristian, Jamir/jamir).
    // Fold them for totals, but keep the first-seen spelling as the label.
    const key = canonicalPerson(r.person, byPerson);
    byPerson.set(key, (byPerson.get(key) ?? 0) + r.minutes);
    byActivity.set(r.activity, (byActivity.get(r.activity) ?? 0) + r.minutes);
  }

  return { totalMinutes, byPerson, byActivity, unparsedRows };
}

function canonicalPerson(person: string, seen: ReadonlyMap<string, number>): string {
  const lower = person.toLowerCase();
  for (const existing of seen.keys()) {
    if (existing.toLowerCase() === lower) return existing;
  }
  return person;
}

/** Minutes already logged in a tab for one person on one sheet-date string. */
export function minutesFor(
  rows: readonly ExistingRow[],
  person: string,
  dateText: string,
): number {
  const p = person.toLowerCase();
  return rows
    .filter((r) => r.person.toLowerCase() === p && sameSheetDate(r.dateText, dateText))
    .reduce((sum, r) => sum + (r.minutes ?? 0), 0);
}

/**
 * Compare two Date cells tolerantly.
 *
 * The sheet holds both "2/26" and "2/26/26" for the same day, so a naive string
 * comparison would report a day as un-logged when it isn't. Month and day must
 * always agree; the year is only compared when *both* cells carry one — an
 * undated year cannot disagree with anything, but "2/26/25" and "2/26/26" are
 * different days and must not collide.
 */
export function sameSheetDate(a: string, b: string): boolean {
  const pa = parseSheetDate(a);
  const pb = parseSheetDate(b);
  if (pa === null || pb === null) return a.trim() === b.trim();
  if (pa.month !== pb.month || pa.day !== pb.day) return false;
  if (pa.year === null || pb.year === null) return true;
  return pa.year === pb.year;
}

/**
 * A YYYY-MM-DD entry day as a year-carrying sheet date, "2026-02-26" → "2/26/2026".
 *
 * The sheet itself is written as bare "M/D" — that is the tab's convention and
 * `formatSheetDate` keeps it — but a *comparison* against existing rows has to
 * know the year, or a row logged on 2/26 last year matches an entry for 2/26
 * this year. Use this on the entry side of `sameSheetDate`, never for a write.
 */
export function sheetDateWithYear(day: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day.trim());
  if (!m) return day.trim();
  return `${Number(m[2])}/${Number(m[3])}/${m[1]}`;
}

/** "2/26", "2/26/26", "2/26/2026" → parts, with a 2-digit year expanded. */
function parseSheetDate(s: string): { month: number; day: number; year: number | null } | null {
  // \d{4} before \d{2}: the pattern is unanchored, so the two-digit branch
  // would otherwise match "20" out of "2026" and read the year as 2020.
  const m = /^(\d{1,2})\/(\d{1,2})(?:\/(\d{4}|\d{2}))?/.exec(s.trim());
  if (!m) return null;
  const raw = m[3];
  const year = raw === undefined ? null : raw.length === 2 ? 2000 + Number(raw) : Number(raw);
  return { month: Number(m[1]), day: Number(m[2]), year };
}
