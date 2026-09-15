import { describe, it, expect } from 'vitest';
import { rowsInMonth, sameSheetDate, sheetDateWithYear } from './read.js';

const row = (dateText: string) => ({ dateText });

describe('rowsInMonth', () => {
  it('keeps the requested month and drops the others', () => {
    const { rows } = rowsInMonth(
      [row('8/3/2026'), row('7/31/2026'), row('9/1/2026'), row('8/19/2026')],
      '2026-08',
    );
    expect(rows.map((r) => r.dateText)).toEqual(['8/3/2026', '8/19/2026']);
  });

  it('drops a matching month in the wrong year', () => {
    const { rows } = rowsInMonth([row('8/3/2025'), row('8/3/26'), row('8/3/2026')], '2026-08');
    expect(rows.map((r) => r.dateText)).toEqual(['8/3/26', '8/3/2026']);
  });

  // The North10AI tab writes bare M/D. Dropping those would empty that tab out
  // of every invoice, so they are kept and counted instead.
  it('keeps undated-year rows and reports how many it took on faith', () => {
    const { rows, undatedYear } = rowsInMonth([row('8/12'), row('8/14'), row('7/9')], '2026-08');
    expect(rows.map((r) => r.dateText)).toEqual(['8/12', '8/14']);
    expect(undatedYear).toBe(2);
  });

  it('ignores rows whose Date cell is not a date at all', () => {
    const { rows, undatedYear } = rowsInMonth([row(''), row('Total'), row('8/1')], '2026-08');
    expect(rows.map((r) => r.dateText)).toEqual(['8/1']);
    expect(undatedYear).toBe(1);
  });

  it('accepts a zero-padded month cell', () => {
    const { rows } = rowsInMonth([row('08/03/2026')], '2026-08');
    expect(rows).toHaveLength(1);
  });

  it('rejects a period that is not YYYY-MM', () => {
    expect(() => rowsInMonth([], '2026-8')).toThrow(/YYYY-MM/);
    expect(() => rowsInMonth([], 'august')).toThrow(/YYYY-MM/);
  });
});

// Pinned alongside the month filter because they share parseSheetDate: a change
// to the two-digit-year expansion has to keep both honest.
describe('sameSheetDate', () => {
  it('matches across the tabs’ two date formats', () => {
    expect(sameSheetDate('8/12', '8/12/2026')).toBe(true);
    expect(sameSheetDate('8/12/26', '8/12/2026')).toBe(true);
    expect(sameSheetDate('8/12/25', '8/12/2026')).toBe(false);
    expect(sameSheetDate('8/12', '8/13')).toBe(false);
  });
});

describe('sheetDateWithYear', () => {
  it('renders an entry day as a year-carrying sheet date', () => {
    expect(sheetDateWithYear('2026-08-03')).toBe('8/3/2026');
  });
});
