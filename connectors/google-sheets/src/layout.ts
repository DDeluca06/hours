// ---------------------------------------------------------------------------
// Tab layout discovery.
//
// Every tab in the Hours sheet has the same *idea* of a layout and a different
// *instance* of it: the header may be on row 1 or row 5, the fourth column is
// called "Activity" on some tabs and "Category" on others, some tabs have a
// Notes column and some don't, and every tab has pivot tables parked a few
// columns to the right of the data.
//
// So nothing is hard-coded. We read the top-left corner, find the header row by
// looking for the Date/Person/Hours triple, and record which column each field
// lives in — plus, critically, where the data block *ends* horizontally, so an
// append can never reach into a pivot table.
// ---------------------------------------------------------------------------

const MAX_HEADER_SCAN_ROWS = 12;

export interface TabLayout {
  tabTitle: string;
  /** 1-indexed row of the header. */
  headerRow: number;
  /** 0-indexed column of each field. */
  dateCol: number;
  personCol: number;
  hoursCol: number;
  activityCol: number;
  /** null when the tab has no Notes/description column. */
  notesCol: number | null;
  /** The literal header text of the activity column ("Activity" or "Category"). */
  activityHeader: string;
  /**
   * 0-indexed column, exclusive, where the contiguous data block ends. Appends
   * are confined to columns [0, dataWidth) so pivot tables stay untouched.
   */
  dataWidth: number;
}

function norm(s: string | undefined): string {
  return (s ?? '').trim().toLowerCase();
}

/**
 * Locate the header row and column mapping from the tab's top-left corner.
 *
 * `grid` is the raw FORMATTED_VALUE rows of roughly A1:Z12. Returns null when no
 * header is recognizable — the caller should skip the tab with a warning rather
 * than assume a layout, which is how the existing LP sync behaves.
 */
export function discoverLayout(tabTitle: string, grid: readonly string[][]): TabLayout | null {
  const limit = Math.min(grid.length, MAX_HEADER_SCAN_ROWS);

  for (let r = 0; r < limit; r++) {
    const row = grid[r];
    if (!row) continue;

    const dateCol = row.findIndex((c) => norm(c) === 'date');
    const personCol = row.findIndex((c) => norm(c) === 'person');
    const hoursCol = row.findIndex((c) => /^(hours|hrs|time)$/.test(norm(c)));
    // "Activity" and "Category" are the two spellings in use; both mean the
    // taxonomy column.
    const activityCol = row.findIndex((c) => /^(activity|category)$/.test(norm(c)));

    if (dateCol === -1 || personCol === -1 || hoursCol === -1 || activityCol === -1) continue;

    // Notes must sit immediately right of activity to count. Further right, a
    // header like "Hours" or "SUM of Hours" belongs to a pivot table, and one
    // tab genuinely has "Contract: 533 Hours of Dev" parked there as a label.
    const maybeNotes = activityCol + 1;
    const notesHeader = norm(row[maybeNotes]);
    const notesCol = /^(notes?|description|details|comments?)$/.test(notesHeader)
      ? maybeNotes
      : null;

    const dataWidth = (notesCol ?? activityCol) + 1;

    return {
      tabTitle,
      headerRow: r + 1,
      dateCol,
      personCol,
      hoursCol,
      activityCol,
      notesCol,
      activityHeader: (row[activityCol] ?? 'Activity').trim(),
      dataWidth,
    };
  }

  return null;
}

/** 0-indexed column number → A1 letter ("A", "B", ... "AA"). */
export function colLetter(index: number): string {
  if (index < 0) throw new RangeError(`bad column index: ${index}`);
  let n = index;
  let out = '';
  do {
    out = String.fromCharCode(65 + (n % 26)) + out;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return out;
}

/** Quote a tab title for an A1 range; titles with spaces need single quotes. */
export function quoteTab(title: string): string {
  return `'${title.replace(/'/g, "''")}'`;
}

/**
 * The A1 range an append targets: a single row just past the last real data
 * row, bounded on the right to the data columns.
 *
 * `values.append` with `INSERT_ROWS` appends after the LAST row that has any
 * content within an open-ended range — and several tabs have stray cells
 * parked far below the data (North10AI has 10 of them at rows 148-157), which
 * would drag every push to the bottom of the sheet. Naming the exact insertion
 * row instead makes the API insert there and push the parked cells down.
 */
export function appendRange(layout: TabLayout, lastRealRow: number): string {
  const last = colLetter(layout.dataWidth - 1);
  const row = lastRealRow + 1;
  return `${quoteTab(layout.tabTitle)}!A${row}:${last}${row}`;
}

/** Build the cell array for one row, in the tab's own column order. */
export function buildRowCells(
  layout: TabLayout,
  row: { date: string; person: string; hours: string; activity: string; notes: string },
): string[] {
  const cells = new Array<string>(layout.dataWidth).fill('');
  cells[layout.dateCol] = row.date;
  cells[layout.personCol] = row.person;
  cells[layout.hoursCol] = row.hours;
  cells[layout.activityCol] = row.activity;
  if (layout.notesCol !== null) cells[layout.notesCol] = row.notes;
  return cells;
}
