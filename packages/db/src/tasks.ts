// ---------------------------------------------------------------------------
// Task cache.
//
// Tasks are OpenProject work packages, cached locally so the tool chain never
// depends on OpenProject being up — a failed sync must leave the cache
// untouched, and reads must work from the cache alone. The cache is also the
// reconciliation point between the two ledgers: OpenProject's spentTime
// (written by op_log_time) on one side, the local hours.db entries summed by
// taskId on the other. The two are never summed together — the same work can
// appear in both, and nothing links a sheet row to an OpenProject time entry.
// ---------------------------------------------------------------------------

import { prisma, TX_OPTIONS, withBusyRetry } from './client.js';

/** What a sync knows about a work package. Optional fields are kept as-is on update. */
export interface TaskInput {
  id: string;
  projectKey: string;
  subject: string;
  status?: string;
  /** OpenProject's spentTime, in minutes. */
  spentMinutes?: number;
  /** estimatedTime, cached for display only. */
  estimatedMinutes?: number;
}

export interface StoredTask {
  id: string;
  projectKey: string;
  subject: string;
  status: string | null;
  spentMinutes: number | null;
  estimatedMinutes: number | null;
  syncedAt: Date | null;
}

/**
 * Upsert work packages by their OpenProject id, stamping syncedAt so a stale
 * cache is distinguishable from a fresh one. The update path only overwrites
 * fields the sync actually returned — an absent optional field keeps the
 * previously cached value rather than wiping it.
 */
export async function upsertTasks(tasks: readonly TaskInput[]): Promise<StoredTask[]> {
  if (tasks.length === 0) return [];
  // One transaction so a collision partway through the sweep's batch can be
  // retried without re-upserting what already landed.
  return withBusyRetry(() =>
    prisma.$transaction(async (tx) => {
      const out: StoredTask[] = [];
      for (const t of tasks) {
        const row = await tx.task.upsert({
          where: { id: t.id },
          update: {
            projectKey: t.projectKey,
            subject: t.subject,
            ...(t.status !== undefined ? { status: t.status } : {}),
            ...(t.spentMinutes !== undefined ? { spentMinutes: t.spentMinutes } : {}),
            ...(t.estimatedMinutes !== undefined ? { estimatedMinutes: t.estimatedMinutes } : {}),
            syncedAt: new Date(),
          },
          create: {
            id: t.id,
            projectKey: t.projectKey,
            subject: t.subject,
            status: t.status ?? null,
            spentMinutes: t.spentMinutes ?? null,
            estimatedMinutes: t.estimatedMinutes ?? null,
            syncedAt: new Date(),
          },
        });
        out.push(row);
      }
      return out;
    }, TX_OPTIONS),
  );
}

export async function listTasks(q: { projectKey?: string } = {}): Promise<StoredTask[]> {
  return prisma.task.findMany({
    where: q.projectKey ? { projectKey: q.projectKey } : {},
    orderBy: [{ projectKey: 'asc' }, { id: 'asc' }],
  });
}

export async function getTask(id: string): Promise<StoredTask | null> {
  return prisma.task.findUnique({ where: { id } });
}

/** Local minutes per task, split by status — the hours.db side of the ledger. */
export interface TaskMinutes {
  taskId: string;
  /** Not yet in the sheet — the "would be double-logged" bucket. */
  draftMinutes: number;
  draftEntries: number;
  approvedMinutes: number;
  approvedEntries: number;
  /** Already appended to the sheet. */
  pushedMinutes: number;
  pushedEntries: number;
}

/**
 * Sum every entry's minutes grouped by taskId and status, in one query. The
 * tool chain reports pushed and not-yet-pushed separately; the caller folds
 * approved into whichever bucket its question cares about. Tasks with no
 * local minutes at all don't appear here.
 */
export async function listTaskMinutes(): Promise<TaskMinutes[]> {
  const groups = await prisma.entry.groupBy({
    by: ['taskId', 'status'],
    where: { taskId: { not: null } },
    _sum: { minutes: true },
    _count: { minutes: true },
  });

  const byTask = new Map<string, TaskMinutes>();
  for (const g of groups) {
    // The where clause already excludes nulls; the check exists because the
    // grouped type still says nullable.
    if (g.taskId === null) continue;
    const row = byTask.get(g.taskId) ?? {
      taskId: g.taskId,
      draftMinutes: 0,
      draftEntries: 0,
      approvedMinutes: 0,
      approvedEntries: 0,
      pushedMinutes: 0,
      pushedEntries: 0,
    };
    const minutes = g._sum.minutes ?? 0;
    const entries = g._count.minutes;
    if (g.status === 'draft') {
      row.draftMinutes += minutes;
      row.draftEntries += entries;
    } else if (g.status === 'approved') {
      row.approvedMinutes += minutes;
      row.approvedEntries += entries;
    } else if (g.status === 'pushed') {
      row.pushedMinutes += minutes;
      row.pushedEntries += entries;
    }
    byTask.set(g.taskId, row);
  }

  return [...byTask.values()].sort((a, b) => a.taskId.localeCompare(b.taskId));
}
