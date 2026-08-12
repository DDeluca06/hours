// ---------------------------------------------------------------------------
// The over-reporting guard.
//
// These tests exist because the first real run of the inference against actual
// git history billed one minute of pushing as 1h30m: six commits landed at
// 15:02, each became a 15-minute block, and all six claimed 14:45–15:00. The
// invariant that has to hold is simple and absolute — inferred time can never
// exceed the wall-clock window the evidence covers.
// ---------------------------------------------------------------------------

import { describe, expect, it } from 'vitest';
import {
  clipAgainst,
  inferBlocks,
  resolveOverlaps,
  type InferredBlock,
  type Signal,
} from './blocks.js';
import { mergeRanges } from './duration.js';
import { DEFAULT_WORKDAY } from './workday.js';

function block(over: Partial<InferredBlock> = {}): InferredBlock {
  const startMin = over.startMin ?? 540;
  const endMin = over.endMin ?? 555;
  return {
    projectKey: 'north10',
    activity: 'Development',
    confidence: 0.6,
    reason: 'test',
    signalIds: ['a'],
    subjects: [],
    weight: over.weight ?? (over.signalIds ?? ['a']).length * 4,
    ...over,
    // Derived last: minutes must always agree with the range, whatever the
    // override passed.
    startMin,
    endMin,
    minutes: endMin - startMin,
  };
}

function totalMinutes(blocks: readonly InferredBlock[]): number {
  return blocks.reduce((s, b) => s + b.minutes, 0);
}

function spanMinutes(blocks: readonly InferredBlock[]): number {
  return mergeRanges(blocks.map((b) => ({ startMin: b.startMin, endMin: b.endMin }))).reduce(
    (s, r) => s + (r.endMin - r.startMin),
    0,
  );
}

/** Build a signal at a wall-clock time on 2026-08-12. */
function sig(time: string, over: Partial<Signal> = {}): Signal {
  const [h, m] = time.split(':').map(Number);
  return {
    sourceId: over.sourceId ?? `s:${time}:${over.subject ?? ''}`,
    kind: 'git_commit',
    at: new Date(2026, 7, 12, h ?? 0, m ?? 0),
    projectKey: over.projectKey ?? 'north10',
    ...(over.subject !== undefined ? { subject: over.subject } : {}),
    ...(over.paths !== undefined ? { paths: over.paths } : {}),
  };
}

