// ---------------------------------------------------------------------------
// Timers.
//
// One open timer per project, enforced by the database. Timers on different
// projects run side by side — the two engagements overlap in a day — while a
// `start` on a project that already has one running stops the old one first
// and returns both, so a forgotten `stop` costs you a review nudge instead of
// a lost afternoon.
//
// Two rules exist because this tool bills two contracts, and getting the wrong
// one is worse than doing nothing:
//
//   - `stop`/`cancel` without a project is only unambiguous while *one* timer is
//     running. With two, guessing (the most recently started one, as this used
//     to) silently banks a north10 afternoon against lp: `resolveTimerTarget`
//     refuses and names both instead.
//   - Two timers open over the same minutes bill those minutes twice, once per
//     contract, and `stopOpen` measures each from its own `startedAt` so neither
//     one knows. Concurrency is allowed — it is the whole point of per-project
//     timers — but `startTimer` reports what else is already running so the
//     surface can say so out loud at the moment the overlap begins, rather than
//     leaving it to a `findOverlaps` warning at push time.
//
// Every mutation here is written to survive concurrent processes. Three of them
// are normal now — the CLI, Claude Code's MCP server, and OpenCode's — and a
// read-then-write pair across two statements is not safe between them:
//
//   - "at most one open per project" is a unique index on `openKey` (the open
//     timer's row carries its project key there), not an if-statement.
//   - stopping is a conditional UPDATE on `stoppedAt: null`, so two processes
//     stopping the same timer produce one entry, not two for the same minutes.
//   - start's stop-then-create is one transaction, so a crash mid-swap cannot
//     bank the old timer and leave nothing running.
// ---------------------------------------------------------------------------

import { prisma, TX_OPTIONS, withBusyRetry } from './client.js';
import type { PrismaClient } from '../generated/client/client.js';

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

/**
 * The open timer an untargeted `stop`/`cancel` acts on, or null when none is
 * running. Throws when the answer is a guess.
 *
 * With one timer open there is nothing to disambiguate. With several — the
 * dual-contract day this whole feature exists for — picking the most recently
 * started one is a coin flip against the user's money: an lp timer started five
 * minutes after a north10 one would swallow the north10 afternoon and leave the
 * north10 timer running. Naming both and refusing costs one retyped flag.
 */
export function resolveTimerTarget(
  all: readonly OpenTimer[],
  projectKey?: string,
): OpenTimer | null {
  if (projectKey) return all.find((t) => t.projectKey === projectKey) ?? null;
  if (all.length === 0) return null;
  const only = all[0];
  if (all.length === 1 && only) return only;
  const running = all.map((t) => t.projectKey).join(', ');
  throw new Error(
    `${all.length} timers are running (${running}) — say which one with -p/--project (or the "project" parameter). Nothing was changed.`,
  );
}

/**
 * Every open timer, most recently started first. Callers that act on "the"
 * timer go through `resolveTimerTarget`; callers that want the whole picture
 * iterate all of them.
 */
async function readOpenTimers(db: TimerDb): Promise<OpenTimer[]> {
  const rows = await db.timer.findMany({
    where: { stoppedAt: null },
    orderBy: { startedAt: 'desc' },
  });
  return rows.map(toOpen);
}

export async function openTimers(): Promise<OpenTimer[]> {
  return readOpenTimers(prisma);
}

/**
 * Stop one open timer and report what it accumulated. Targets the open timer
 * on `projectKey` when given, else the only one running — see
 * `resolveTimerTarget` for why "else the newest" is not an option.
 *
 * Returns null when no timer was running *and* when another process stopped it
 * between the read and the write. That second case is why the update is
 * conditional: both callers would otherwise turn the same stretch of the day
 * into an entry, and the invariant that inferred time never exceeds wall-clock
 * time would break at the source.
 */
async function stopOpen(
  db: TimerDb,
  at: Date,
  projectKey?: string,
): Promise<StoppedTimer | null> {
  const all = await readOpenTimers(db);
  const open = resolveTimerTarget(all, projectKey);
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

export async function stopTimer(args: { at?: Date; projectKey?: string } = {}): Promise<StoppedTimer | null> {
  const at = args.at ?? new Date();
  return withBusyRetry(() => stopOpen(prisma, at, args.projectKey));
}

export interface StartedTimer {
  started: OpenTimer;
  /** The same project's timer, stopped to make room. Its minutes are discarded. */
  replaced: StoppedTimer | null;
  /**
   * Timers on *other* projects that were already running, and therefore now
   * cover the same wall-clock minutes as this one.
   *
   * Not an error: two engagements in one day is the normal case, and the
   * database allows it on purpose. But every minute from here until one of them
   * stops gets billed to both contracts, and nothing downstream will stop that —
   * `findOverlaps` at push time is a warning, not a gate. So the surfaces say it
   * now, while the person can still act on it.
   */
  concurrent: OpenTimer[];
}

export async function startTimer(args: {
  projectKey: string;
  activity?: string;
  note?: string;
  taskId?: string;
  at?: Date;
}): Promise<StartedTimer> {
  const at = args.at ?? new Date();

  try {
    // The whole transaction is the retry unit: it either swapped the timers or
    // did nothing, so a fresh attempt re-reads state rather than compounding a
    // partial one. Only the *same project's* open timer is stopped — timers on
    // other projects keep running.
    return await withBusyRetry(() =>
      prisma.$transaction(async (tx) => {
        const replaced = await stopOpen(tx, at, args.projectKey);
        // Read inside the transaction, after the same-project swap: what is left
        // open is exactly what will run alongside the new timer.
        const concurrent = (await readOpenTimers(tx)).filter(
          (t) => t.projectKey !== args.projectKey,
        );
        const row = await tx.timer.create({
          data: {
            projectKey: args.projectKey,
            activity: args.activity ?? null,
            note: args.note ?? null,
            taskId: args.taskId ?? null,
            startedAt: at,
            // The unique index on openKey scopes to one open timer per
            // project: this row carries its project key there.
            openKey: args.projectKey,
          },
        });
        return { started: toOpen(row), replaced, concurrent };
      }, TX_OPTIONS),
    );
  } catch (err) {
    // The unique index on openKey fired: another process created its timer on
    // this project between our stop and our create. Both timers must not run,
    // and silently taking one of them would hide the collision, so say what
    // happened.
    if (isUniqueViolation(err)) {
      throw new Error(
        `another process started a ${args.projectKey} timer at the same moment — run \`hours status\` to see which one is running`,
        { cause: err },
      );
    }
    throw err;
  }
}

/** Discard one open timer without producing an entry. Targets like `stop`. */
export async function cancelTimer(args: { projectKey?: string } = {}): Promise<OpenTimer | null> {
  const all = await readOpenTimers(prisma);
  const open = resolveTimerTarget(all, args.projectKey);
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
