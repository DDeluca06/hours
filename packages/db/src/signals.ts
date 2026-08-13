// ---------------------------------------------------------------------------
// Signal persistence.
//
// Writes are idempotent on sourceId, which is what makes the collector safe to
// restart and the reconstruction safe to re-run: re-observing the same commit is
// a no-op rather than a duplicate hour.
// ---------------------------------------------------------------------------

import type { Signal } from '@hours/core';
import { prisma, withBusyRetry } from './client.js';

/**
 * Insert signals, skipping any sourceId already seen.
 *
 * Returns the number genuinely new. Skipping rather than updating is
 * deliberate: the first sighting's timestamp is the truthful one, and a later
 * re-scan of the same commit must not drag the block's end time forward.
 *
 * SQLite has no `skipDuplicates` in Prisma, so the filter is explicit. The
 * per-row fallback exists because two collectors sweeping at once can both pass
 * the existence check for the same commit; a unique-constraint collision there
 * means the row is present, which is the desired end state either way.
 */
export async function recordSignals(signals: readonly Signal[]): Promise<number> {
  if (signals.length === 0) return 0;

  const ids = signals.map((s) => s.sourceId);
  const existing = await prisma.signal.findMany({
    where: { sourceId: { in: ids } },
    select: { sourceId: true },
  });
  const seen = new Set(existing.map((e) => e.sourceId));

  // Deduplicate within the batch too — the same commit can be reachable from
  // two branches in one `git log --all` pass.
  const fresh = new Map<string, Signal>();
  for (const s of signals) {
    if (!seen.has(s.sourceId)) fresh.set(s.sourceId, s);
  }
  if (fresh.size === 0) return 0;

  const data = [...fresh.values()].map((s) => ({
    sourceId: s.sourceId,
    kind: s.kind,
    at: s.at,
    until: s.until ?? null,
    projectKey: s.projectKey,
    subject: s.subject ?? null,
    pathsJson: s.paths ? JSON.stringify(s.paths) : null,
  }));

  try {
    const result = await withBusyRetry(() => prisma.signal.createMany({ data }));
    return result.count;
  } catch {
    let written = 0;
    for (const row of data) {
      try {
        await withBusyRetry(() => prisma.signal.create({ data: row }));
        written++;
      } catch {
        // Already present — a concurrent sweep won the race.
      }
    }
    return written;
  }
}

export interface SignalQuery {
  /** Local day, YYYY-MM-DD. */
  day?: string;
  projectKey?: string;
  /** Exclude signals already folded into an entry. Defaults to true. */
  unconsumedOnly?: boolean;
}

export async function loadSignals(q: SignalQuery = {}): Promise<Signal[]> {
  const where: Record<string, unknown> = {};

  if (q.day) {
    // Local-midnight bounds, not UTC — a day boundary computed in UTC pulls in
    // the neighbouring day's evening work.
    const start = new Date(`${q.day}T00:00:00`);
    const end = new Date(start);
    end.setDate(end.getDate() + 1);
    where['at'] = { gte: start, lt: end };
  }
  if (q.projectKey) where['projectKey'] = q.projectKey;
  if (q.unconsumedOnly !== false) where['consumedAt'] = null;

  const rows = await prisma.signal.findMany({ where, orderBy: { at: 'asc' } });

  return rows.map((r) => ({
    sourceId: r.sourceId,
    kind: r.kind as Signal['kind'],
    at: r.at,
    projectKey: r.projectKey,
    ...(r.until ? { until: r.until } : {}),
    ...(r.subject ? { subject: r.subject } : {}),
    ...(r.pathsJson ? { paths: JSON.parse(r.pathsJson) as string[] } : {}),
  }));
}

/**
 * Grow the measured span on signals whose work was still running when first seen.
 *
 * `recordSignals` deliberately never updates an existing row — the first
 * sighting's `at` is the truthful one. This is the one narrow exception, and it
 * exists because a turn's *end* is not knowable when the turn starts: the sweep
 * at 10:20 sees a prompt at 10:19 with one assistant line after it, and only the
 * sweep at 10:30 can say the turn actually ran until 10:26. Refusing to revise
 * would permanently bill a 7-minute turn as 30 seconds.
 *
 * Two guards keep it honest, and both matter:
 *   - the span only ever moves *forward* (`until` null or earlier than the one
 *     we just observed), so this is monotonic — re-running it is a no-op and no
 *     sequence of sweeps can shrink a block or oscillate it.
 *   - `consumedAt: null` — a consumed signal already justifies a created entry.
 *     Growing its span afterwards would leave that entry's duration disagreeing
 *     with its own evidence, and entries change through review, not here.
 *
 * Returns the number of rows actually advanced.
 */
export async function recordSignalSpans(signals: readonly Signal[]): Promise<number> {
  const spans = signals.filter(
    (s): s is Signal & { until: Date } => s.until !== undefined && s.until > s.at,
  );
  if (spans.length === 0) return 0;

  // Narrow to the rows that can actually change before writing anything. Every
  // sweep re-reads the same transcripts, so without this the steady state is one
  // pointless UPDATE per historical turn against a file three other processes
  // are also writing to.
  const candidates = await prisma.signal.findMany({
    where: { sourceId: { in: spans.map((s) => s.sourceId) }, consumedAt: null },
    select: { sourceId: true, until: true },
  });
  const stored = new Map(candidates.map((r) => [r.sourceId, r.until]));

  let advanced = 0;
  for (const s of spans) {
    const current = stored.get(s.sourceId);
    if (current === undefined) continue; // not stored (or already consumed)
    if (current !== null && current >= s.until) continue;
    const result = await withBusyRetry(() =>
      prisma.signal.updateMany({
        // Re-checked in the WHERE, not just above: another process may have
        // advanced this same span between the read and this write.
        where: {
          sourceId: s.sourceId,
          consumedAt: null,
          OR: [{ until: null }, { until: { lt: s.until } }],
        },
        data: { until: s.until },
      }),
    );
    advanced += result.count;
  }
  return advanced;
}

/** Mark signals as folded into an entry so reconstruction stays idempotent. */
export async function consumeSignals(sourceIds: readonly string[]): Promise<void> {
  if (sourceIds.length === 0) return;
  await withBusyRetry(() =>
    prisma.signal.updateMany({
      where: { sourceId: { in: [...sourceIds] } },
      data: { consumedAt: new Date() },
    }),
  );
}

/** Release signals back into the pool — used when a draft entry is discarded. */
export async function releaseSignals(sourceIds: readonly string[]): Promise<void> {
  if (sourceIds.length === 0) return;
  await withBusyRetry(() =>
    prisma.signal.updateMany({
      where: { sourceId: { in: [...sourceIds] } },
      data: { consumedAt: null },
    }),
  );
}

/** The most recent signal timestamp for a project, for incremental collection. */
export async function latestSignalAt(projectKey: string): Promise<Date | null> {
  const row = await prisma.signal.findFirst({
    where: { projectKey },
    orderBy: { at: 'desc' },
    select: { at: true },
  });
  return row?.at ?? null;
}
