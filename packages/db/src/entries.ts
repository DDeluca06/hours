// ---------------------------------------------------------------------------
// Entry persistence.
//
// The status transition is one-directional and enforced here rather than by the
// callers: draft → approved → pushed. A pushed entry is immutable, because the
// row it corresponds to is already sitting in a shared spreadsheet and editing
// the local copy would quietly desynchronize the two.
// ---------------------------------------------------------------------------

import { randomUUID } from 'node:crypto';
import type { ClockRange, Entry, EntryStatus } from '@hours/core';
import { prisma, TX_OPTIONS, withBusyRetry } from './client.js';
import { releaseSignals } from './signals.js';

export interface StoredEntry extends Entry {
  id: string;
  sheetRange: string | null;
  pushedAt: Date | null;
}

function toStored(r: {
  id: string;
  day: string;
  person: string;
  projectKey: string;
  minutes: number;
  activity: string;
  rangesJson: string;
  description: string | null;
  status: string;
  provenance: string | null;
  signalIdsJson: string | null;
  taskId: string | null;
  sheetRange: string | null;
  pushedAt: Date | null;
}): StoredEntry {
  return {
    id: r.id,
    day: r.day,
    person: r.person,
    projectKey: r.projectKey,
    minutes: r.minutes,
    activity: r.activity as Entry['activity'],
    ranges: JSON.parse(r.rangesJson) as ClockRange[],
    ...(r.description ? { description: r.description } : {}),
    status: r.status as EntryStatus,
    ...(r.provenance ? { provenance: r.provenance } : {}),
    ...(r.signalIdsJson ? { signalIds: JSON.parse(r.signalIdsJson) as string[] } : {}),
    ...(r.taskId ? { taskId: r.taskId } : {}),
    sheetRange: r.sheetRange,
    pushedAt: r.pushedAt,
  };
}

/**
 * Create entries as one unit.
 *
 * The transaction is what makes the batch retryable: creating them one at a
 * time meant a collision partway through left the first few committed, and a
 * retry from outside would have written those twice.
 */
export async function createEntries(entries: readonly Entry[]): Promise<StoredEntry[]> {
  if (entries.length === 0) return [];
  return withBusyRetry(() =>
    prisma.$transaction(async (tx) => {
      const out: StoredEntry[] = [];
      for (const e of entries) {
        const row = await tx.entry.create({
          data: {
            day: e.day,
            person: e.person,
            projectKey: e.projectKey,
            minutes: e.minutes,
            activity: e.activity,
            rangesJson: JSON.stringify(e.ranges),
            description: e.description ?? null,
            status: e.status,
            provenance: e.provenance ?? null,
            signalIdsJson: e.signalIds?.length ? JSON.stringify(e.signalIds) : null,
            taskId: e.taskId ?? null,
          },
        });
        out.push(toStored(row));
      }
      return out;
    }, TX_OPTIONS),
  );
}

export interface EntryQuery {
  day?: string;
  /** Inclusive range, YYYY-MM-DD. Ignored when `day` is set. */
  fromDay?: string;
  toDay?: string;
  projectKey?: string;
  status?: EntryStatus | EntryStatus[];
  person?: string;
  /** OpenProject work package id; entries carrying it. */
  taskId?: string;
}

export async function listEntries(q: EntryQuery = {}): Promise<StoredEntry[]> {
  const where: Record<string, unknown> = {};
  if (q.day) where['day'] = q.day;
  else if (q.fromDay || q.toDay) {
    // Day keys are zero-padded YYYY-MM-DD, so lexical comparison is date order.
    where['day'] = { ...(q.fromDay ? { gte: q.fromDay } : {}), ...(q.toDay ? { lte: q.toDay } : {}) };
  }
  if (q.projectKey) where['projectKey'] = q.projectKey;
  if (q.person) where['person'] = q.person;
  if (q.taskId) where['taskId'] = q.taskId;
  if (q.status) where['status'] = Array.isArray(q.status) ? { in: q.status } : q.status;

  const rows = await prisma.entry.findMany({
    where,
    orderBy: [{ day: 'asc' }, { createdAt: 'asc' }],
  });
  return rows.map(toStored);
}

export async function getEntry(id: string): Promise<StoredEntry | null> {
  const row = await prisma.entry.findUnique({ where: { id } });
  return row ? toStored(row) : null;
}

/** Fields a draft/approved entry may be corrected on during review. */
export interface EntryPatch {
  minutes?: number;
  activity?: Entry['activity'];
  ranges?: ClockRange[];
  description?: string | null;
  projectKey?: string;
  day?: string;
  person?: string;
  /** Attach or detach an OpenProject work package; null clears it. */
  taskId?: string | null;
}

