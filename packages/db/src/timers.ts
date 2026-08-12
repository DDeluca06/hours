// ---------------------------------------------------------------------------
// Timers.
//
// One open timer at a time, globally. `start` on an already-running timer stops
// the old one first and returns both, so a forgotten `stop` costs you a review
// nudge instead of a lost afternoon.
// ---------------------------------------------------------------------------

import { prisma } from './client.js';

export interface OpenTimer {
  id: string;
  projectKey: string;
  activity: string | null;
  note: string | null;
  startedAt: Date;
}

export interface StoppedTimer extends OpenTimer {
  stoppedAt: Date;
  minutes: number;
}

export async function currentTimer(): Promise<OpenTimer | null> {
  const row = await prisma.timer.findFirst({
    where: { stoppedAt: null },
    orderBy: { startedAt: 'desc' },
  });
  return row
    ? {
        id: row.id,
        projectKey: row.projectKey,
        activity: row.activity,
        note: row.note,
        startedAt: row.startedAt,
      }
    : null;
}

export async function startTimer(args: {
  projectKey: string;
  activity?: string;
  note?: string;
  at?: Date;
}): Promise<{ started: OpenTimer; replaced: StoppedTimer | null }> {
  const at = args.at ?? new Date();
  const open = await currentTimer();
  let replaced: StoppedTimer | null = null;
  if (open) replaced = await stopTimer({ at });

  const row = await prisma.timer.create({
    data: {
      projectKey: args.projectKey,
      activity: args.activity ?? null,
      note: args.note ?? null,
      startedAt: at,
    },
  });
  return {
    started: {
      id: row.id,
      projectKey: row.projectKey,
      activity: row.activity,
      note: row.note,
      startedAt: row.startedAt,
    },
    replaced,
  };
}

export async function stopTimer(args: { at?: Date } = {}): Promise<StoppedTimer | null> {
  const open = await currentTimer();
  if (!open) return null;
  const stoppedAt = args.at ?? new Date();
  // Clock skew or a manual `--at` in the past would otherwise yield negative
  // minutes and a nonsense entry.
  const minutes = Math.max(0, Math.round((stoppedAt.getTime() - open.startedAt.getTime()) / 60_000));
  await prisma.timer.update({ where: { id: open.id }, data: { stoppedAt } });
  return { ...open, stoppedAt, minutes };
}

/** Discard the open timer without producing an entry. */
export async function cancelTimer(): Promise<OpenTimer | null> {
  const open = await currentTimer();
  if (!open) return null;
  await prisma.timer.delete({ where: { id: open.id } });
  return open;
}
