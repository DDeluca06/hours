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
 * comparison would report a day as un-logged when it isn't.
 */
export function sameSheetDate(a: string, b: string): boolean {
  const parse = (s: string) => {
    const m = /^(\d{1,2})\/(\d{1,2})/.exec(s.trim());
    return m ? `${Number(m[1])}/${Number(m[2])}` : s.trim();
  };
  return parse(a) === parse(b);
}
