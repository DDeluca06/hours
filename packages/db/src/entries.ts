// ---------------------------------------------------------------------------
// Entry persistence.
//
// The status transition is one-directional and enforced here rather than by the
// callers: draft → approved → pushed. A pushed entry is immutable, because the
// row it corresponds to is already sitting in a shared spreadsheet and editing
// the local copy would quietly desynchronize the two.
// ---------------------------------------------------------------------------

import type { ClockRange, Entry, EntryStatus } from '@hours/core';
import { prisma } from './client.js';
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
    sheetRange: r.sheetRange,
    pushedAt: r.pushedAt,
  };
}

export async function createEntries(entries: readonly Entry[]): Promise<StoredEntry[]> {
  const out: StoredEntry[] = [];
  for (const e of entries) {
    const row = await prisma.entry.create({
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
      },
    });
    out.push(toStored(row));
  }
  return out;
}

export interface EntryQuery {
  day?: string;
  /** Inclusive range, YYYY-MM-DD. Ignored when `day` is set. */
  fromDay?: string;
  toDay?: string;
  projectKey?: string;
  status?: EntryStatus | EntryStatus[];
  person?: string;
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
}

export async function updateEntry(id: string, patch: EntryPatch): Promise<StoredEntry> {
  const existing = await prisma.entry.findUnique({ where: { id } });
  if (!existing) throw new Error(`no entry ${id}`);
  if (existing.status === 'pushed') {
    throw new Error(
      `entry ${id} is already in the sheet — edit the sheet row directly, or the two will disagree`,
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

  const row = await prisma.entry.update({ where: { id }, data });
  return toStored(row);
}

export async function approveEntries(ids: readonly string[]): Promise<number> {
  const result = await prisma.entry.updateMany({
    where: { id: { in: [...ids] }, status: 'draft' },
    data: { status: 'approved' },
  });
  return result.count;
}

/** Send an approved entry back to draft. Pushed entries are untouched. */
export async function unapproveEntries(ids: readonly string[]): Promise<number> {
  const result = await prisma.entry.updateMany({
    where: { id: { in: [...ids] }, status: 'approved' },
    data: { status: 'draft' },
  });
  return result.count;
}

export async function markPushed(
  ids: readonly string[],
  sheetRange: string,
): Promise<number> {
  const result = await prisma.entry.updateMany({
    where: { id: { in: [...ids] } },
    data: { status: 'pushed', sheetRange, pushedAt: new Date() },
  });
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
  await prisma.entry.delete({ where: { id } });
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
}): Promise<void> {
  await prisma.pushLog.create({
    data: {
      projectKey: args.projectKey,
      sheetTab: args.sheetTab,
      rowCount: args.entryIds.length,
      minutes: args.minutes,
      ok: args.ok,
      error: args.error ?? null,
      entryIds: JSON.stringify(args.entryIds),
    },
  });
}

/** Total pushed hours for a project, for contract-ceiling checks. */
export async function pushedHours(projectKey: string): Promise<number> {
  const agg = await prisma.entry.aggregate({
    where: { projectKey, status: 'pushed' },
    _sum: { minutes: true },
  });
  return (agg._sum.minutes ?? 0) / 60;
}
