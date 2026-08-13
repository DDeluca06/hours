import { describe, expect, it } from 'vitest';
import type { Entry } from '@hours/core';
import { findDuplicates, lastRealRow } from './write.js';
import type { ExistingRow } from './read.js';

function entry(over: Partial<Entry> = {}): Entry {
  return {
    day: '2026-08-12',
    person: 'Demitri',
    projectKey: 'lp',
    minutes: 105,
    activity: 'Development',
    ranges: [{ startMin: 540, endMin: 645 }],
    status: 'approved',
    ...over,
  };
}

function row(over: Partial<ExistingRow> = {}): ExistingRow {
  return {
    sheetRow: 42,
    dateText: '8/12',
    person: 'Demitri',
    minutes: 105,
    activity: 'Development',
    notes: '9:00 - 10:45',
    ranges: [],
    ...over,
  };
}

describe('findDuplicates', () => {
  it('flags an identical row already in the sheet', () => {
    const dups = findDuplicates([entry()], [row()]);
    expect(dups).toHaveLength(1);
    expect(dups[0]?.message).toContain('row 42');
  });

  it('is quiet when the duration differs', () => {
    expect(findDuplicates([entry({ minutes: 60 })], [row()])).toEqual([]);
  });

  it('is quiet when the activity differs', () => {
    expect(findDuplicates([entry({ activity: 'Testing/QA' })], [row()])).toEqual([]);
  });

  it('is quiet for a different person', () => {
    expect(findDuplicates([entry()], [row({ person: 'Christian' })])).toEqual([]);
  });

  // The sheet holds both "2/26" and "2/26/26"; a duplicate must be caught either way.
  it('matches a date cell that carries a year', () => {
    const dups = findDuplicates([entry({ day: '2026-02-26' })], [
      row({ dateText: '2/26/26', minutes: 105 }),
    ]);
    expect(dups).toHaveLength(1);
  });

  // Casing duplicates (Kristian/kristian, Jamir/jamir) exist in the real sheet.
  it('ignores casing differences in the person column', () => {
    const dups = findDuplicates([entry({ person: 'demitri' })], [row({ person: 'Demitri' })]);
    expect(dups).toHaveLength(1);
  });

  // "8/1" is a prefix of "8/12"; a naive startsWith match would flag an Aug 1
  // push as duplicating an Aug 12 row.
  it('is quiet when the sheet date only shares a prefix', () => {
    expect(findDuplicates([entry({ day: '2026-08-01' })], [row({ dateText: '8/12' })])).toEqual([]);
  });

  // The tab carries rows from earlier years. Dropping the year to make "8/1"
  // stop matching "8/12" must not make 2/26/25 match an entry for 2/26/26.
  it('is quiet when the sheet row is the same day in a different year', () => {
    expect(
      findDuplicates([entry({ day: '2026-02-26' })], [row({ dateText: '2/26/25' })]),
    ).toEqual([]);
  });

  it('matches the same day written the same way', () => {
    const dups = findDuplicates([entry({ day: '2026-08-01' })], [row({ dateText: '8/1' })]);
    expect(dups).toHaveLength(1);
  });

  it('reports the index of each duplicated entry', () => {
    const dups = findDuplicates([entry({ activity: 'Scoping' }), entry()], [row()]);
    expect(dups).toHaveLength(1);
    expect(dups[0]?.entryIndex).toBe(1);
  });
});

describe('lastRealRow', () => {
  it('is the last parsed row', () => {
    expect(lastRealRow([row({ sheetRow: 7 }), row({ sheetRow: 19 }), row({ sheetRow: 12 })], 1)).toBe(19);
  });

  it('falls back to the header row on an empty tab', () => {
    expect(lastRealRow([], 1)).toBe(1);
  });

  // readTab keeps stray cells that carry a date but no person (dropdown
  // leftovers, like the North10AI rows 148-157 case); they must not count as
  // data, so the append lands right below the real rows.
  it('ignores junk below the data (the North10AI rows 148-157 case)', () => {
    expect(
      lastRealRow([row({ sheetRow: 19 }), row({ sheetRow: 148, person: '' })], 1),
    ).toBe(19);
  });
});
