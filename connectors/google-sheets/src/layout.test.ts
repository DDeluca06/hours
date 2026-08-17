import { describe, expect, it } from 'vitest';
import { appendRange, buildRowCells, colLetter, discoverLayout, quoteTab } from './layout.js';

// These grids mirror the real variants observed across the sheet's tabs.
const withNotes = [
  [],
  ['', '', ''],
  ['Date', 'Person', 'Hours', 'Activity', 'Notes'],
  ['7/31', 'Christian', '1:00:00', 'Client Meeting', '2:30-3:30'],
];

const categoryNoNotes = [
  ['Date', 'Person', 'Hours', 'Category'],
  ['8/4', 'Demitri', '1:45:00', 'Development'],
];

// One tab parks a contract label immediately right of Category, and every tab
// has pivot headers a few columns over.
const withPivots = [
  [
    'Date',
    'Person',
    'Hours',
    'Category',
    'Contract: 533 Hours of Dev',
    '',
    'SUM of Hours',
    'Category',
  ],
];

describe('discoverLayout', () => {
  it('finds a header that is not on row 1', () => {
    const l = discoverLayout('North10AI', withNotes);
    expect(l).not.toBeNull();
    expect(l?.headerRow).toBe(3);
    expect(l?.notesCol).toBe(4);
    expect(l?.dataWidth).toBe(5);
  });

  it('accepts Category as the activity column', () => {
    const l = discoverLayout('LP Internal AI', categoryNoNotes);
    expect(l?.activityHeader).toBe('Category');
    expect(l?.activityCol).toBe(3);
    expect(l?.notesCol).toBeNull();
    expect(l?.dataWidth).toBe(4);
  });

  // Appending into a pivot table would corrupt live formulas the team reads.
  it('never counts a pivot table or contract label as the data block', () => {
    const l = discoverLayout('Some Tab', withPivots);
    expect(l?.notesCol).toBeNull();
    expect(l?.dataWidth).toBe(4);
    expect(appendRange(l!, 0)).toBe("'Some Tab'!A1:D1");
  });

  // Stray cells parked far below the data (North10AI has 10 at rows 148-157)
  // must not drag the append to the bottom of the sheet.
  it('targets the row just past the last real data row, not the sheet bottom', () => {
    const l = discoverLayout('North10AI', [['Date', 'Person', 'Hours', 'Activity', 'Notes']]);
    expect(appendRange(l!, 19)).toBe("'North10AI'!A20:E20");
  });

  it('returns null for a tab with no recognizable header', () => {
    expect(discoverLayout('Summary', [['Totals', 'by', 'month']])).toBeNull();
    expect(discoverLayout('Empty', [])).toBeNull();
  });

  it('requires the full Date/Person/Hours/Activity set', () => {
    expect(discoverLayout('Partial', [['Date', 'Person', 'Hours']])).toBeNull();
  });
});

describe('colLetter', () => {
  it('handles single and double letters', () => {
    expect(colLetter(0)).toBe('A');
    expect(colLetter(4)).toBe('E');
    expect(colLetter(25)).toBe('Z');
    expect(colLetter(26)).toBe('AA');
    expect(colLetter(27)).toBe('AB');
  });

  it('rejects a negative index', () => {
    expect(() => colLetter(-1)).toThrow(RangeError);
  });
});

describe('quoteTab', () => {
  it('quotes titles so spaces survive an A1 range', () => {
    expect(quoteTab('LP Internal AI')).toBe("'LP Internal AI'");
  });

  it('escapes an apostrophe in a title', () => {
    expect(quoteTab("Bob's Tab")).toBe("'Bob''s Tab'");
  });
});

describe('buildRowCells', () => {
  const row = {
    date: '8/12',
    person: 'Demitri',
    hours: '1:45:00',
    activity: 'Development',
    notes: '9:00 AM - 10:45 AM',
  };

  it('places cells in the tab’s own column order', () => {
    const l = discoverLayout('North10AI', withNotes)!;
    expect(buildRowCells(l, row)).toEqual([
      '8/12',
      'Demitri',
      '1:45:00',
      'Development',
      '9:00 AM - 10:45 AM',
    ]);
  });

  it('drops the notes when the tab has no notes column', () => {
    const l = discoverLayout('LP Internal AI', categoryNoNotes)!;
    const cells = buildRowCells(l, row);
    expect(cells).toHaveLength(4);
    expect(cells).not.toContain('9:00 AM - 10:45 AM');
  });
});
