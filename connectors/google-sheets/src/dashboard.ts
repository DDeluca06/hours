// ---------------------------------------------------------------------------
// Live dashboard for the shared Hours spreadsheet's "Totals" tab.
//
// The Totals tab is otherwise empty. This module generates a cell grid for it:
// a KPI band plus per-person / per-category / per-project tables in columns
// A–K, and a normalization "engine" in columns M–R that flattens every
// timesheet tab into uniform rows:
//
//     Project | Date | Person | Category | Period | Hours
//
// The engine is ONE live formula (`=VSTACK(ARRAYFORMULA(HSTACK(…)), …)` — one
// block per source tab) that re-computes whenever any source tab changes. The
// dashboard cells are QUERY / SUMIF formulas over that engine, all filtered by
// the *current* period (``YEAR(TODAY())&"-"&MONTH(TODAY())``), so it always
// shows whatever month it is opened in — no regeneration needed. That matches
// "who has hours logged for whatever the current month is".
//
// Everything below is pure: it builds formula strings and a cell grid. The
// single I/O entry point is `writeDashboard`, confined to one tab title, which
// before writing refuses to clobber a tab that is neither empty nor already
// holding the dashboard, and only ever writes the dashboard's own region.
//
// Text formats this sheet actually uses (verified against the live sheet):
//   - dates: "8/12", "8/5/2026", "2/25/26" — string cells, sometimes yearless
//   - hours: "1:45:00" (h:mm or h:mm:ss) and, on one tab, "1" / "1.5" / "3"
//            (decimal hours); a stray "13:14:59" appears on LP Internal AI
// The engine's Period and Hours columns parse both spellings. A blank Hours
// cell (a real defect on LP rows 122/175) contributes nothing, without error.
// ---------------------------------------------------------------------------

import { colLetter, quoteTab, type TabLayout } from './layout.js';
import { getSheets } from './client.js';

/** A tab to feed into the engine, with its discovered layout. */
export interface DashboardTab {
  /** Exact tab title as it appears in the spreadsheet. */
  title: string;
  layout: TabLayout;
}

/** "A2:A"-style range tail for a tab's column — sized by Sheets to the data. */
function openRange(layout: TabLayout, col: number): string {
  const l = colLetter(col);
  return `${l}2:${l}`;
}

/** A tab's source range for one of the four data columns, tab-qualified. */
export function sourceRange(
  tab: DashboardTab,
  role: keyof Pick<TabLayout, 'dateCol' | 'personCol' | 'hoursCol' | 'activityCol'>,
): string {
  return `${quoteTab(tab.title)}!${openRange(tab.layout, tab.layout[role])}`;
}

