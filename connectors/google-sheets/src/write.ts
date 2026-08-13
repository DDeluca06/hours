// ---------------------------------------------------------------------------
// Appending rows.
//
// This is the only code in the project that mutates something other people can
// see, so it is deliberately narrow: append-only, bounded to the tab's data
// columns, never an update or delete, and it re-reads the tab first to refuse
// duplicates. There is no "sync" here — a row that is wrong after a push gets
// fixed in the sheet by a human, and `hours pull` will show the difference.
// ---------------------------------------------------------------------------

import { isActivity, toSheetRow, type Entry } from '@hours/core';
import { getSheets } from './client.js';
import { appendRange, buildRowCells, type TabLayout } from './layout.js';
import { minutesFor, readTab, sameSheetDate, sheetDateWithYear, type ExistingRow } from './read.js';

export interface AppendResult {
  /** The A1 range the API reports the rows landed in. */
  updatedRange: string;
  rowCount: number;
  minutes: number;
}

export interface DuplicateWarning {
  entryIndex: number;
  message: string;
}

/**
 * Look for rows already in the sheet that this push would duplicate.
 *
 * Matching on person + date + activity + duration, since that combination is
 * what a re-run of the same reconstruction would produce. Returns warnings, not
 * errors: a genuine second Client Meeting of the same length on the same day is
 * possible, just worth a confirmation.
 */
export function findDuplicates(
  entries: readonly Entry[],
  existing: readonly ExistingRow[],
): DuplicateWarning[] {
  const out: DuplicateWarning[] = [];
  entries.forEach((e, i) => {
    const row = toSheetRow(e);
    // Compared against the entry's full day, not the bare "M/D" that gets
    // written: the tab holds rows from previous years, and 2/26/25 is not a
    // duplicate of an entry for 2/26/26.
    const day = sheetDateWithYear(e.day);
    const hit = existing.find(
      (r) =>
        r.person.toLowerCase() === e.person.toLowerCase() &&
        sameSheetDate(r.dateText, day) &&
        r.activity.toLowerCase() === e.activity.toLowerCase() &&
        r.minutes === e.minutes,
    );
    if (hit) {
      out.push({
        entryIndex: i,
        message: `row ${hit.sheetRow} already logs ${row.date} ${e.person} ${e.activity} ${row.hours}`,
      });
    }
  });
  return out;
}

export interface PushOptions {
  spreadsheetId: string;
  tabTitle: string;
  entries: readonly Entry[];
  /** Append even when a matching row already exists. */
  allowDuplicates?: boolean;
  /**
   * A tab already read by the caller, reused instead of re-reading it.
   *
   * Only for previews: a caller that needs the tab for something else (the
   * contract-hours ceiling) would otherwise pay a second round trip for the
   * same bytes. `pushEntries` deliberately never passes this — the append
   * target and the duplicate check must come from a fresh read.
   */
  tab?: { layout: TabLayout; rows: readonly ExistingRow[] };
}

export interface PushPreview {
  layout: TabLayout;
  cells: string[][];
  duplicates: DuplicateWarning[];
  /** Minutes this person already has on the affected days. */
  existingByDay: Map<string, number>;
  minutes: number;
  /** Highest sheet row holding real data — the append goes right below it. */
  lastRealRow: number;
}

/**
 * Where the real data ends: the last parsed row (one that has a date and a
 * person). Stray cells parked below — dropdown leftovers, notes — do not count;
 * an append must land right after the data, not after the sheet's last scribble.
 */
export function lastRealRow(rows: readonly ExistingRow[], headerRow: number): number {
  let last = headerRow;
  for (const r of rows) {
    // A dated cell with no person is a dropdown leftover, not data — counting
    // it would drag the append target below the sheet's scribbles.
    if (!r.dateText || !r.person) continue;
    if (r.sheetRow > last) last = r.sheetRow;
  }
  return last;
}

/** Build exactly what would be appended, without appending it. */
export async function previewPush(opts: PushOptions): Promise<PushPreview> {
  for (const e of opts.entries) {
    if (!isActivity(e.activity)) {
      throw new Error(
        `refusing to push "${e.activity}": not one of the sheet's activities, and it would break the tab's pivot table`,
      );
    }
    if (!e.person.trim()) throw new Error('refusing to push a row with no Person');
    if (e.minutes <= 0) throw new Error(`refusing to push a ${e.minutes}-minute row`);
  }

  const { layout, rows } = opts.tab ?? (await readTab(opts.spreadsheetId, opts.tabTitle));
  const cells = opts.entries.map((e) => buildRowCells(layout, toSheetRow(e)));
  const duplicates = findDuplicates(opts.entries, rows);

  const existingByDay = new Map<string, number>();
  for (const e of opts.entries) {
    // Keyed by the displayed "M/D" but queried with the year, same reason as
    // the duplicate check above.
    const date = toSheetRow(e).date;
    if (!existingByDay.has(date)) {
      existingByDay.set(date, minutesFor(rows, e.person, sheetDateWithYear(e.day)));
    }
  }

  return {
    layout,
    cells,
    duplicates,
    existingByDay,
    minutes: opts.entries.reduce((s, e) => s + e.minutes, 0),
    lastRealRow: lastRealRow(rows, layout.headerRow),
  };
}

/**
 * Append the entries to their tab.
 *
 * `INSERT_ROWS` rather than `OVERWRITE`: overwrite would reuse blank cells below
 * the data block, and several tabs have unrelated content parked down there.
 * `USER_ENTERED` so the Hours strings are stored as real durations the tab's
 * pivot tables can sum, not as text.
 */
export async function pushEntries(opts: PushOptions): Promise<AppendResult> {
  // `tab` is dropped on purpose: a preview taken before the operator confirmed
  // may be minutes old, and both the append row and the duplicate check have to
  // reflect what is in the sheet at the moment of the write.
  const preview = await previewPush({
    spreadsheetId: opts.spreadsheetId,
    tabTitle: opts.tabTitle,
    entries: opts.entries,
    ...(opts.allowDuplicates !== undefined ? { allowDuplicates: opts.allowDuplicates } : {}),
  });

  if (preview.duplicates.length > 0 && !opts.allowDuplicates) {
    throw new Error(
      `refusing to push — the sheet already has matching rows:\n  ${preview.duplicates
        .map((d) => d.message)
        .join('\n  ')}\nRe-run with --allow-duplicates if these are genuinely separate.`,
    );
  }

  const range = appendRange(preview.layout, preview.lastRealRow);

  const res = await getSheets().spreadsheets.values.append({
    spreadsheetId: opts.spreadsheetId,
    range,
    valueInputOption: 'USER_ENTERED',
    insertDataOption: 'INSERT_ROWS',
    includeValuesInResponse: false,
    requestBody: { values: preview.cells },
  });

  const updatedRange = res.data.updates?.updatedRange;
  if (!updatedRange) {
    throw new Error('append returned no updatedRange — treat the push as unconfirmed and check the sheet');
  }

  return {
    updatedRange,
    rowCount: res.data.updates?.updatedRows ?? preview.cells.length,
    minutes: preview.minutes,
  };
}
