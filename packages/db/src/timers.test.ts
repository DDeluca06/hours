// Timer semantics against a throwaway SQLite file: one open timer per project,
// cross-project concurrency, the concurrency report a start returns, and the
// refusal to guess a target for an unqualified stop/cancel. The table DDL below
// mirrors the Timer model in schema.prisma — the point under test is the
// behavior on top of the unique index, not the schema itself.

import './timers.test-env.js';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from './client.js';
import { cancelTimer, openTimers, startTimer, stopTimer } from './timers.js';

const CREATE_TIMER_TABLE = `
  CREATE TABLE IF NOT EXISTS "Timer" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectKey" TEXT NOT NULL,
    "activity" TEXT,
    "note" TEXT,
    "taskId" TEXT,
    "startedAt" DATETIME NOT NULL,
    "stoppedAt" DATETIME,
    "openKey" TEXT,
    CONSTRAINT "Timer_openKey_key" UNIQUE ("openKey")
  );
`;
const CREATE_TIMER_INDEX = `CREATE INDEX IF NOT EXISTS "Timer_stoppedAt_idx" ON "Timer"("stoppedAt");`;

const at = (iso: string): Date => new Date(iso);

beforeAll(async () => {
  await prisma.$executeRawUnsafe(CREATE_TIMER_TABLE);
  await prisma.$executeRawUnsafe(CREATE_TIMER_INDEX);
});

beforeEach(async () => {
  await prisma.timer.deleteMany({});
});

describe('startTimer', () => {
  it('runs timers on different projects side by side', async () => {
    const first = await startTimer({ projectKey: 'lp', at: at('2026-08-14T09:00:00Z') });
    const second = await startTimer({ projectKey: 'north10', at: at('2026-08-14T10:00:00Z') });

    expect(first.replaced).toBeNull();
    expect(second.replaced).toBeNull();

    const all = await openTimers();
    expect(all.map((t) => t.projectKey).sort()).toEqual(['lp', 'north10']);
    // Most recently started first.
    expect(all[0]?.projectKey).toBe('north10');
  });

  // Two contracts cannot both be billed the same minute, and each timer measures
  // from its own start, so the overlap is reported at the moment it begins.
  it('reports the other projects already running as concurrent', async () => {
    const first = await startTimer({ projectKey: 'lp', at: at('2026-08-14T09:00:00Z') });
    expect(first.concurrent).toEqual([]);

    const second = await startTimer({ projectKey: 'north10', at: at('2026-08-14T09:05:00Z') });
    expect(second.concurrent.map((t) => t.projectKey)).toEqual(['lp']);
  });

  it('does not report the same project’s replaced timer as concurrent', async () => {
    await startTimer({ projectKey: 'lp', at: at('2026-08-14T09:00:00Z') });
    const again = await startTimer({ projectKey: 'lp', at: at('2026-08-14T10:00:00Z') });
    expect(again.replaced?.projectKey).toBe('lp');
    expect(again.concurrent).toEqual([]);
  });

  it('replaces only the same project\u2019s open timer, and returns it', async () => {
    await startTimer({ projectKey: 'lp', at: at('2026-08-14T09:00:00Z') });
    await startTimer({ projectKey: 'north10', at: at('2026-08-14T09:30:00Z') });
    const replaced = await startTimer({ projectKey: 'lp', activity: 'dev', at: at('2026-08-14T10:00:00Z') });

    expect(replaced.replaced?.projectKey).toBe('lp');
    expect(replaced.replaced?.minutes).toBe(60);
    expect(replaced.started.projectKey).toBe('lp');

    const all = await openTimers();
    expect(all).toHaveLength(2);
    expect(all.find((t) => t.projectKey === 'lp')?.startedAt.toISOString()).toBe(
      '2026-08-14T10:00:00.000Z',
    );
    // The replaced timer is closed — its row carries no openKey and no stoppedAt.
    const closed = await prisma.timer.findMany({ where: { projectKey: 'lp', stoppedAt: { not: null } } });
    expect(closed).toHaveLength(1);
    expect(closed[0]?.openKey).toBeNull();
  });

  it('carries activity, note and taskId onto the open timer', async () => {
    const { started } = await startTimer({
      projectKey: 'north10',
      activity: 'docs',
      note: 'api docs',
      taskId: '136',
      at: at('2026-08-14T09:00:00Z'),
    });
    expect(started.activity).toBe('docs');
    expect(started.note).toBe('api docs');
    expect(started.taskId).toBe('136');
  });
});

