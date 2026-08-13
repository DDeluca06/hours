// ---------------------------------------------------------------------------
// Time entries.
//
// Answers "does task #136 have hours" straight from OpenProject: list the
// logged time against one work package and sum it — and, on the write path,
// log time against one (createTimeEntry). Hours travel as ISO-8601 durations
// ("PT45M"), parsed here into whole minutes so the caller never does duration
// arithmetic. A comment is optional, so it is null rather than "".
//
// Filter syntax mirrors ~/Projects/OpenProject/server.mjs, which is the
// working reference against projects.liftofflearning.tech: the filter key is
// `entity`, not `work_package_id` — TimeEntry was generalised to attach to
// meetings too, and the old filter name no longer exists on modern instances.
// ---------------------------------------------------------------------------

import { getJson, OPENPROJECT_TIMEOUT_MS, OpenProjectError, type OpenProjectConnection } from './client.js';
import { parseIsoDurationToMinutes } from './duration.js';

/** One logged time entry against a work package. */
export interface TimeEntry {
  id: string;
  /** This entry's hours in whole minutes. 0 when the duration is unparseable. */
  hoursMinutes: number;
  /** YYYY-MM-DD, or null when the entry carries no date. */
  spentOn: string | null;
  comment: string | null;
}

export interface TimeEntryList {
  entries: TimeEntry[];
  /** Sum of the entries' whole minutes. */
  totalMinutes: number;
  /**
   * Present only when an entry's hours failed to parse — those entries count
   * as 0 minutes above, so the anomaly is surfaced rather than swallowed.
   */
  parseWarnings?: number;
}

export interface ListTimeEntriesOptions {
  url: string;
  apiKey: string;
  /** Numeric work package id to filter on, e.g. "136". */
  workPackage: string | number;
  /** 1–200, default 200 (the API's maximum). */
  pageSize?: number;
}

/** A single APIv3 filter: { filterName: { operator, values } }. */
export interface OpenProjectFilter {
  [name: string]: { operator: string; values: string[] };
}

/** The filter array that scopes time entries to one work package. Exported for tests. */
export function workPackageTimeFilters(workPackage: string | number): OpenProjectFilter[] {
  return [{ entity: { operator: '=', values: [String(workPackage)] } }];
}

/** List the time entries logged against a work package, newest first. */
export async function listTimeEntries(opts: ListTimeEntriesOptions): Promise<TimeEntryList> {
  const conn: OpenProjectConnection = { url: opts.url, apiKey: opts.apiKey };
  const pageSize = pageSizeArg(opts.pageSize);

  const qs = new URLSearchParams({ pageSize: String(pageSize) });
  qs.set('filters', JSON.stringify(workPackageTimeFilters(opts.workPackage)));
  const data = await getJson(conn, `/api/v3/time_entries?${qs.toString()}`);

  const entries: TimeEntry[] = [];
  let parseWarnings = 0;
  for (const raw of elementsOf(data)) {
    const e = raw as Record<string, unknown> | null;
    const minutes = parseIsoDurationToMinutes(str(e?.hours));
    if (minutes === null) parseWarnings += 1;
    entries.push({
      id: idOf(e) ?? '',
      hoursMinutes: minutes ?? 0,
      spentOn: str(e?.spentOn),
      comment: commentOf(e),
    });
  }

  const totalMinutes = entries.reduce((sum, e) => sum + e.hoursMinutes, 0);
  return {
    entries,
    totalMinutes,
    ...(parseWarnings > 0 ? { parseWarnings } : {}),
  };
}

function pageSizeArg(pageSize: number | undefined): number {
  if (pageSize === undefined) return 200;
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 200) {
    throw new RangeError(`pageSize must be an integer in 1..200, got ${JSON.stringify(pageSize)}`);
  }
  return pageSize;
}

interface RawCollection {
  _embedded?: { elements?: unknown[] };
}

