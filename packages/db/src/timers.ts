// ---------------------------------------------------------------------------
// Timers.
//
// One open timer at a time, globally. `start` on an already-running timer stops
// the old one first and returns both, so a forgotten `stop` costs you a review
// nudge instead of a lost afternoon.
//
// Every mutation here is written to survive concurrent processes. Three of them
// are normal now — the CLI, Claude Code's MCP server, and OpenCode's — and a
// read-then-write pair across two statements is not safe between them:
//
//   - "at most one open" is a unique index on `openKey`, not an if-statement.
//   - stopping is a conditional UPDATE on `stoppedAt: null`, so two processes
//     stopping the same timer produce one entry, not two for the same minutes.
//   - start's stop-then-create is one transaction, so a crash mid-swap cannot
//     bank the old timer and leave nothing running.
// ---------------------------------------------------------------------------

import { prisma, TX_OPTIONS, withBusyRetry } from './client.js';
import type { PrismaClient } from '../generated/client/client.js';

/** The sentinel in `openKey`. Any constant works; the uniqueness is the point. */
const OPEN = 'open';

/**
 * The subset of the client these helpers need, so each one works against both
 * `prisma` and an interactive transaction handle.
 */
type TimerDb = { timer: PrismaClient['timer'] };

export interface OpenTimer {
  id: string;
  projectKey: string;
  activity: string | null;
  note: string | null;
  /** OpenProject work package id the timer will log against; null when none was chosen. */
  taskId: string | null;
  startedAt: Date;
}

export interface StoppedTimer extends OpenTimer {
  stoppedAt: Date;
  minutes: number;
}

interface TimerRow {
  id: string;
  projectKey: string;
  activity: string | null;
  note: string | null;
  taskId: string | null;
  startedAt: Date;
}

function toOpen(row: TimerRow): OpenTimer {
  return {
    id: row.id,
    projectKey: row.projectKey,
    activity: row.activity,
    note: row.note,
    taskId: row.taskId,
    startedAt: row.startedAt,
  };
}

async function readOpen(db: TimerDb): Promise<OpenTimer | null> {
  const row = await db.timer.findFirst({
    where: { stoppedAt: null },
    orderBy: { startedAt: 'desc' },
  });
  return row ? toOpen(row) : null;
}

export async function currentTimer(): Promise<OpenTimer | null> {
  return readOpen(prisma);
}

/**
 * Stop the open timer and report what it accumulated.
 *
 * Returns null when no timer was running *and* when another process stopped it
 * between the read and the write. That second case is why the update is
 * conditional: both callers would otherwise turn the same stretch of the day
 * into an entry, and the invariant that inferred time never exceeds wall-clock
 * time would break at the source.
 */
async function stopOpen(db: TimerDb, at: Date): Promise<StoppedTimer | null> {
  const open = await readOpen(db);
  if (!open) return null;

  // Clock skew or a manual `--at` in the past would otherwise yield negative
  // minutes and a nonsense entry.
  const minutes = Math.max(0, Math.round((at.getTime() - open.startedAt.getTime()) / 60_000));

  const { count } = await db.timer.updateMany({
    where: { id: open.id, stoppedAt: null },
    data: { stoppedAt: at, openKey: null },
  });
  // Lost the race — the other process owns these minutes and will log them.
  if (count === 0) return null;

  return { ...open, stoppedAt: at, minutes };
}

export async function stopTimer(args: { at?: Date } = {}): Promise<StoppedTimer | null> {
  const at = args.at ?? new Date();
  return withBusyRetry(() => stopOpen(prisma, at));
}

export async function startTimer(args: {
  projectKey: string;
  activity?: string;
  note?: string;
  taskId?: string;
  at?: Date;
}): Promise<{ started: OpenTimer; replaced: StoppedTimer | null }> {
  const at = args.at ?? new Date();

  try {
    // The whole transaction is the retry unit: it either swapped the timers or
    // did nothing, so a fresh attempt re-reads state rather than compounding a
    // partial one.
    return await withBusyRetry(() =>
      prisma.$transaction(async (tx) => {
        const replaced = await stopOpen(tx, at);
        const row = await tx.timer.create({
          data: {
            projectKey: args.projectKey,
            activity: args.activity ?? null,
            note: args.note ?? null,
            taskId: args.taskId ?? null,
            startedAt: at,
            openKey: OPEN,
          },
        });
        return { started: toOpen(row), replaced };
      }, TX_OPTIONS),
    );
  } catch (err) {
    // The unique index on openKey fired: another process created its timer
    // between our stop and our create. Both timers must not run, and silently
    // taking one of them would hide the collision, so say what happened.
    if (isUniqueViolation(err)) {
      throw new Error(
        'another process started a timer at the same moment — run `hours status` to see which one is running',
        { cause: err },
      );
    }
    throw err;
  }
}

/** Discard the open timer without producing an entry. */
export async function cancelTimer(): Promise<OpenTimer | null> {
  const open = await readOpen(prisma);
  if (!open) return null;
  // Conditional for the same reason as the stop: whoever deletes the row owns
  // the outcome, and the loser must report "nothing running" rather than claim
  // it cancelled a timer that had already become an entry.
  const { count } = await withBusyRetry(() =>
    prisma.timer.deleteMany({ where: { id: open.id, stoppedAt: null } }),
  );
  return count === 1 ? open : null;
}

/** Prisma's unique-constraint error, without importing its error classes. */
function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 'P2002';
}
