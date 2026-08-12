import { describe, expect, it } from 'vitest';
import {
  formatClock,
  formatClockRanges,
  formatMinutesAsDuration,
  formatMinutesShort,
  mergeRanges,
  parseClockRanges,
  parseClockToken,
  parseDurationToMinutes,
  totalRangeMinutes,
} from './duration.js';

describe('parseDurationToMinutes', () => {
  it('parses the h:mm:ss the Sheets API returns', () => {
    expect(parseDurationToMinutes('1:45:00')).toBe(105);
    expect(parseDurationToMinutes('0:45:00')).toBe(45);
    expect(parseDurationToMinutes('13:15:00')).toBe(795);
  });

  // The sheet contains 13:14:59 where the pivot displays 13:15:00 — truncating
  // would silently under-report every such total.
  it('rounds stray seconds to the nearest minute instead of truncating', () => {
    expect(parseDurationToMinutes('13:14:59')).toBe(795);
  });

  it('accepts decimal hours and bare h:mm', () => {
    expect(parseDurationToMinutes('1.75')).toBe(105);
    expect(parseDurationToMinutes('2h')).toBe(120);
    expect(parseDurationToMinutes('1:30')).toBe(90);
  });

  it('returns null for junk rather than guessing', () => {
    expect(parseDurationToMinutes('')).toBeNull();
    expect(parseDurationToMinutes(undefined)).toBeNull();
    expect(parseDurationToMinutes('all morning')).toBeNull();
    expect(parseDurationToMinutes('1:75:00')).toBeNull();
  });
});

describe('formatMinutesAsDuration', () => {
  it('round-trips through parseDurationToMinutes', () => {
    for (const m of [15, 45, 105, 360, 795]) {
      expect(parseDurationToMinutes(formatMinutesAsDuration(m))).toBe(m);
    }
  });

  it('rejects negatives', () => {
    expect(() => formatMinutesAsDuration(-1)).toThrow(RangeError);
  });
});

describe('formatMinutesShort', () => {
  it('reads like a human wrote it', () => {
    expect(formatMinutesShort(45)).toBe('45m');
    expect(formatMinutesShort(120)).toBe('2h');
    expect(formatMinutesShort(105)).toBe('1h 45m');
  });
});

describe('parseClockToken', () => {
  // A 9-to-3 day makes bare "2" unambiguous in practice: nobody logs 2 AM.
  it('reads bare afternoon hours as PM', () => {
    expect(parseClockToken('2')).toBe(14 * 60);
    expect(parseClockToken('1:30')).toBe(13 * 60 + 30);
  });

  it('leaves morning hours alone', () => {
    expect(parseClockToken('9')).toBe(9 * 60);
    expect(parseClockToken('10:45')).toBe(10 * 60 + 45);
  });

  it('honours an explicit meridiem', () => {
    expect(parseClockToken('2:30 PM')).toBe(14 * 60 + 30);
    expect(parseClockToken('9am')).toBe(9 * 60);
    expect(parseClockToken('12am')).toBe(0);
  });
});

describe('parseClockRanges', () => {
  it('parses the Notes formats present in the sheet', () => {
    expect(parseClockRanges('9:00 - 10:45')).toEqual([{ startMin: 540, endMin: 645 }]);
    expect(parseClockRanges('2:30-3:30')).toEqual([{ startMin: 870, endMin: 930 }]);
    expect(parseClockRanges('2:30 PM - 3:30 PM')).toEqual([{ startMin: 870, endMin: 930 }]);
    expect(parseClockRanges('2:30PM - 3:30PM')).toEqual([{ startMin: 870, endMin: 930 }]);
  });

  it('parses multiple ranges in one cell', () => {
    expect(parseClockRanges('2-2:30, 3:30-3:45')).toEqual([
      { startMin: 840, endMin: 870 },
      { startMin: 930, endMin: 945 },
    ]);
  });

  it('ignores the free text after a pipe', () => {
    expect(parseClockRanges('1:30 - 3:15 | Stand-up')).toEqual([{ startMin: 810, endMin: 915 }]);
  });

  it('spans noon when the end reads earlier than the start', () => {
    expect(parseClockRanges('11 - 1')).toEqual([{ startMin: 660, endMin: 780 }]);
  });

  it('returns nothing for a cell that is only a description', () => {
    expect(parseClockRanges('Stand-up and code review')).toEqual([]);
    expect(parseClockRanges(undefined)).toEqual([]);
  });
});

describe('range arithmetic', () => {
  it('merges overlaps so time is not double-counted', () => {
    expect(
      mergeRanges([
        { startMin: 540, endMin: 600 },
        { startMin: 580, endMin: 660 },
      ]),
    ).toEqual([{ startMin: 540, endMin: 660 }]);
    expect(totalRangeMinutes([
      { startMin: 540, endMin: 600 },
      { startMin: 580, endMin: 660 },
    ])).toBe(120);
  });

  it('formats ranges back into the sheet convention', () => {
    expect(formatClockRanges([{ startMin: 540, endMin: 645 }])).toBe('9:00 - 10:45');
    expect(formatClock(14 * 60 + 45)).toBe('14:45');
  });
});
