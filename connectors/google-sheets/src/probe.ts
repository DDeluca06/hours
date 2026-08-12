// ---------------------------------------------------------------------------
// `pnpm sheets:probe` — the first thing to run once credentials exist.
//
// Prints every tab, which ones parse as timesheet tabs, the exact column layout
// discovered for each, and the totals. This is how you confirm the real tab
// titles and column variants instead of trusting the assumptions baked into the
// project registry.
// ---------------------------------------------------------------------------

import { loadConfig, requirePushConfig } from '@hours/config';
import { ACTIVITIES, formatMinutesShort } from '@hours/core';
import { getRows, listTabTitles } from './client.js';
import { discoverLayout, quoteTab } from './layout.js';
import { readTab, summarize } from './read.js';

async function main(): Promise<void> {
  const cfg = loadConfig();
  const { sheetId } = requirePushConfig(cfg);

  const titles = await listTabTitles(sheetId);
  console.log(`${titles.length} tabs in the spreadsheet:\n`);

  const configured = new Set(cfg.projects.map((p) => p.sheetTab));

  for (const title of titles) {
    const grid = await getRows(sheetId, `${quoteTab(title)}!A1:Z12`);
    const layout = discoverLayout(title, grid);
    const mark = configured.has(title) ? '★' : ' ';

    if (!layout) {
      console.log(`${mark} ${title} — not a timesheet tab (no Date/Person/Hours header)`);
      continue;
    }

    console.log(
      `${mark} ${title} — header row ${layout.headerRow}, "${layout.activityHeader}" column, ` +
        `notes ${layout.notesCol === null ? 'absent' : `col ${layout.notesCol}`}, ` +
        `data width ${layout.dataWidth}`,
    );

    const { rows } = await readTab(sheetId, title);
    const totals = summarize(rows);
    console.log(
      `    ${rows.length} rows, ${formatMinutesShort(totals.totalMinutes)} total, ` +
        `${totals.byPerson.size} people, ${totals.byActivity.size} activities`,
    );
    if (totals.unparsedRows.length) {
      console.log(`    ⚠ unparsable Hours in rows: ${totals.unparsedRows.join(', ')}`);
    }
    const unknown = [...totals.byActivity.keys()].filter((a) => a && !isKnown(a));
    if (unknown.length) {
      console.log(`    ⚠ activities outside the taxonomy: ${unknown.join(', ')}`);
    }
  }

  console.log('\n★ = configured in the project registry');
}

function isKnown(activity: string): boolean {
  return (ACTIVITIES as readonly string[]).some((a) => a.toLowerCase() === activity.toLowerCase());
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
