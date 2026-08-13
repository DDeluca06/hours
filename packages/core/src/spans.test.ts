// Measured spans: what changes when a harness tells us how long a turn took,
// and — more importantly — what must not change. The apportionment invariant
// (inferred time never exceeds wall-clock time) has to survive signals that
// carry their own duration, so it is re-asserted here against spans rather than
// trusted from overlaps.test.ts.

import { describe, expect, it } from 'vitest';
import { inferBlocks, isMeasured, signalWeight, type Signal } from './blocks.js';
import { DEFAULT_WORKDAY } from './workday.js';

const DAY = [2026, 7, 12] as const;

function at(time: string): Date {
  const [h, m] = time.split(':').map(Number);
  return new Date(DAY[0], DAY[1], DAY[2], h ?? 0, m ?? 0, 0);
}

/** A measured turn: prompt at `start`, harness still working until `end`. */
function span(start: string, end: string, over: Partial<Signal> = {}): Signal {
  return {
    sourceId: over.sourceId ?? `span:${start}`,
    kind: over.kind ?? 'claude_session',
    at: at(start),
    until: at(end),
    projectKey: over.projectKey ?? 'north10',
    ...(over.subject !== undefined ? { subject: over.subject } : {}),
    ...(over.paths !== undefined ? { paths: over.paths } : {}),
  };
}

function point(time: string, over: Partial<Signal> = {}): Signal {
  return {
    sourceId: over.sourceId ?? `point:${time}`,
    kind: over.kind ?? 'git_commit',
    at: at(time),
    projectKey: over.projectKey ?? 'north10',
    ...(over.subject !== undefined ? { subject: over.subject } : {}),
  };
}

describe('isMeasured', () => {
  it('needs an end strictly after the start', () => {
    expect(isMeasured(point('10:00'))).toBe(false);
    expect(isMeasured({ at: at('10:00'), until: at('10:00') })).toBe(false);
    expect(isMeasured({ at: at('10:00'), until: at('10:01') })).toBe(true);
  });
});

describe('signalWeight', () => {
  it('lifts a measured session turn above a bare heartbeat', () => {
    expect(signalWeight(point('10:00', { kind: 'claude_session' }))).toBe(1);
    expect(signalWeight(span('10:00', '10:30'))).toBe(2);
  });

  it('never lowers a strong signal just because it has no span', () => {
    expect(signalWeight(point('10:00', { kind: 'git_commit' }))).toBe(4);
    expect(signalWeight(span('10:00', '10:30', { kind: 'git_commit' }))).toBe(4);
  });
});

describe('inferBlocks with measured spans', () => {
  it('uses the measured start instead of guessing a lead-in', () => {
    // A single 45-minute autonomous run. The lead-in would have put the start at
    // 9:40 — 20 minutes of invented work before a prompt that is timestamped.
    const blocks = inferBlocks([span('10:00', '10:45')]);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.startMin).toBe(10 * 60);
    expect(blocks[0]?.endMin).toBe(10 * 60 + 45);
  });

  it('still applies the lead-in when the run opens with a trailing edge', () => {
    // 10:00 minus the 20-minute lead-in is 9:40, which rounds to the 9:45 slot.
    const blocks = inferBlocks([point('10:00', { kind: 'git_commit' })]);
    expect(blocks[0]?.startMin).toBe(9 * 60 + 45);
  });

  it('reports a long turn as its real length, not one rounding granule', () => {
    // The whole point of the feature: before spans, one prompt at 10:00 with no
    // further prompts inferred a flat 20-minute lead-in no matter how long the
    // agent actually ran.
    const measured = inferBlocks([span('10:00', '11:30')]);
    const guessed = inferBlocks([point('10:00', { kind: 'claude_session' })]);
    expect(measured[0]?.minutes).toBe(90);
    expect(guessed[0]?.minutes).toBeLessThanOrEqual(30);
  });

  it('measures the idle gap from a span end, so a turn and its commit stay one block', () => {
    // Turn runs 10:00–10:40, commit lands at 10:50. Measured from the turn's
    // start that is a 50-minute gap and the block would split; from its end it is
    // ten minutes of the same stretch of work.
    const blocks = inferBlocks([span('10:00', '10:40'), point('10:50')]);
    expect(blocks).toHaveLength(1);
    // 10:50 rounds to the 10:45 slot — the point is that it is one block, not two.
    expect(blocks[0]?.endMin).toBe(10 * 60 + 45);
  });

  it('ends the block at the latest span end, not the latest span start', () => {
    // The second signal starts later but finishes first.
    const blocks = inferBlocks([span('10:00', '11:00'), span('10:10', '10:20')]);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.endMin).toBe(11 * 60);
  });

  it('clips a span that crosses midnight instead of wrapping it', () => {
    // 23:30 → 00:30 next day. Wrapping would put endMin at 30, before startMin,
    // and the block would vanish. The minutes after midnight belong to the next
    // day's inference pass.
    const overnight: Signal = {
      sourceId: 'span:overnight',
      kind: 'claude_session',
      at: new Date(DAY[0], DAY[1], DAY[2], 23, 30, 0),
      until: new Date(DAY[0], DAY[1], DAY[2] + 1, 0, 30, 0),
      projectKey: 'north10',
    };
    const blocks = inferBlocks([overnight], { allowOutsideWorkday: true });
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.startMin).toBe(23 * 60 + 30);
    expect(blocks[0]?.endMin).toBeGreaterThan(23 * 60 + 30);
    expect(blocks[0]?.endMin).toBeLessThanOrEqual(24 * 60);
  });

  it('says in the reason that the time was measured', () => {
    const blocks = inferBlocks([span('10:00', '10:45')]);
    expect(blocks[0]?.reason).toContain('measured harness span');
    expect(blocks[0]?.reason).toContain('no lead-in guess');
  });

  it('keeps inferred time inside the wall clock when spans overlap', () => {
    // Two harnesses running against the same project at the same time — a Claude
    // Code turn and an OpenCode turn, each claiming the same hour. A person does
    // one thing at a time, so the total must be the union, not the sum.
    const blocks = inferBlocks([
      span('10:00', '11:00', { sourceId: 'a', subject: 'fix: retry the push' }),
      span('10:00', '11:00', {
        sourceId: 'b',
        kind: 'opencode_session',
        subject: 'docs: write up the sheet layout',
      }),
    ]);
    const total = blocks.reduce((sum, b) => sum + b.minutes, 0);
    expect(total).toBeLessThanOrEqual(60);
  });

  it('does not let a span cross the workday clamp', () => {
    // A turn that runs past 3 PM is clipped, same as any other block, unless the
    // operator asked to keep outside-hours work.
    const clamped = inferBlocks([span('14:30', '16:30')]);
    expect(clamped[0]?.endMin).toBe(DEFAULT_WORKDAY.endMin);
    const kept = inferBlocks([span('14:30', '16:30')], { allowOutsideWorkday: true });
    expect(kept[0]?.endMin).toBe(16 * 60 + 30);
  });
});