export async function updateEntry(id: string, patch: EntryPatch): Promise<StoredEntry> {
  const existing = await prisma.entry.findUnique({ where: { id } });
  if (!existing) throw new Error(`no entry ${id}`);
  if (existing.status === 'pushed') {
    throw new Error(
      `entry ${id} is already in the sheet — edit the sheet row directly, or the two will disagree`,
    );
  }
  if (isLeaseLive(existing.pushLeaseAt)) {
    throw new Error(
      `entry ${id} is being pushed right now — the cells were already built from it, so an edit would not reach the sheet. Try again in a moment.`,
    );
  }

  const data: Record<string, unknown> = {};
  if (patch.minutes !== undefined) data['minutes'] = patch.minutes;
  if (patch.activity !== undefined) data['activity'] = patch.activity;
  if (patch.ranges !== undefined) data['rangesJson'] = JSON.stringify(patch.ranges);
  if (patch.description !== undefined) data['description'] = patch.description;
  if (patch.projectKey !== undefined) data['projectKey'] = patch.projectKey;
  if (patch.day !== undefined) data['day'] = patch.day;
  if (patch.person !== undefined) data['person'] = patch.person;
  if (patch.taskId !== undefined) data['taskId'] = patch.taskId;

  // Conditional on the state the checks above were made against: another
  // process could have pushed this entry in between, and an unguarded update
  // would edit a row that is already in the sheet.
  const { count } = await withBusyRetry(() =>
    prisma.entry.updateMany({ where: { id, status: existing.status }, data }),
  );
  if (count === 0) {
    throw new Error(`entry ${id} changed underneath the edit — re-read it and try again`);
  }
  const row = await prisma.entry.findUniqueOrThrow({ where: { id } });
  return toStored(row);
}

export async function approveEntries(ids: readonly string[]): Promise<number> {
  const result = await withBusyRetry(() =>
    prisma.entry.updateMany({
      where: { id: { in: [...ids] }, status: 'draft' },
      data: { status: 'approved' },
    }),
  );
  return result.count;
}

/**
 * Send an approved entry back to draft. Pushed entries are untouched, and so
 * are entries a push currently holds — pulling one out from under an append in
 * flight would leave a sheet row with no local record of itself.
 */
export async function unapproveEntries(ids: readonly string[]): Promise<number> {
  const result = await withBusyRetry(() =>
    prisma.entry.updateMany({
      where: {
        id: { in: [...ids] },
        status: 'approved',
        OR: [{ pushLeaseAt: null }, { pushLeaseAt: { lt: staleLeaseCutoff() } }],
      },
      data: { status: 'draft', pushLeaseAt: null, pushLeaseBy: null },
    }),
  );
  return result.count;
}

/**
 * How long a push lease stays valid.
 *
 * A push is seconds of work, so anything above that is a process that died
 * holding the lease. Ten minutes is long enough that a slow sheet never loses
 * its claim mid-append, and short enough that a crash does not wedge the
 * entries until someone notices.
 */
export const PUSH_LEASE_TTL_MS = 10 * 60_000;

/** Leases stamped before this are abandoned — the process holding them died. */
function staleLeaseCutoff(now = new Date()): Date {
  return new Date(now.getTime() - PUSH_LEASE_TTL_MS);
}

/** Whether a lease timestamp still grants exclusivity. */
function isLeaseLive(pushLeaseAt: Date | null): boolean {
  return pushLeaseAt !== null && pushLeaseAt >= staleLeaseCutoff();
}

export interface PushClaim {
  /** Token identifying this claim. Pass it to `releasePushClaim` on failure. */
  owner: string;
  /** The entries this process now exclusively owns and may append. */
  claimed: StoredEntry[];
  /**
   * Ids that were asked for but not won — another live push holds them, or they
   * are no longer approved. Skipped, never an error: re-running picks them up
   * once the other push resolves.
   */
  contended: string[];
}

/**
 * Take exclusive ownership of the entries about to be appended to the sheet.
 *
 * This is the guard on the one operation that changes something other people
 * can see. Two agents that both listed the same approved entries would
 * otherwise both append them: the duplicate check in the connector only sees
 * rows already *in* the sheet, so it cannot catch a rival append still in
 * flight, and the sheet is append-only — nobody here can delete the extra row.
 *
 * The claim is a single conditional UPDATE, which SQLite serializes, so exactly
 * one caller can win a given entry. The random `owner` is then read back to
 * learn precisely which ones that was.
 */
export async function claimEntriesForPush(ids: readonly string[]): Promise<PushClaim> {
  const owner = randomUUID();
  const now = new Date();
  const staleBefore = staleLeaseCutoff(now);

  await withBusyRetry(() =>
    prisma.entry.updateMany({
      where: {
        id: { in: [...ids] },
        // Still approved: an entry another push already completed is `pushed`
        // and must not be appended a second time.
        status: 'approved',
        OR: [{ pushLeaseAt: null }, { pushLeaseAt: { lt: staleBefore } }],
      },
      data: { pushLeaseAt: now, pushLeaseBy: owner },
    }),
  );

  const rows = await prisma.entry.findMany({
    where: { id: { in: [...ids] }, pushLeaseBy: owner },
    orderBy: [{ day: 'asc' }, { createdAt: 'asc' }],
  });
  const won = new Set(rows.map((r) => r.id));

  return {
    owner,
    claimed: rows.map(toStored),
    contended: ids.filter((id) => !won.has(id)),
  };
}

