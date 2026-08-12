import { describe, expect, it } from 'vitest';
import { flagBool, flagString, parseArgs, parseDayArg, parseMinutesArg } from './args.js';

describe('parseArgs', () => {
  it('splits command, positionals, and flags', () => {
    const a = parseArgs(['log', '90', 'dev', '--project', 'north10', '--dry-run']);
    expect(a.command).toBe('log');
    expect(a.positionals).toEqual(['90', 'dev']);
    expect(flagString(a.flags, 'project')).toBe('north10');
    expect(flagBool(a.flags, 'dry-run')).toBe(true);
  });

  it('accepts --flag=value', () => {
    const a = parseArgs(['push', '--project=lp']);
    expect(flagString(a.flags, 'project')).toBe('lp');
  });

  it('expands short flags', () => {
    const a = parseArgs(['log', '90', '-p', 'lp', '-a', 'dev', '-d', 'yesterday']);
    expect(flagString(a.flags, 'project')).toBe('lp');
    expect(flagString(a.flags, 'activity')).toBe('dev');
    expect(flagString(a.flags, 'day')).toBe('yesterday');
  });

  // Two boolean flags in a row must not swallow each other as values.
  it('keeps back-to-back booleans boolean', () => {
    const a = parseArgs(['push', '--dry-run', '--allow-duplicates']);
    expect(flagBool(a.flags, 'dry-run')).toBe(true);
    expect(flagBool(a.flags, 'allow-duplicates')).toBe(true);
  });

  it('defaults to help with no argv', () => {
    expect(parseArgs([]).command).toBe('help');
  });
});

describe('parseMinutesArg', () => {
  // Bare numbers are minutes: `hours log 90 dev` must not book 90 hours.
  it('reads a bare number as minutes', () => {
    expect(parseMinutesArg('90')).toBe(90);
    expect(parseMinutesArg('15')).toBe(15);
  });

  it('reads explicit units', () => {
    expect(parseMinutesArg('45m')).toBe(45);
    expect(parseMinutesArg('1.5h')).toBe(90);
    expect(parseMinutesArg('2 hours')).toBe(120);
    expect(parseMinutesArg('1:30')).toBe(90);
  });

  it('returns null for junk', () => {
    expect(parseMinutesArg('a while')).toBeNull();
    expect(parseMinutesArg('')).toBeNull();
  });
});

describe('parseDayArg', () => {
  const now = new Date(2026, 7, 12, 14, 30); // 12 Aug 2026, local

  it('handles the words', () => {
    expect(parseDayArg('today', now)).toBe('2026-08-12');
    expect(parseDayArg('yesterday', now)).toBe('2026-08-11');
    expect(parseDayArg(undefined, now)).toBe('2026-08-12');
  });

  it('handles relative offsets', () => {
    expect(parseDayArg('-3', now)).toBe('2026-08-09');
  });

  it('handles ISO and the sheet’s own m/d format', () => {
    expect(parseDayArg('2026-08-01', now)).toBe('2026-08-01');
    expect(parseDayArg('8/1', now)).toBe('2026-08-01');
    expect(parseDayArg('2/26/26', now)).toBe('2026-02-26');
  });

  // Crossing a month boundary backwards is the case a naive setDate breaks.
  it('crosses a month boundary correctly', () => {
    expect(parseDayArg('-12', new Date(2026, 7, 5))).toBe('2026-07-24');
  });

  it('throws on something unreadable rather than guessing a day', () => {
    expect(() => parseDayArg('last tuesday', now)).toThrow(/cannot read/);
  });
});