describe('stopTimer', () => {
  it('stops the only running timer when no project is named', async () => {
    await startTimer({ projectKey: 'lp', at: at('2026-08-14T09:00:00Z') });

    const stopped = await stopTimer({ at: at('2026-08-14T11:00:00Z') });
    expect(stopped?.projectKey).toBe('lp');
    expect(stopped?.minutes).toBe(120);
    expect(await openTimers()).toEqual([]);
  });

  // The dual-contract failure this refusal exists for: an lp timer started five
  // minutes after a north10 one would otherwise swallow the north10 afternoon
  // (it is the most recently started) and leave north10 still running.
  it('refuses to guess which timer to stop, and stops nothing, when two are running', async () => {
    await startTimer({ projectKey: 'north10', at: at('2026-08-14T09:00:00Z') });
    await startTimer({ projectKey: 'lp', at: at('2026-08-14T09:05:00Z') });

    await expect(stopTimer({ at: at('2026-08-14T11:00:00Z') })).rejects.toThrow(
      /2 timers are running \(lp, north10\)/,
    );
    expect((await openTimers()).map((t) => t.projectKey).sort()).toEqual(['lp', 'north10']);
  });

  it('stops a named project\u2019s timer and leaves the others running', async () => {
    await startTimer({ projectKey: 'lp', at: at('2026-08-14T09:00:00Z') });
    await startTimer({ projectKey: 'north10', at: at('2026-08-14T10:00:00Z') });

    const stopped = await stopTimer({ projectKey: 'lp', at: at('2026-08-14T11:00:00Z') });
    expect(stopped?.projectKey).toBe('lp');
    expect(stopped?.minutes).toBe(120);

    const all = await openTimers();
    expect(all.map((t) => t.projectKey)).toEqual(['north10']);
  });

  it('reports nothing for a project with no open timer, and touches nothing', async () => {
    await startTimer({ projectKey: 'lp', at: at('2026-08-14T09:00:00Z') });
    const stopped = await stopTimer({ projectKey: 'north10', at: at('2026-08-14T10:00:00Z') });
    expect(stopped).toBeNull();
    expect((await openTimers()).map((t) => t.projectKey)).toEqual(['lp']);
  });

  it('a second stop of the same timer returns null — one entry per stretch of the day', async () => {
    await startTimer({ projectKey: 'lp', at: at('2026-08-14T09:00:00Z') });
    await stopTimer({ projectKey: 'lp', at: at('2026-08-14T10:00:00Z') });
    const again = await stopTimer({ projectKey: 'lp', at: at('2026-08-14T10:30:00Z') });
    expect(again).toBeNull();
  });
});

describe('cancelTimer', () => {
  it('discards the only running timer by default, and a named one on request', async () => {
    await startTimer({ projectKey: 'lp', at: at('2026-08-14T09:00:00Z') });
    await startTimer({ projectKey: 'north10', at: at('2026-08-14T10:00:00Z') });

    // Ambiguous with two running: nothing is discarded on a guess.
    await expect(cancelTimer()).rejects.toThrow(/2 timers are running/);
    expect((await openTimers()).map((t) => t.projectKey)).toEqual(['north10', 'lp']);

    const named = await cancelTimer({ projectKey: 'north10' });
    expect(named?.projectKey).toBe('north10');

    const rest = await cancelTimer();
    expect(rest?.projectKey).toBe('lp');
    expect(await openTimers()).toEqual([]);
  });

  it('leaves everything alone when the named project has no open timer', async () => {
    await startTimer({ projectKey: 'lp', at: at('2026-08-14T09:00:00Z') });
    expect(await cancelTimer({ projectKey: 'north10' })).toBeNull();
    expect((await openTimers()).map((t) => t.projectKey)).toEqual(['lp']);
  });
});
