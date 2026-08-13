// ---------------------------------------------------------------------------
// Work packages (a.k.a. tasks).
//
// A task is an OpenProject work package; task ids are its numeric ids as
// strings (the cache model stores them as strings, e.g. "136"). Both list and
// single-resource representations carry spentTime/estimatedTime/remainingTime
// as ISO-8601 durations when the API user may see time entries — the list
// endpoint embeds them on some instances and omits them on others, so list
// results treat a missing field as null rather than failing. A per-package
// getWorkPackage is always available when the list lacks them.
// ---------------------------------------------------------------------------

import { getJson, type OpenProjectConnection } from './client.js';
import { parseIsoDurationToMinutes } from './duration.js';

/** One work package, enough for the task-hours cache. */
export interface WorkPackageSummary {
  id: string;
  subject: string;
  status: string | null;
  /** spentTime in whole minutes; null when the field is absent or unparseable. */
  spentMinutes: number | null;
  estimatedMinutes: number | null;
}

/** The full resource: the summary plus remainingTime and project context. */
export interface WorkPackageDetail extends WorkPackageSummary {
  remainingMinutes: number | null;
  /** OpenProject project identifier, e.g. "north10-ai", when the link is present. */
  projectIdentifier: string | null;
  type: string | null;
}

export interface ListWorkPackagesOptions {
  url: string;
  apiKey: string;
  /** OpenProject project identifier, e.g. "north10-ai". */
  projectIdentifier: string;
  /** Rows per request, 1–200, default 200 (the API's maximum). Every page is fetched. */
  pageSize?: number;
}

/**
 * Hard stop on the page loop. At the default page size this is 20 000 work
 * packages — far past any project here, and the only thing standing between a
 * server that reports a wrong `total` and an endless sweep.
 */
const MAX_PAGES = 100;

export interface GetWorkPackageOptions {
  url: string;
  apiKey: string;
  /** Numeric work package id, e.g. "136". */
  id: string | number;
}

/**
 * List every work package in one project, newest-id last.
 *
 * Pages until the collection is exhausted rather than returning the first page:
 * a task missing from the cache is indistinguishable from a task that does not
 * exist — `hours log --task <id>` refuses it outright — so a project with more
 * than `pageSize` work packages would silently lose its tail.
 */
export async function listWorkPackages(opts: ListWorkPackagesOptions): Promise<WorkPackageSummary[]> {
  const pageSize = pageSizeArg(opts.pageSize);
  const conn: OpenProjectConnection = { url: opts.url, apiKey: opts.apiKey };
  const base = `/api/v3/projects/${encodeURIComponent(opts.projectIdentifier)}/work_packages`;

  const out: WorkPackageSummary[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const data = await getJson(conn, `${base}?pageSize=${pageSize}&offset=${page}`);
    const elements = elementsOf(data);
    out.push(...elements.map(summaryOf));

    // Stop on a short or empty page — that is the last one regardless of what
    // `total` claims. `total` only shortens the loop when it is trustworthy.
    if (elements.length < pageSize) break;
    const total = totalOf(data);
    if (total !== null && out.length >= total) break;
  }
  return out;
}

/** Fetch one work package in full detail, including parsed time aggregates. */
export async function getWorkPackage(opts: GetWorkPackageOptions): Promise<WorkPackageDetail> {
  const conn: OpenProjectConnection = { url: opts.url, apiKey: opts.apiKey };
  const data = await getJson(conn, `/api/v3/work_packages/${String(opts.id)}`);
  return detailOf(data);
}

// ---------------------------------------------------------------------------
// Mapping helpers. The API shape is not typed, so every field is pulled out
// defensively and non-conforming values collapse to null rather than throwing.
// ---------------------------------------------------------------------------

function pageSizeArg(pageSize: number | undefined): number {
  if (pageSize === undefined) return 200;
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 200) {
    throw new RangeError(`pageSize must be an integer in 1..200, got ${JSON.stringify(pageSize)}`);
  }
  return pageSize;
}

interface RawCollection {
  _embedded?: { elements?: unknown[] };
  total?: unknown;
}

/** The collection's reported size, or null when the field is absent or junk. */
function totalOf(data: unknown): number | null {
  const total = (data as RawCollection | null)?.total;
  return typeof total === 'number' && Number.isFinite(total) && total >= 0 ? total : null;
}

function elementsOf(data: unknown): unknown[] {
  const coll = data as RawCollection | null;
  if (!coll || !Array.isArray(coll._embedded?.elements)) return [];
  return coll._embedded.elements;
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

function idOf(w: Record<string, unknown> | null): string | null {
  const id = w?.id;
  if (typeof id === 'number' && Number.isInteger(id)) return String(id);
  if (typeof id === 'string' && /^\d+$/.test(id)) return id;
  return null;
}

function statusOf(w: Record<string, unknown> | null): string | null {
  const links = w?._links as Record<string, unknown> | undefined;
  const status = links?.status as Record<string, unknown> | undefined;
  return str(status?.title);
}

function projectIdentifierOf(w: Record<string, unknown> | null): string | null {
  const links = w?._links as Record<string, unknown> | undefined;
  const project = links?.project as Record<string, unknown> | undefined;
  const href = str(project?.href);
  if (!href) return null;
  const segment = href.split('/').filter(Boolean).pop();
  return segment ?? null;
}

function summaryOf(raw: unknown): WorkPackageSummary {
  const w = raw as Record<string, unknown> | null;
  const id = idOf(w);
  return {
    id: id ?? '',
    subject: str(w?.subject) ?? '',
    status: statusOf(w),
    spentMinutes: parseIsoDurationToMinutes(str(w?.spentTime)),
    estimatedMinutes: parseIsoDurationToMinutes(str(w?.estimatedTime)),
  };
}

function detailOf(raw: unknown): WorkPackageDetail {
  const w = raw as Record<string, unknown> | null;
  const base = summaryOf(raw);
  const links = w?._links as Record<string, unknown> | undefined;
  const type = links?.type as Record<string, unknown> | undefined;
  return {
    ...base,
    remainingMinutes: parseIsoDurationToMinutes(str(w?.remainingTime)),
    projectIdentifier: projectIdentifierOf(w),
    type: str(type?.title),
  };
}