/**
 * Give back a claim without pushing — the append failed, or the operator
 * declined at the confirmation. Only touches entries still approved, so it can
 * never un-stamp one that landed.
 */
export async function releasePushClaim(owner: string): Promise<number> {
  const result = await withBusyRetry(() =>
    prisma.entry.updateMany({
      where: { pushLeaseBy: owner, status: 'approved' },
      data: { pushLeaseAt: null, pushLeaseBy: null },
    }),
  );
  return result.count;
}

/**
 * Stamp entries as pushed, clearing the lease with them.
 *
 * Guarded on `status: 'approved'`: without it a re-entrant push would overwrite
 * the sheetRange of a row that already landed, losing the pointer to where the
 * real one lives. The returned count is how many actually transitioned — a
 * caller seeing fewer than it asked for pushed something already pushed.
 */
export async function markPushed(
  ids: readonly string[],
  sheetRange: string,
): Promise<number> {
  const result = await withBusyRetry(() =>
    prisma.entry.updateMany({
      where: { id: { in: [...ids] }, status: 'approved' },
      data: {
        status: 'pushed',
        sheetRange,
        pushedAt: new Date(),
        pushLeaseAt: null,
        pushLeaseBy: null,
      },
    }),
  );
  return result.count;
}

/**
 * Delete a draft or approved entry, returning its signals to the pool.
 *
 * Releasing matters: without it, discarding a bad draft would also bury the
 * evidence behind it, so the next reconstruction would silently skip that stretch
 * of the day and the time would be lost rather than re-offered.
 */
export async function deleteEntry(id: string): Promise<StoredEntry> {
  const existing = await getEntry(id);
  if (!existing) throw new Error(`no entry ${id}`);
  if (existing.status === 'pushed') {
    throw new Error(`entry ${id} is already in the sheet — delete the sheet row first`);
  }

  // Deleting conditionally on the lease closes the window where a push has the
  // cells in hand: the row would land in the sheet with nothing local pointing
  // at it, and the sheet is append-only, so it could not be taken back.
  const { count } = await withBusyRetry(() =>
    prisma.entry.deleteMany({
      where: {
        id,
        status: { not: 'pushed' },
        OR: [{ pushLeaseAt: null }, { pushLeaseAt: { lt: staleLeaseCutoff() } }],
      },
    }),
  );
  if (count === 0) {
    throw new Error(
      `entry ${id} is being pushed right now — it cannot be dropped until that finishes`,
    );
  }
  if (existing.signalIds?.length) await releaseSignals(existing.signalIds);
  return existing;
}

export async function logPush(args: {
  projectKey: string;
  sheetTab: string;
  entryIds: readonly string[];
  minutes: number;
  ok: boolean;
  error?: string;
  openProjectTimeEntries?: ReadonlyArray<{ entryId: string; timeEntryId: string }>;
}): Promise<void> {
  await withBusyRetry(() =>
    prisma.pushLog.create({
      data: {
        projectKey: args.projectKey,
        sheetTab: args.sheetTab,
        rowCount: args.entryIds.length,
        minutes: args.minutes,
        ok: args.ok,
        error: args.error ?? null,
        entryIds: JSON.stringify(args.entryIds),
        // Null when nothing landed on OpenProject — only successful OP writes
        // are worth remembering, since the map below exists to skip them on a
        // retried push.
        openProjectTimeEntries: args.openProjectTimeEntries?.length
          ? JSON.stringify(args.openProjectTimeEntries)
          : null,
      },
    }),
  );
}

/**
 * entryId → timeEntryId for every entry that already landed on OpenProject.
 *
 * Sheet append and the OP time entry are two ledgers; this map is what stops
 * a retried push from double-writing OP — a re-pushed entry whose time entry
 * already landed must not be created a second time.
 */
export async function listOpenProjectTimeEntries(
  entryIds: readonly string[],
): Promise<Map<string, string>> {
  const wanted = new Set(entryIds);
  const rows = await prisma.pushLog.findMany({
    where: { ok: true, openProjectTimeEntries: { not: null } },
  });
  const out = new Map<string, string>();
  for (const row of rows) {
    if (!row.openProjectTimeEntries) continue;
    for (const raw of JSON.parse(row.openProjectTimeEntries) as unknown[]) {
      const pair = raw as Record<string, unknown> | null;
      const entryId = typeof pair?.entryId === 'string' ? pair.entryId : null;
      const timeEntryId = typeof pair?.timeEntryId === 'string' ? pair.timeEntryId : null;
      if (entryId !== null && timeEntryId !== null && wanted.has(entryId)) {
        out.set(entryId, timeEntryId);
      }
    }
  }
  return out;
}

/** Total pushed hours for a project, for contract-ceiling checks. */
export async function pushedHours(projectKey: string): Promise<number> {
  const agg = await prisma.entry.aggregate({
    where: { projectKey, status: 'pushed' },
    _sum: { minutes: true },
  });
  return (agg._sum.minutes ?? 0) / 60;
}