/** The engine's Project column: the tab title as a per-row constant string. */
function projectExpr(tab: DashboardTab): string {
  const d = sourceRange(tab, 'dateCol');
  const title = tab.title.replace(/"/g, '""');
  return `IF(ISBLANK(${d}),"","${title}")`;
}

/**
 * The engine's Period column: a "YYYY-M" text key (e.g. "2026-8") per row.
 *
 * Dates are text with yearless ("8/12") and yeared ("8/5/2026", "2/25/26")
 * spellings. A yearless row is attributed to the current year — deliberately
 * generous, the same rule `rowsInMonth` uses for the invoice path, because the
 * sheet's live tabs never carry previous years' rows for the same month. A
 * native date cell (number) is read via YEAR()/MONTH(), so a genuine date
 * typed by hand still lands in the right month.
 */
function periodExpr(tab: DashboardTab): string {
  const d = sourceRange(tab, 'dateCol');
  // REGEXEXTRACT with no year match is #N/A — that must read as "no year",
  // not error-propagate through the IF, so wrap it before the checks.
  const yearRaw = `IFERROR(REGEXEXTRACT(${d},"^[^/]+/[^/]+/(\\d+)$"),"")`;
  const text = `IF(${yearRaw}="",YEAR(TODAY()),IF(LEN(${yearRaw})=2,2000+VALUE(${yearRaw}),VALUE(${yearRaw})))&"-"&VALUE(REGEXEXTRACT(${d},"^\\d+"))`;
  return `IF(ISBLANK(${d}),"",IFERROR(IF(ISNUMBER(${d}),YEAR(${d})&"-"&MONTH(${d}),${text}),""))`;
}

/**
 * The engine's Hours column: decimal hours per row.
 *
 * Two spellings live in the sheet: "1:45:00" (clock) and, on the Elevate215
 * tab, "1" / "1.5" / "3" meaning decimal hours. The decimal test must come
 * first: `VALUE("0:"&"1:45:00")` parses fine, but `VALUE("0:"&"1")` would read
 * a whole hour as one minute. A native duration cell (a number under 1, the
 * fraction of a day) is read as `value*24` so a real duration typed by hand
 * still sums correctly.
 */
function hoursCore(tab: DashboardTab): string {
  const h = sourceRange(tab, 'hoursCol');
  // TIMEVALUE parses "1:45:00" (the sheet's clock spelling) into a day-fraction
  // serial; *24 turns that into hours. The earlier `VALUE("0:"&h)` trick was
  // wrong — "0:1:45:00" is not a TIMEVALUE-parseable string and errored to 0.
  return `IF(ISNUMBER(${h}),${h}*24,IF(REGEXMATCH(${h}&"","^\\d+(\\.\\d+)?$"),VALUE(${h}),IFERROR(TIMEVALUE(${h})*24,0)))`;
}

function hoursExpr(tab: DashboardTab): string {
  const h = sourceRange(tab, 'hoursCol');
  return `IF(ISBLANK(${h}),"",ROUND(${hoursCore(tab)},2))`;
}

/**
 * The engine's Payout column: decimal hours × the dashboard rate, per row.
 *
 * The hours are rounded to 2dp FIRST (matching the Hours column that's
 * displayed next to it), then multiplied — so a row's payout is exactly its
 * displayed hours × rate, and per-row payouts sum to the same cent total as
 * the KPI's round(totalHours×rate). Rounding the raw duration before the
 * price is what keeps $1,396.67-style drift out of the sheet.
 */
function payoutExpr(tab: DashboardTab): string {
  const h = sourceRange(tab, 'hoursCol');
  return `IF(ISBLANK(${h}),"",ROUND(ROUND(${hoursCore(tab)},2)*$B$2,2))`;
}

/**
 * One `ARRAYFORMULA(HSTACK(…))` engine block for a single tab: seven columns,
 * Project | Date | Person | Category | Period | Hours | Payout.
 */
export function tabBlock(tab: DashboardTab): string {
  const d = sourceRange(tab, 'dateCol');
  const p = sourceRange(tab, 'personCol');
  const c = sourceRange(tab, 'activityCol');
  const date = `IF(ISBLANK(${d}),"",${d})`;
  const person = `IF(ISBLANK(${d}),"",IF(ISBLANK(${p}),"",${p}))`;
  const category = `IF(ISBLANK(${d}),"",IF(ISBLANK(${c}),"",${c}))`;
  const cols = [projectExpr(tab), date, person, category, periodExpr(tab), hoursExpr(tab), payoutExpr(tab)];
  return `ARRAYFORMULA(HSTACK(${cols.join(',')}))`;
}

/** The one-cell engine formula: `=VSTACK(… blocks …)` for every source tab. */
export function engineFormula(tabs: readonly DashboardTab[]): string {
  return `=VSTACK(${tabs.map((t) => tabBlock(t)).join(',')})`;
}

/** First column (1-indexed) of the engine zone. */
export const ENGINE_COL = 13; // column M

export const ENGINE_HEADERS = ['Project', 'Date', 'Person', 'Category', 'Period', 'Hours', 'Payout'];

/** The live period key every dashboard filter matches on. One source of truth. */
export function periodKeyExpr(): string {
  return `YEAR(TODAY())&"-"&MONTH(TODAY())`;
}

/**
 * Build the full cell grid for the Totals tab. Purely local — no I/O.
 *
 * Layout: tiles at columns A, E, I (three tables side by side, each with its
 * own Hours/Payout columns so spills never overlap), engine at M–R.
 */
export function buildDashboard(tabs: readonly DashboardTab[], hourlyRate: number): string[][] {
  const cells: string[][] = [];
  const set = (r: number, c: number, v: string): void => {
    const row = cells[r - 1] ?? (cells[r - 1] = []);
    row[c - 1] = v;
  };

  const key = periodKeyExpr();

  // --- titles / meta -------------------------------------------------------
  set(1, 1, 'Hours Dashboard');
  set(2, 1, 'Rate (USD/hr):');
  set(2, 2, String(hourlyRate));
  set(2, 3, 'Month:');
  set(2, 4, '=TEXT(EOMONTH(TODAY(),-1)+1,"MMMM YYYY")');
  set(2, 5, 'as of');
  set(2, 6, '=TEXT(TODAY(),"mmm d, yyyy")');

  // --- note ----------------------------------------------------------------
  set(
    5,
    1,
    'Month in progress — figures update live as rows are added to the source tabs. Blank Hours cells are excluded.',
  );

  // --- KPI band ------------------------------------------------------------
  set(4, 1, 'People with hours');
  set(4, 2, `=COUNTUNIQUE(QUERY('Totals'!$M$2:$S,"select Col3 where Col5='"&${key}&"' and Col3<>'' and Col6>0",0))`);
  set(4, 3, 'Total hours');
  set(4, 4, `=SUMIF('Totals'!$Q:$Q,${key},'Totals'!$R:$R)`);
  set(4, 5, `Est. payout @ $${hourlyRate}/hr`);
  set(4, 6, `=ROUND(SUMIF('Totals'!$Q:$Q,${key},'Totals'!$R:$R)*$B$2,2)`);

  // --- three tiles: person / category / project ----------------------------
  const tiles: { label: string; col: number; query: string }[] = [
    { label: 'Person', col: 1, query: 'Col3' },
    { label: 'Category', col: 5, query: 'Col4' },
    { label: 'Project', col: 9, query: 'Col1' },
  ];

  // One QUERY per tile, returning Name | Hours | Payout; the label clause is
  // the single header row. Payout comes from the engine's per-row amount, so
  // no separate computation column is needed and headers line up cleanly.
  for (const t of tiles) {
    const c = t.col;
    set(
      7,
      c,
      `=QUERY('Totals'!$M$2:$S,"select ${t.query}, sum(Col6), sum(Col7) where Col5='"&${key}&"' and ${t.query}<>'' and Col6>0 group by ${t.query} order by sum(Col6) desc, ${t.query} asc label ${t.query} '${t.label}', sum(Col6) 'Hours', sum(Col7) 'Payout'",0)`,
    );
  }

  // --- engine zone: header row + one stacking formula ----------------------
  ENGINE_HEADERS.forEach((h, i) => set(1, ENGINE_COL + i, h));
  set(2, ENGINE_COL, engineFormula(tabs));

  // Dense-ify: pad every row to the widest used column with ''. Iterate
  // explicitly — `cells` is sparse (rows are only created where a set() lands)
  // and Array#map preserves holes, so spreading mapped lengths would smuggle
  // `undefined` into Math.max and produce NaN, i.e. zero-width rows (a real
  // bug, caught by the scratch-sheet validator).
  const width = Math.max(0, ...cells.flatMap((r) => (r && r.length ? [r.length] : [])));
  const rows: string[][] = [];
  for (let r = 0; r < cells.length; r++) {
    const src = cells[r];
    const out: string[] = [];
    for (let c = 0; c < width; c++) out.push(src?.[c] ?? '');
    rows.push(out);
  }
  return rows;
}

/** Single-quote a tab title for an A1 range reference. */
function q(title: string): string {
  return quoteTab(title);
}

/**
 * Write the dashboard into a tab: values + formulas in one batch, then modest
 * formatting (bold headers, column widths, currency on payout columns).
 *
 * Safety: refuses to overwrite a tab that is neither empty nor already marked
 * as the dashboard, and only ever writes the dashboard region of the given
 * tab. It never touches a timesheet tab.
 */
export async function writeDashboard(
  spreadsheetId: string,
  tabTitle: string,
  tabs: readonly DashboardTab[],
  hourlyRate: number,
): Promise<void> {
  const sheets = getSheets();
  const meta = await sheets.spreadsheets.get({
    spreadsheetId,
    fields: 'sheets.properties.title,sheets.properties.sheetId,sheets.properties.gridProperties',
  });
  const prop = (meta.data.sheets ?? []).find((s) => s.properties?.title === tabTitle);
  if (!prop?.properties) {
    throw new Error(
      `tab "${tabTitle}" not found. Available: ${(meta.data.sheets ?? [])
        .map((s) => s.properties?.title)
        .filter(Boolean)
        .join(', ')}`,
    );
  }

  // Refuse to clobber a tab that already holds someone else's content.
  const probe = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${q(tabTitle)}!A1:C1`,
  });
  const first = (probe.data.values?.[0] ?? [])[0] ?? '';
  const occupied = first.trim() !== '' && first.trim() !== 'Hours Dashboard';
  if (occupied) {
    throw new Error(
      `refusing to write the dashboard to "${tabTitle}" — A1 holds "${first.trim()}" and the tab is not empty, so it is not free real estate.`,
    );
  }

  const grid = buildDashboard(tabs, hourlyRate);
  const range = `${q(tabTitle)}!A1`;
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: grid },
  });

  await formatDashboard(sheets, spreadsheetId, prop.properties.sheetId as number, tabTitle);
}

/** Bold + width + currency formatting for the dashboard region. Batched. */
async function formatDashboard(
  sheets: ReturnType<typeof getSheets>,
  spreadsheetId: string,
  sheetId: number,
  tabTitle: string,
): Promise<void> {
  const bold = (startRow: number, endRow: number, startCol: number, endCol: number) => ({
    repeatCell: {
      range: { sheetId, startRowIndex: startRow - 1, endRowIndex: endRow, startColumnIndex: startCol - 1, endColumnIndex: endCol },
      cell: { userEnteredFormat: { textFormat: { bold: true } } },
      fields: 'userEnteredFormat.textFormat.bold',
    },
  });
  const width = (col: number, pixels: number) => ({
    updateDimensionProperties: {
      range: { sheetId, dimension: 'COLUMNS', startIndex: col - 1, endIndex: col },
      properties: { pixelSize: pixels },
      fields: 'pixelSize',
    },
  });
  const currency = (col: number) => ({
    repeatCell: {
      range: { sheetId, startRowIndex: 6, endRowIndex: 1000, startColumnIndex: col - 1, endColumnIndex: col },
      cell: { userEnteredFormat: { numberFormat: { type: 'CURRENCY', pattern: '"$"#,##0.00' } } },
      fields: 'userEnteredFormat.numberFormat',
    },
  });
  const number = (col: number) => ({
    repeatCell: {
      range: { sheetId, startRowIndex: 6, endRowIndex: 1000, startColumnIndex: col - 1, endColumnIndex: col },
      cell: { userEnteredFormat: { numberFormat: { type: 'NUMBER', pattern: '0.00' } } },
      fields: 'userEnteredFormat.numberFormat',
    },
  });

  const requests = [
    bold(1, 1, 1, 1), // title
    bold(4, 4, 1, 6), // KPI band labels + values
    bold(7, 7, 1, 11), // tile headers (QUERY label rows)
    bold(5, 5, 1, 1), // note
    bold(1, 1, ENGINE_COL, ENGINE_COL + ENGINE_HEADERS.length), // engine header
    width(1, 18),
    width(2, 10),
    width(3, 12),
    width(4, 22),
    width(5, 16),
    width(6, 10),
    width(7, 12),
    width(8, 3),
    width(9, 22),
    width(10, 10),
    width(11, 12),
    number(2),
    number(6),
    number(10),
    currency(3),
    currency(7),
    currency(11),
  ];

  try {
    await sheets.spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests } });
  } catch {
    // Formatting is polish — a failure here must not fail the write.
  }
  void tabTitle;
}
