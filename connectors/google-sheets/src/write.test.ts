import { describe, expect, it } from 'vitest';
import type { Entry } from '@hours/core';
import { findDuplicates } from './write.js';
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

  it('reports the index of each duplicated entry', () => {
    const dups = findDuplicates([entry({ activity: 'Scoping' }), entry()], [row()]);
    expect(dups).toHaveLength(1);
    expect(dups[0]?.entryIndex).toBe(1);
  });
});