describe('resolveOverlaps', () => {
  it('leaves a non-overlapping set alone', () => {
    const blocks = [
      block({ startMin: 540, endMin: 600 }),
      block({ startMin: 660, endMin: 720, activity: 'Testing/QA' }),
    ];
    expect(resolveOverlaps(blocks)).toHaveLength(2);
    expect(totalMinutes(resolveOverlaps(blocks))).toBe(120);
  });

  it('never reports more time than the window it covers', () => {
    // The exact shape of the real bug: many activities, one 15-minute window.
    const activities = [
      'Development',
      'Documentation',
      'Misc',
      'Deployment',
      'Testing/QA',
      'Scoping',
    ] as const;
    const blocks = activities.map((activity, i) =>
      block({ startMin: 885, endMin: 900, activity, signalIds: [`sig-${i}`] }),
    );

    const resolved = resolveOverlaps(blocks);
    expect(totalMinutes(resolved)).toBe(15);
    expect(totalMinutes(resolved)).toBeLessThanOrEqual(spanMinutes(blocks));
  });

  it('splits a long shared window proportionally to the evidence', () => {
    const blocks = [
      block({ startMin: 540, endMin: 660, activity: 'Development', signalIds: ['a', 'b', 'c'] }),
      block({ startMin: 560, endMin: 660, activity: 'Documentation', signalIds: ['d'] }),
    ];
    const resolved = resolveOverlaps(blocks);

    expect(totalMinutes(resolved)).toBeLessThanOrEqual(120);
    const dev = resolved.find((b) => b.activity === 'Development');
    const docs = resolved.find((b) => b.activity === 'Documentation');
    // Three commits of evidence should outweigh one.
    expect(dev?.minutes ?? 0).toBeGreaterThan(docs?.minutes ?? 0);
  });

  it('produces blocks that no longer overlap each other', () => {
    const blocks = [
      block({ startMin: 540, endMin: 660, activity: 'Development' }),
      block({ startMin: 550, endMin: 640, activity: 'Testing/QA' }),
      block({ startMin: 560, endMin: 620, activity: 'Documentation' }),
    ];
    const resolved = resolveOverlaps(blocks).sort((a, b) => a.startMin - b.startMin);
    for (let i = 1; i < resolved.length; i++) {
      expect(resolved[i]!.startMin).toBeGreaterThanOrEqual(resolved[i - 1]!.endMin);
    }
  });

  // A dropped activity's signals would otherwise stay unconsumed and be
  // re-inferred on the next run, logging the same window a second time.
  it('keeps every signal id, including from activities it had to drop', () => {
    const blocks = [
      block({ startMin: 885, endMin: 900, activity: 'Development', signalIds: ['a'] }),
      block({ startMin: 885, endMin: 900, activity: 'Documentation', signalIds: ['b'] }),
      block({ startMin: 885, endMin: 900, activity: 'Deployment', signalIds: ['c'] }),
    ];
    const resolved = resolveOverlaps(blocks);
    const ids = new Set(resolved.flatMap((b) => b.signalIds));
    expect(ids).toEqual(new Set(['a', 'b', 'c']));
  });

  it('says in the reason when it had to drop activities', () => {
    const blocks = [
      block({ startMin: 885, endMin: 900, activity: 'Development', signalIds: ['a', 'b'] }),
      block({ startMin: 885, endMin: 900, activity: 'Wireframes', signalIds: ['c'] }),
    ];
    const resolved = resolveOverlaps(blocks);
    expect(resolved.some((b) => /dropped/.test(b.reason))).toBe(true);
  });

  it('apportions across projects rather than double-counting the window', () => {
    const blocks = [
      block({ startMin: 540, endMin: 600, projectKey: 'north10' }),
      block({ startMin: 540, endMin: 600, projectKey: 'lp' }),
    ];
    expect(totalMinutes(resolveOverlaps(blocks))).toBe(60);
  });
});

describe('clipAgainst', () => {
  it('removes time already claimed', () => {
    const clipped = clipAgainst(
      [block({ startMin: 540, endMin: 660, projectKey: null })],
      [block({ startMin: 570, endMin: 600 })],
    );
    expect(clipped.map((c) => [c.startMin, c.endMin])).toEqual([
      [540, 570],
      [600, 660],
    ]);
  });

  it('drops a remainder too small to be a block', () => {
    const clipped = clipAgainst(
      [block({ startMin: 540, endMin: 600, projectKey: null })],
      [block({ startMin: 550, endMin: 600 })],
    );
    expect(clipped).toEqual([]);
  });

  it('leaves a block alone when nothing overlaps it', () => {
    const clipped = clipAgainst(
      [block({ startMin: 540, endMin: 600, projectKey: null })],
      [block({ startMin: 700, endMin: 760 })],
    );
    expect(clipped).toHaveLength(1);
  });
});

