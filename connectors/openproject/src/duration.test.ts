import { describe, expect, it } from 'vitest';
import { parseIsoDurationToMinutes } from './duration.js';

describe('parseIsoDurationToMinutes', () => {
  it('parses H/M/S components into whole minutes', () => {
    expect(parseIsoDurationToMinutes('PT1H30M')).toBe(90);
    expect(parseIsoDurationToMinutes('PT45M')).toBe(45);
    expect(parseIsoDurationToMinutes('PT1H')).toBe(60);
    expect(parseIsoDurationToMinutes('PT2H15M')).toBe(135);
  });

  it('parses fractional components', () => {
    expect(parseIsoDurationToMinutes('PT1.5H')).toBe(90);
    expect(parseIsoDurationToMinutes('PT0.25H')).toBe(15);
  });

  // Same convention as the sheet durations (CLAUDE.md): round seconds, don't
  // truncate — totals drift low otherwise.
  it('rounds seconds to the nearest minute', () => {
    expect(parseIsoDurationToMinutes('PT1H30M30S')).toBe(91);
    expect(parseIsoDurationToMinutes('PT0M30S')).toBe(1);
    expect(parseIsoDurationToMinutes('PT30S')).toBe(1);
    expect(parseIsoDurationToMinutes('PT0S')).toBe(0);
  });

  it('returns null for null, undefined, and empty input', () => {
    expect(parseIsoDurationToMinutes(null)).toBeNull();
    expect(parseIsoDurationToMinutes(undefined)).toBeNull();
    expect(parseIsoDurationToMinutes('')).toBeNull();
    expect(parseIsoDurationToMinutes('   ')).toBeNull();
  });

  // The parser is deliberately minimal — only the H/M/S time components, so a
  // day-scale duration yields null rather than a wrong number.
  it('returns null for day-scale durations (out of scope)', () => {
    expect(parseIsoDurationToMinutes('P1D')).toBeNull();
    expect(parseIsoDurationToMinutes('P1DT2H')).toBeNull();
  });

  it('returns null for garbage', () => {
    expect(parseIsoDurationToMinutes('banana')).toBeNull();
    expect(parseIsoDurationToMinutes('PT')).toBeNull();
    expect(parseIsoDurationToMinutes('PTXH')).toBeNull();
    expect(parseIsoDurationToMinutes('1H30M')).toBeNull();
    expect(parseIsoDurationToMinutes('PT1H30')).toBeNull();
  });
});