function elementsOf(data: unknown): unknown[] {
  const coll = data as RawCollection | null;
  if (!coll || !Array.isArray(coll._embedded?.elements)) return [];
  return coll._embedded.elements;
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

function idOf(e: Record<string, unknown> | null): string | null {
  const id = e?.id;
  if (typeof id === 'number' && Number.isInteger(id)) return String(id);
  if (typeof id === 'string' && /^\d+$/.test(id)) return id;
  return null;
}

function commentOf(e: Record<string, unknown> | null): string | null {
  const comment = e?.comment as Record<string, unknown> | undefined;
  return str(comment?.raw);
}

/**
 * Whole minutes → ISO-8601 duration for OpenProject's `hours` field
 * ("PT1H30M") — the inverse of parseIsoDurationToMinutes. Fractional or
 * negative minutes are refused rather than rounded: a non-integer here is a
 * caller bug, not data to massage, and whole minutes round-trip exactly.
 */
export function minutesToIsoDuration(minutes: number): string {
  if (!Number.isInteger(minutes) || minutes < 0) {
    throw new RangeError(`minutes must be a non-negative integer, got ${JSON.stringify(minutes)}`);
  }
  if (minutes === 0) return 'PT0S';
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return `PT${hours > 0 ? `${hours}H` : ''}${rest > 0 ? `${rest}M` : ''}`;
}

export interface CreateTimeEntryOptions {
  url: string;
  apiKey: string;
  /** Numeric work package id the minutes are logged against, e.g. "136". */
  workPackage: string | number;
  /** Whole minutes, converted to an ISO-8601 duration on the wire. */
  minutes: number;
  /** YYYY-MM-DD the entry is booked on. */
  spentOn: string;
  /** Free text comment, sent as markdown. */
  comment?: string;
}

/**
 * Log time against a work package.
 *
 * `?notify=false` keeps the write silent: no notification spam for every
 * logged interval. The comment is optional, so it is omitted entirely rather
 * than sent empty — OpenProject renders an empty markdown comment as noise.
 */
export async function createTimeEntry(args: CreateTimeEntryOptions): Promise<{ id: string }> {
  const conn: OpenProjectConnection = { url: args.url, apiKey: args.apiKey };
  const body: CreateTimeEntryBody = {
    hours: minutesToIsoDuration(args.minutes),
    spentOn: args.spentOn,
    ...(args.comment !== undefined
      ? { comment: { format: 'markdown' as const, raw: args.comment } }
      : {}),
    _links: { workPackage: { href: `/api/v3/work_packages/${String(args.workPackage)}` } },
  };

  const data = await postJson(conn, '/api/v3/time_entries?notify=false', body);
  const id = idOf(data as Record<string, unknown> | null);
  if (!id) {
    throw new OpenProjectError(
      'OpenProject created the time entry but the response carried no id',
      0,
      JSON.stringify(data).slice(0, BODY_SNIPPET_MAX),
    );
  }
  return { id };
}

interface CreateTimeEntryBody {
  hours: string;
  spentOn: string;
  comment?: { format: 'markdown'; raw: string };
  _links: { workPackage: { href: string } };
}

const BODY_SNIPPET_MAX = 500;

/**
 * POST `path` with a JSON body, returning the parsed 2xx response.
 *
 * A local twin of client.ts's getJson (which is GET-only), sharing its auth
 * header and failure shape — duplicated deliberately so client.ts's exported
 * surface stays unchanged while the connector stays read-mostly elsewhere.
 */
async function postJson(conn: OpenProjectConnection, path: string, body: unknown): Promise<unknown> {
  const base = conn.url.replace(/\/+$/, '');
  const href = `${base}${path.startsWith('/') ? path : `/${path}`}`;

  let res: Response;
  try {
    res = await fetch(href, {
      method: 'POST',
      headers: {
        // OpenProject APIv3 keys authenticate as HTTP Basic, user "apikey".
        Authorization: `Basic ${Buffer.from(`apikey:${conn.apiKey}`).toString('base64')}`,
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(OPENPROJECT_TIMEOUT_MS),
    });
  } catch (err) {
    throw transportError(err);
  }

  const text = await res.text();
  if (!res.ok) {
    throw new OpenProjectError(
      `OpenProject ${res.status} ${res.statusText}: ${errorDetail(text, res.statusText)}`,
      res.status,
      text.slice(0, BODY_SNIPPET_MAX),
    );
  }
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    // A 2xx with a non-JSON body is a server bug, not a network hiccup.
    throw new OpenProjectError(
      `OpenProject returned a non-JSON body for ${path}`,
      res.status,
      text.slice(0, BODY_SNIPPET_MAX),
    );
  }
}

function transportError(err: unknown): OpenProjectError {
  const name = typeof err === 'object' && err !== null ? (err as { name?: unknown }).name : undefined;
  if (name === 'TimeoutError') {
    return new OpenProjectError(`OpenProject request timed out after ${OPENPROJECT_TIMEOUT_MS}ms`, 0, '');
  }
  const detail = err instanceof Error ? err.message : String(err);
  return new OpenProjectError(`OpenProject network error: ${detail}`, 0, '');
}

/** Pull a human-readable message out of an OpenProject error body. */
function errorDetail(text: string, statusText: string): string {
  try {
    const parsed = JSON.parse(text) as {
      message?: unknown;
      _embedded?: { errors?: Array<{ message?: unknown }> };
    };
    const embedded = parsed._embedded?.errors
      ?.map((e) => e.message)
      .filter((m): m is string => typeof m === 'string')
      .join('; ');
    if (embedded) return embedded;
    if (typeof parsed.message === 'string' && parsed.message) return parsed.message;
  } catch {
    // Non-JSON error body — fall through to the snippet.
  }
  return text ? text.slice(0, BODY_SNIPPET_MAX) : statusText;
}