describe('evidence weighting', () => {
  // Before weighting, a long session in an unwatched directory (hundreds of
  // turns) outvoted a real commit and squeezed the project's work to 15 minutes,
  // then vanished because unattributed blocks are discarded.
  it('does not let unattributed session time squeeze a real project block', () => {
    const signals: Signal[] = [];
    // 2.5 hours of session turns in an unwatched directory.
    for (let m = 0; m < 150; m += 10) {
      signals.push({
        sourceId: `sess-${m}`,
        kind: 'claude_session',
        at: new Date(2026, 7, 4, 11, m % 60 + (m >= 60 ? 0 : 0)),
        projectKey: null,
        subject: 'where are we on this project',
      });
    }
    // One real commit in a watched repo, inside that same window.
    signals.push({
      sourceId: 'commit-1',
      kind: 'git_commit',
      at: new Date(2026, 7, 4, 12, 30),
      projectKey: 'north10',
      subject: 'feat: extract org identity',
      paths: ['src/identity.ts'],
    });

    const blocks = inferBlocks(signals);
    const north = blocks.filter((b) => b.projectKey === 'north10');
    expect(north).toHaveLength(1);
    // It keeps its own window rather than being cut to a single granule.
    expect(north[0]?.minutes).toBeGreaterThanOrEqual(15);

    // And nothing unattributed overlaps what the project already claimed.
    const claimed = north.map((b) => ({ startMin: b.startMin, endMin: b.endMin }));
    for (const b of blocks.filter((x) => x.projectKey === null)) {
      for (const c of claimed) {
        expect(b.startMin >= c.endMin || b.endMin <= c.startMin).toBe(true);
      }
    }
  });

  it('weights a commit above a session turn when a window is shared', () => {
    const blocks = [
      block({ startMin: 540, endMin: 600, activity: 'Development', weight: 4 }),
      block({ startMin: 540, endMin: 600, activity: 'Documentation', weight: 1 }),
    ];
    const resolved = resolveOverlaps(blocks);
    const dev = resolved.find((b) => b.activity === 'Development');
    const docs = resolved.find((b) => b.activity === 'Documentation');
    expect(dev?.minutes ?? 0).toBeGreaterThan(docs?.minutes ?? 0);
  });
});

describe('inferBlocks over-reporting guard', () => {
  it('does not turn one push of six commits into an hour and a half', () => {
    // Six commits within the same minute, each classified differently — the
    // exact NorthAI history that surfaced the bug.
    const signals = [
      sig('15:02', { subject: 'chore: drop the dead block', sourceId: '1' }),
      sig('15:02', { subject: 'docs: file the source material', sourceId: '2' }),
      sig('15:02', { subject: 'feat: question matcher', sourceId: '3', paths: ['src/m.ts'] }),
      sig('15:02', { subject: 'feat: wire the matcher', sourceId: '4', paths: ['src/w.ts'] }),
      sig('15:02', { subject: "docs: correct the matcher's status", sourceId: '5' }),
      sig('15:02', { subject: 'ci: branch protection', sourceId: '6' }),
    ];

    const blocks = inferBlocks(signals, { allowOutsideWorkday: true });
    const total = totalMinutes(blocks);

    // The evidence covers one instant plus a 20-minute lead-in; anything much
    // over that is fabricated time.
    expect(total).toBeLessThanOrEqual(DEFAULT_WORKDAY.roundToMin * 2);
    expect(total).toBeLessThanOrEqual(spanMinutes(blocks));
  });

  // Four commits spread across the day are four isolated points, so the lead-in
  // is all the evidence there is: 4 × 15m. This documents that sparse commits
  // *under*-report by design — filling that gap is what session signals are for,
  // and what the review step is for.
  it('under-reports a sparsely committed day rather than inventing time', () => {
    const signals = [
      sig('9:15', { subject: 'feat: a', sourceId: 'a', paths: ['src/a.ts'] }),
      sig('10:30', { subject: 'feat: b', sourceId: 'b', paths: ['src/b.ts'] }),
      sig('13:00', { subject: 'test: c', sourceId: 'c', paths: ['src/c.test.ts'] }),
      sig('14:30', { subject: 'test: d', sourceId: 'd', paths: ['src/d.test.ts'] }),
    ];
    const blocks = inferBlocks(signals);
    expect(blocks).toHaveLength(4);
    expect(totalMinutes(blocks)).toBe(60);
  });

  it('grows a block when session signals fill the gaps between commits', () => {
    const signals = [
      sig('9:15', { subject: 'feat: a', sourceId: 'a', paths: ['src/a.ts'] }),
      { ...sig('9:35', { sourceId: 'h1' }), kind: 'claude_session' as const },
      { ...sig('9:55', { sourceId: 'h2' }), kind: 'claude_session' as const },
      sig('10:10', { subject: 'feat: b', sourceId: 'b', paths: ['src/b.ts'] }),
    ];
    const blocks = inferBlocks(signals);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.minutes).toBe(75);
  });
});
