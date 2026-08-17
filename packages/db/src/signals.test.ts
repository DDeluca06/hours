// The overlap detector, against a throwaway SQLite file.
//
// It exists for one failure the sourceId scheme cannot prevent: heartbeat
// signals are anchored at the start of a run, and wakatime-cli flushes
// heartbeats buffered while offline with their original timestamps, which can
// extend a run backwards. The result is a genuinely new sourceId describing
// minutes an already-consumed signal was billed for — invisible to
// recordSignals (the id is new) and to recordSignalSpans (which refuses to
// touch a consumed row). The DDL below mirrors the Signal model in
// schema.prisma; what is under test is the behavior on top of it.

import './signals.test-env.js';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Signal } from '@hours/core';
import { prisma } from './client.js';
import { consumeSignals, findConsumedSpanOverlaps, recordSignals } from './signals.js';

const CREATE_SIGNAL_TABLE = `
  CREATE TABLE IF NOT EXISTS "Signal" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sourceId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "at" DATETIME NOT NULL,
    "until" DATETIME,
    "projectKey" TEXT,
    "subject" TEXT,
    "pathsJson" TEXT,
    "consumedAt" DATETIME,
    "taskId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Signal_sourceId_key" UNIQUE ("sourceId")
  );
`;

const at = (iso: string): Date => new Date(iso);

function heartbeat(sourceId: string, start: string, end?: string): Signal {
  return {
    sourceId,
    kind: 'heartbeat',
    at: at(start),
    ...(end ? { until: at(end) } : {}),
    projectKey: 'north10',
  };
}

beforeAll(async () => {
  await prisma.$executeRawUnsafe(CREATE_SIGNAL_TABLE);
});

beforeEach(async () => {
  await prisma.signal.deleteMany({});
});

describe('findConsumedSpanOverlaps', () => {
  it('reports a new signal that covers minutes an already-billed one claimed', async () => {
    const original = heartbeat('wakapi:m1:/a.ts:1000', '2026-08-14T09:30:00Z', '2026-08-14T10:00:00Z');
    await recordSignals([original]);
    await consumeSignals([original.sourceId]);

    // The offline flush: the same stretch of work, re-anchored half an hour
    // earlier because buffered heartbeats finally arrived.
    const reanchored = heartbeat('wakapi:m1:/a.ts:2000', '2026-08-14T09:00:00Z', '2026-08-14T10:00:00Z');
    const found = await findConsumedSpanOverlaps([reanchored]);

    expect(found).toHaveLength(1);
    expect(found[0]?.sourceId).toBe(reanchored.sourceId);
    expect(found[0]?.consumedSourceId).toBe(original.sourceId);
    expect(found[0]?.overlapMinutes).toBe(30);
  });

  it('says nothing about a signal that merely abuts a consumed one', async () => {
    const first = heartbeat('a', '2026-08-14T09:00:00Z', '2026-08-14T10:00:00Z');
    await recordSignals([first]);
    await consumeSignals([first.sourceId]);

    const next = heartbeat('b', '2026-08-14T10:00:00Z', '2026-08-14T10:30:00Z');
    expect(await findConsumedSpanOverlaps([next])).toEqual([]);
  });

  it('ignores an unconsumed overlap — recordSignalSpans owns that case', async () => {
    const open = heartbeat('a', '2026-08-14T09:00:00Z', '2026-08-14T09:30:00Z');
    await recordSignals([open]);

    const grown = heartbeat('b', '2026-08-14T09:10:00Z', '2026-08-14T09:40:00Z');
    expect(await findConsumedSpanOverlaps([grown])).toEqual([]);
  });

  it('ignores a re-observation of a signal already stored', async () => {
    const one = heartbeat('a', '2026-08-14T09:00:00Z', '2026-08-14T10:00:00Z');
    await recordSignals([one]);
    await consumeSignals([one.sourceId]);
    // Every sweep re-derives this same signal; overlapping itself is not news.
    expect(await findConsumedSpanOverlaps([one])).toEqual([]);
  });

  it('does not compare across kinds or projects — that is what apportionment is for', async () => {
    const consumed = heartbeat('a', '2026-08-14T09:00:00Z', '2026-08-14T10:00:00Z');
    await recordSignals([consumed]);
    await consumeSignals([consumed.sourceId]);

    const commit: Signal = {
      sourceId: 'git:repo:abc',
      kind: 'git_commit',
      at: at('2026-08-14T09:30:00Z'),
      projectKey: 'north10',
    };
    const otherProject = { ...heartbeat('b', '2026-08-14T09:30:00Z', '2026-08-14T09:45:00Z'), projectKey: 'lp' };
    expect(await findConsumedSpanOverlaps([commit, otherProject])).toEqual([]);
  });

  it('catches a point signal landing inside a consumed span', async () => {
    const consumed = heartbeat('a', '2026-08-14T09:00:00Z', '2026-08-14T10:00:00Z');
    await recordSignals([consumed]);
    await consumeSignals([consumed.sourceId]);

    // A lone late heartbeat: no span of its own, but it sits inside billed time,
    // and reconstruction would hand it a fresh lead-in.
    const point = heartbeat('b', '2026-08-14T09:30:00Z');
    const found = await findConsumedSpanOverlaps([point]);
    expect(found).toHaveLength(1);
    expect(found[0]?.overlapMinutes).toBe(0);
  });
});
