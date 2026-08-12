import { describe, expect, it } from 'vitest';
import { groupSignalsByDay, inferBlocks, type Signal } from './blocks.js';
import { DEFAULT_WORKDAY } from './workday.js';

/** Build a signal at a local wall-clock time on 2026-08-12. */
function sig(time: string, over: Partial<Signal> = {}): Signal {
  const [h, m] = time.split(':').map(Number);
  const at = new Date(2026, 7, 12, h ?? 0, m ?? 0, 0);
  return {
    sourceId: over.sourceId ?? `s:${time}`,
    kind: over.kind ?? 'git_commit',
    at,
    projectKey: over.projectKey ?? 'north10',
    ...(over.subject !== undefined ? { subject: over.subject } : {}),
    ...(over.paths !== undefined ? { paths: over.paths } : {}),
  };
}

describe('inferBlocks', () => {
  it('gives a lone commit a real duration instead of a zero-length block', () => {
    const blocks = inferBlocks([sig('10:45', { subject: 'feat: add matcher' })]);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.minutes).toBeGreaterThanOrEqual(DEFAULT_WORKDAY.minBlockMin);
  });

  it('treats commits as trailing edges, so the block ends at the last one', () => {
    const blocks = inferBlocks([sig('9:30'), sig('9:50'), sig('10:05')]);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.endMin).toBe(10 * 60);
  });

  it('splits on an idle gap longer than the policy', () => {
    const blocks = inferBlocks([sig('9:30'), sig('9:45'), sig('13:00'), sig('13:20')]);
    expect(blocks).toHaveLength(2);
  });

  it('never merges across projects, even back to back', () => {
    const blocks = inferBlocks([
      sig('9:30', { projectKey: 'north10' }),
      sig('9:35', { projectKey: 'lp', sourceId: 's:lp' }),
    ]);
    expect(blocks.map((b) => b.projectKey)).toEqual(['north10', 'lp']);
  });

  it('folds two same-activity stretches separated by a short gap', () => {
    const blocks = inferBlocks([
      sig('9:30', { subject: 'feat: a', paths: ['src/a.ts'] }),
      sig('10:10', { subject: 'feat: b', paths: ['src/b.ts'], sourceId: 's:b' }),
    ]);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.activity).toBe('Development');
    expect(blocks[0]?.signalIds).toHaveLength(2);
  });

  it('drops work outside 9–3 by default and keeps it when asked', () => {
    const evening = [sig('20:00'), sig('20:30')];
    expect(inferBlocks(evening)).toHaveLength(0);
    expect(inferBlocks(evening, { allowOutsideWorkday: true })).toHaveLength(1);
  });

  it('rounds to the 15-minute grid the sheet uses', () => {
    const blocks = inferBlocks([sig('9:37'), sig('10:52')]);
    for (const b of blocks) {
      expect(b.startMin % 15).toBe(0);
      expect(b.minutes % 15).toBe(0);
    }
  });

  it('classifies schema work as Data model, not Development', () => {
    const blocks = inferBlocks([
      sig('9:30', { subject: 'feat: hour_logs table', paths: ['prisma/schema.prisma'] }),
    ]);
    expect(blocks[0]?.activity).toBe('Data model');
  });

  it('does not let one stray docs file relabel a feature block', () => {
    const blocks = inferBlocks([
      sig('9:30', {
        subject: 'feat: sync',
        paths: ['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts', 'docs/notes.md'],
      }),
    ]);
    expect(blocks[0]?.activity).toBe('Development');
  });

  it('is empty for no signals', () => {
    expect(inferBlocks([])).toEqual([]);
  });
});

describe('groupSignalsByDay', () => {
  it('buckets by local day, not UTC', () => {
    // 11 PM local on 8/12 is already 8/13 in UTC — bucketing by UTC would move
    // a late-evening commit onto the wrong timesheet row.
    const late: Signal = {
      sourceId: 'late',
      kind: 'git_commit',
      at: new Date(2026, 7, 12, 23, 30),
      projectKey: 'lp',
    };
    const days = [...groupSignalsByDay([late]).keys()];
    expect(days).toEqual(['2026-08-12']);
  });
});
