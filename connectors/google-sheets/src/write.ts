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
import { minutesFor, readTab, type ExistingRow } from './read.js';

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
    const hit = existing.find(
      (r) =>
        r.person.toLowerCase() === e.person.toLowerCase() &&
        r.dateText.startsWith(row.date) &&
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
  /** Report what would be sent without touching the sheet. */
  dryRun?: boolean;
  /** Append even when a matching row already exists. */
  allowDuplicates?: boolean;
}

export interface PushPreview {
  layout: TabLayout;
  cells: string[][];
  duplicates: DuplicateWarning[];
  /** Minutes this person already has on the affected days. */
  existingByDay: Map<string, number>;
  minutes: number;
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

  const { layout, rows } = await readTab(opts.spreadsheetId, opts.tabTitle);
  const cells = opts.entries.map((e) => buildRowCells(layout, toSheetRow(e)));
  const duplicates = findDuplicates(opts.entries, rows);

  const existingByDay = new Map<string, number>();
  for (const e of opts.entries) {
    const date = toSheetRow(e).date;
    if (!existingByDay.has(date)) {
      existingByDay.set(date, minutesFor(rows, e.person, date));
    }
  }

  return {
    layout,
    cells,
    duplicates,
    existingByDay,
    minutes: opts.entries.reduce((s, e) => s + e.minutes, 0),
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
  const preview = await previewPush(opts);

  if (preview.duplicates.length > 0 && !opts.allowDuplicates) {
    throw new Error(
      `refusing to push — the sheet already has matching rows:\n  ${preview.duplicates
        .map((d) => d.message)
        .join('\n  ')}\nRe-run with --allow-duplicates if these are genuinely separate.`,
    );
  }

  const range = appendRange(preview.layout);

  if (opts.dryRun) {
    return { updatedRange: `${range} (dry run — nothing written)`, rowCount: 0, minutes: 0 };
  }

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
