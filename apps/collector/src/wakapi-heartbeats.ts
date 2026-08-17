// ---------------------------------------------------------------------------
// WakaTime heartbeats from a self-hosted Wakapi server as a signal source.
//
// The WakaTime VSCode extension (wakatime.vscode-wakatime) sends a heartbeat on
// every file edit; Wakapi (ghcr.io/muety/wakapi) stores them. Reading them back
// is denser than the editor's own save history (editor-history.ts sees one save,
// Wakapi sees every edit), and — unlike a save — a heartbeat is *presence*, not
// a trailing edge: consecutive heartbeats prove the keyboard was being used
// between them. That is a measured span, so it goes on the signal the same way
// an agent turn's does, and the lead-in guess is skipped where the span is known.
//
// The collapse matters as much as the source. A session of active typing emits
// a heartbeat every few seconds, and one signal per heartbeat would flood the
// store with thousands of near-identical rows whose summed weight drowns every
// commit in the apportionment — the exact "counting tool results" failure
// claude-sessions.ts documents. So heartbeats are folded into *stretches*:
// consecutive heartbeats whose gaps stay under `WAKAPI_RUN_GAP_MIN` are one
// signal from the first heartbeat to the last. That is wakatime's own session
// model (its timeout is 15 minutes; 10 is deliberately conservative).
//
// Segment identity is what makes this source idempotent, and it is the thing
// most easily got wrong. A segment's sourceId is its *first* heartbeat, so that
// first heartbeat must not depend on when the sweep happened to run. The window
// is therefore applied twice, in this order:
//
//   1. Segment the whole fetched day — every heartbeat, ignoring `since`.
//   2. Drop the segments that ended before `since`.
//
// Filtering heartbeats by `since` *before* segmenting (the obvious way, and the
// way this file first did it) puts the anchor wherever the rolling window cut:
// a 09:00–11:00 typing session became `…:<09:30>` at the 10:00 sweep, `…:<09:40>`
// at 10:10, `…:<09:50>` at 10:20 — a dozen overlapping "measured" signals for
// one session, none of them dedupable, each one crowding real commits out of
// the apportionment. The fetch also reaches one calendar day further back than
// `since` for the same reason: a run that crosses midnight has to be anchored
// at the heartbeat it actually started on.
//
// The segment end only ever grows while the run is open, which
// `recordSignalSpans` already exists to carry forward, exactly as it does for
// agent turns. The span cap splits forward-only for the same reason: an
// already-emitted segment's end must never move backwards, or the stored signal
// (which never shrinks) would overlap the piece that took its minutes.
//
// Three honest limitations:
//   - The compat endpoint queries one day at a time in the account's timezone,
//     so a machine in a different timezone than the wakapi account can place a
//     midnight-boundary heartbeat on the neighbouring day. Review catches it.
//   - Only `is_write` file heartbeats are taken. Heartbeats sent on window
//     focus or file open are presence of a sort, but they are exactly the
//     phantom activity that would bill a parked editor, so they stay out.
//   - Heartbeat history is *not* strictly append-only. wakatime-cli buffers
//     heartbeats while offline and flushes them later via `heartbeats.bulk`, so
//     a heartbeat genuinely can arrive with a timestamp inside a gap an earlier
//     fetch already observed. That re-anchors the segment it lands in — a new
//     sourceId for work whose earlier signal may already be consumed. Nothing
//     here can prevent it (the anchor is the run's start, and the run's start
//     moved), so the sweep detects it instead: `findConsumedSpanOverlaps`
//     reports a fresh signal whose span covers already-consumed evidence, and
//     the apportionment in packages/core keeps it from being billed twice.
// ---------------------------------------------------------------------------

import { DEFAULT_MAX_SPAN_MIN, projectForPath, type ProjectDef, type Signal } from '@hours/core';

/** Hard timeout per day-fetch, so a dead server stalls the sweep, never hangs it. */
export const WAKAPI_TIMEOUT_MS = 10_000;

/**
 * Longest gap between consecutive heartbeats that still counts as one stretch
 * of work. Wakatime's own session timeout is 15 minutes; 10 is conservative —
 * under-reporting is a review nudge, over-reporting is a billing problem.
 */
export const WAKAPI_RUN_GAP_MIN = 10;

/**
 * Cap on the unique paths one signal carries. Paths feed activity
 * classification; a 3-hour session can touch a hundred files, and the first
 * dozen say what the work was as well as the last dozen do.
 */
const MAX_PATHS = 25;

/** A raw heartbeat as the compat endpoint returns it. All fields optional: the server tolerates leniently. */
export interface WakapiHeartbeat {
  entity?: unknown;
  /** Wakapi's own JSON name for the entity type. */
  entity_type?: unknown;
  /** wakatime.com's name for the same field — the API is served by both. */
  type?: unknown;
  /** Unix seconds, fractional. */
  time?: unknown;
  is_write?: unknown;
  /** Per-install id of the wakatime-cli that sent the heartbeat. */
  machine_name_id?: unknown;
}

export interface WakapiConnection {
  /** Base URL, e.g. http://127.0.0.1:3001. Trailing slash tolerated. */
  url: string;
  /** Per-account API key from the wakapi settings page. */
  apiKey: string;
}

/**
 * The file a heartbeat is about, or null when the entity is not a real file.
 *
 * File heartbeats carry an absolute path; everything else (domain, app, url,
 * an unsaved `untitled:` buffer) must not become a work signal.
 */
export function heartbeatEntity(hb: WakapiHeartbeat): string | null {
  if (typeof hb.entity !== 'string' || hb.entity === '') return null;
  let entity = hb.entity;
  if (entity.startsWith('file://')) entity = entity.slice('file://'.length);
  return entity.startsWith('/') ? entity : null;
}

/** Heartbeat timestamp as an epoch-millisecond number, or null when unusable. */
export function heartbeatMs(hb: WakapiHeartbeat): number | null {
  if (typeof hb.time !== 'number' || !Number.isFinite(hb.time)) return null;
  // Heartbeats carry fractional seconds; millisecond precision keeps the
  // sourceId unique without inventing precision the server did not give us.
  const ms = Math.round(hb.time * 1000);
  return ms > 0 ? ms : null;
}

/** The per-install machine id, for sourceIds that survive multi-machine servers. */
export function heartbeatMachine(hb: WakapiHeartbeat): string {
  return typeof hb.machine_name_id === 'string' && hb.machine_name_id ? hb.machine_name_id : 'anon';
}

function isFile(hb: WakapiHeartbeat): boolean {
  return hb.entity_type === 'file' || hb.type === 'file';
}

/** A heartbeat this source can actually use, with its two derived fields. */
export interface UsableHeartbeat {
  hb: WakapiHeartbeat;
  entity: string;
  ms: number;
}

/**
 * The heartbeats worth folding into signals, oldest first.
 *
 * Note what is *not* here: the `since` window. Windowing happens per segment,
 * after the fold — see the header comment. This is exported so the collector can
 * count what survived and warn when a server's field naming means nothing does.
 */
export function usableHeartbeats(heartbeats: readonly WakapiHeartbeat[]): UsableHeartbeat[] {
  const out: UsableHeartbeat[] = [];
  for (const hb of heartbeats) {
    const entity = heartbeatEntity(hb);
    const ms = heartbeatMs(hb);
    if (entity === null || ms === null) continue;
    if (!isFile(hb) || hb.is_write !== true) continue;
    out.push({ hb, entity, ms });
  }
  out.sort((a, b) => a.ms - b.ms);
  return out;
}

/** Why heartbeats were dropped, so "collected nothing" can say which predicate ate them. */
export interface HeartbeatDiagnosis {
  fetched: number;
  usable: number;
  /** Carried a usable absolute file path. */
  withPath: number;
  /** Declared itself a file in either the wakapi or the wakatime.com field name. */
  withFileType: number;
  /** Had `is_write === true` exactly. */
  withWrite: number;
}

export function diagnoseHeartbeats(heartbeats: readonly WakapiHeartbeat[]): HeartbeatDiagnosis {
  let withPath = 0;
  let withFileType = 0;
  let withWrite = 0;
  for (const hb of heartbeats) {
    if (heartbeatEntity(hb) !== null && heartbeatMs(hb) !== null) withPath++;
    if (isFile(hb)) withFileType++;
    if (hb.is_write === true) withWrite++;
  }
  return {
    fetched: heartbeats.length,
    usable: usableHeartbeats(heartbeats).length,
    withPath,
    withFileType,
    withWrite,
  };
}

/**
 * The warning for a fetch that returned heartbeats and kept none of them.
 *
 * This is the failure the source exists to catch, turned on itself: a server or
 * extension version that omits `is_write`, or names neither `entity_type` nor
 * `type`, drops 100% of heartbeats through a predicate that looks correct, and
 * the sweep then reports `wakapi=0` exactly as it would for a quiet afternoon.
 * Silence is the bug. Returns null when there is nothing to say.
 */
export function heartbeatShapeWarning(d: HeartbeatDiagnosis): string | null {
  if (d.fetched === 0 || d.usable > 0) return null;
  const causes: string[] = [];
  if (d.withWrite === 0) causes.push('none had is_write === true');
  if (d.withFileType === 0) causes.push('none declared entity_type/type "file"');
  if (d.withPath === 0) causes.push('none carried an absolute file path with a usable timestamp');
  const why = causes.length ? causes.join('; ') : 'no single field explains it';
  return `wakapi: fetched ${d.fetched} heartbeat(s) and could use none of them — ${why}. Check the wakapi and wakatime-cli versions; heartbeat collection is effectively off.`;
}

export interface HeartbeatsToSignalsOptions {
  since: Date;
  projects: readonly ProjectDef[];
  /**
   * Cap on a single signal's measured span. Defaults to `DEFAULT_MAX_SPAN_MIN`,
   * the same bound the agent-harness sources get.
   */
  maxSpanMin?: number;
}

/**
 * Collapse raw heartbeats into measured signals.
 *
 * Folds heartbeats into stretches (a gap over `WAKAPI_RUN_GAP_MIN` breaks a
 * run), splits each run per project so no signal claims another project's
 * minutes, splits again at `maxSpanMin` so no single signal claims a multi-hour
 * measured span, and only then drops the segments that ended before `since`. A
 * segment of one heartbeat is a point signal — presence at an instant, nothing
 * measured — and the lead-in applies; two or more are measured from the first
 * heartbeat to the last.
 *
 * A kept segment can begin before `since`: that is the point. Its start is the
 * heartbeat the run actually started on, which is what keeps its sourceId the
 * same across every sweep that sees it.
 */
export function heartbeatsToSignals(
  heartbeats: readonly WakapiHeartbeat[],
  opts: HeartbeatsToSignalsOptions,
): Signal[] {
  const sinceMs = opts.since.getTime();
  const maxSpanMs = (opts.maxSpanMin ?? DEFAULT_MAX_SPAN_MIN) * 60_000;
  const usable = usableHeartbeats(heartbeats);

  // One stretch per maximal run of heartbeats closer than the run gap.
  const runs: UsableHeartbeat[][] = [];
  for (const u of usable) {
    const lastRun = runs[runs.length - 1];
    const prev = lastRun ? lastRun[lastRun.length - 1] : undefined;
    if (lastRun && prev && u.ms - prev.ms <= WAKAPI_RUN_GAP_MIN * 60_000) {
      lastRun.push(u);
    } else {
      runs.push([u]);
    }
  }

  const out: Signal[] = [];
  for (const run of runs) {
    for (const byProject of splitByProject(run, opts.projects)) {
      for (const segment of splitBySpan(byProject, maxSpanMs)) {
        const last = segment[segment.length - 1];
        // Windowing is per segment and on its *end*: a run still in progress is
        // kept whole, a run that finished before the window is already in the
        // store from the sweep that saw it.
        if (!last || last.ms < sinceMs) continue;
        out.push(segmentSignal(segment, opts.projects));
      }
    }
  }
  return out;
}

/**
 * Contiguous per-project pieces of one run. A run can cross projects (repos are
 * opened side by side) and attribution is the one thing this source must never
 * guess.
 */
function splitByProject(
  run: readonly UsableHeartbeat[],
  projects: readonly ProjectDef[],
): UsableHeartbeat[][] {
  const out: UsableHeartbeat[][] = [];
  let segment: UsableHeartbeat[] = [];
  let segmentProject: string | null = null;
  for (const u of run) {
    const project = projectForPath(u.entity, projects)?.key ?? null;
    if (segment.length === 0) {
      segmentProject = project;
      segment.push(u);
    } else if (segmentProject === project) {
      segment.push(u);
    } else {
      out.push(segment);
      segment = [u];
      segmentProject = project;
    }
  }
  if (segment.length) out.push(segment);
  return out;
}

/**
 * Pieces of one segment, none spanning more than `maxSpanMs`.
 *
 * Greedy from the front, never from the back: each piece is decided entirely by
 * heartbeats at or before its own end, so a run that grows past the cap between
 * two sweeps extends into a *new* piece and leaves the earlier ones — and their
 * sourceIds and spans — untouched. Splitting at the longest internal gap would
 * read better and be wrong: it moves an already-stored segment's end backwards,
 * and `recordSignalSpans` only ever moves an end forward, so the stored signal
 * would keep minutes the new piece also claims.
 *
 * Unlike the harness sources, the overflow is not discarded. A heartbeat is
 * evidence the keyboard was in use at that moment, so a genuine six-hour session
 * is six hours of evidence; the cap bounds how much of it any one signal may
 * assert, not how much of the day was worked. What bounds *bridged idle* is
 * `WAKAPI_RUN_GAP_MIN`, and nothing else does.
 */
function splitBySpan(segment: readonly UsableHeartbeat[], maxSpanMs: number): UsableHeartbeat[][] {
  const out: UsableHeartbeat[][] = [];
  let piece: UsableHeartbeat[] = [];
  let startMs = 0;
  for (const u of segment) {
    if (piece.length === 0) {
      startMs = u.ms;
      piece.push(u);
    } else if (u.ms - startMs <= maxSpanMs) {
      piece.push(u);
    } else {
      out.push(piece);
      startMs = u.ms;
      piece = [u];
    }
  }
  if (piece.length) out.push(piece);
  return out;
}

function segmentSignal(segment: readonly UsableHeartbeat[], projects: readonly ProjectDef[]): Signal {
  const first = segment[0];
  const last = segment[segment.length - 1];
  // Unreachable by construction — callers only flush non-empty segments — but
  // the index type cannot know that, and this must never emit garbage.
  if (!first || !last) throw new Error('wakapi: empty heartbeat segment');
  const entity = first.entity;
  const project = projectForPath(entity, projects);
  const paths = [...new Set(segment.map((s) => describePath(s.entity, project)))].slice(0, MAX_PATHS);

  return {
    // The first heartbeat's machine, entity and timestamp. Stable across sweeps
    // because the fold runs over the whole fetched day and the window is applied
    // to segment *ends*, so the anchor does not depend on where the rolling
    // window cut. An offline bulk flush can still move it — see the header.
    sourceId: `wakapi:${heartbeatMachine(first.hb)}:${entity}:${first.ms}`,
    kind: 'heartbeat',
    at: new Date(first.ms),
    projectKey: project?.key ?? null,
    ...(last.ms > first.ms ? { until: new Date(last.ms) } : {}),
    paths,
  };
}

/** Repo-relative path when the file sits in a watched repo, else absolute. */
function describePath(absolute: string, project: ProjectDef | null): string {
  if (!project) return absolute;
  let best: string | null = null;
  for (const repo of project.repoPaths) {
    const r = repo.replace(/\/+$/, '');
    if (absolute === r || absolute.startsWith(`${r}/`)) {
      if (!best || r.length > best.length) best = r;
    }
  }
  return best ? absolute.slice(best.length + 1) : absolute;
}

/** Local calendar days from `since` (inclusive) to today (inclusive), YYYY-MM-DD. */
export function daysToFetch(since: Date, now: Date): string[] {
  const days: string[] = [];
  const cursor = new Date(since.getFullYear(), since.getMonth(), since.getDate());
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  while (cursor <= today) {
    const m = String(cursor.getMonth() + 1).padStart(2, '0');
    const d = String(cursor.getDate()).padStart(2, '0');
    days.push(`${cursor.getFullYear()}-${m}-${d}`);
    cursor.setDate(cursor.getDate() + 1);
  }
  return days;
}

/**
 * How long a day that is already over may be served from the in-process cache.
 *
 * The compat endpoint has no incremental parameter — every request returns a
 * whole day — so the daemon's 10-minute sweep otherwise re-downloads and
 * re-parses every day in its window ~144 times a day, for days whose heartbeats
 * finished changing hours ago. Today is never cached; it is the day heartbeats
 * are still arriving on.
 *
 * The TTL exists rather than caching past days forever because heartbeat history
 * is not append-only: an offline wakatime-cli flushes buffered heartbeats into
 * days already fetched (see the header). Half an hour is the longest such a
 * backfill stays invisible, traded against a 3x cut in past-day traffic.
 */
export const WAKAPI_PAST_DAY_TTL_MS = 30 * 60_000;

/**
 * The fetch reaches this far before `since` so a run that crosses midnight is
 * anchored at its true first heartbeat rather than at 00:00 — a whole day,
 * because that is the granularity the endpoint offers. Costs one request, and
 * the cache above absorbs it after the first sweep.
 */
const ANCHOR_PREROLL_MS = 24 * 60 * 60 * 1000;

/**
 * Per-day heartbeat cache for a long-lived collector process.
 *
 * Deliberately an object the caller owns rather than module state: a CLI `hours
 * collect` is a fresh process and should fetch everything, while the daemon
 * keeps one instance across sweeps. Tests construct their own.
 */
export class WakapiDayCache {
  private readonly days = new Map<string, { fetchedAtMs: number; heartbeats: WakapiHeartbeat[] }>();

  /** Cached heartbeats for `day` if they are younger than `ttlMs`, else null. */
  read(day: string, ttlMs: number, nowMs: number): WakapiHeartbeat[] | null {
    const hit = this.days.get(day);
    if (!hit) return null;
    if (nowMs - hit.fetchedAtMs > ttlMs) return null;
    return hit.heartbeats;
  }

  write(day: string, heartbeats: WakapiHeartbeat[], nowMs: number): void {
    this.days.set(day, { fetchedAtMs: nowMs, heartbeats });
  }

  /** Forget every day outside `keep`, so a daemon running for weeks stays bounded. */
  prune(keep: readonly string[]): void {
    const wanted = new Set(keep);
    for (const day of [...this.days.keys()]) {
      if (!wanted.has(day)) this.days.delete(day);
    }
  }
}

export interface CollectWakapiSignalsOptions extends HeartbeatsToSignalsOptions {
  url: string;
  apiKey: string;
  /** Injectable for tests. Defaults to the global fetch. */
  fetchFn?: typeof fetch;
  /** Reused across sweeps by the daemon; omitted, every day is fetched fresh. */
  cache?: WakapiDayCache;
  /** Injectable for tests. Defaults to now. */
  now?: Date;
}

export interface CollectWakapiResult {
  signals: Signal[];
  /**
   * Things the caller should say out loud. Separate from a thrown error: a fetch
   * that succeeds and yields nothing usable is not a transport failure, but it
   * is not a quiet afternoon either.
   */
  warnings: string[];
}

/**
 * Fetch one day's heartbeats from the wakatime-compatible endpoint.
 *
 * Throws on transport failure, timeout, or non-2xx — the caller (the sweep)
 * owns graceful degradation and turns it into a warning line.
 */
export async function fetchWakapiHeartbeats(
  conn: WakapiConnection,
  day: string,
  fetchFn: typeof fetch = fetch,
): Promise<WakapiHeartbeat[]> {
  const base = conn.url.replace(/\/+$/, '');
  const href = `${base}/api/compat/wakatime/v1/users/current/heartbeats?date=${day}`;

  let res: Response;
  try {
    res = await fetchFn(href, {
      method: 'GET',
      headers: {
        // Wakapi accepts the API key as Basic auth with the key alone encoded.
        Authorization: `Basic ${Buffer.from(conn.apiKey).toString('base64')}`,
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(WAKAPI_TIMEOUT_MS),
    });
  } catch (err) {
    const name = typeof err === 'object' && err !== null ? (err as { name?: unknown }).name : undefined;
    if (name === 'TimeoutError') {
      throw new Error(`wakapi request timed out after ${WAKAPI_TIMEOUT_MS}ms`, { cause: err });
    }
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`wakapi network error: ${detail}`, { cause: err });
  }

  if (!res.ok) {
    throw new Error(`wakapi ${res.status} ${res.statusText} for ${day}`);
  }

  const text = await res.text();
  if (!text) return [];
  try {
    const parsed = JSON.parse(text) as { data?: unknown };
    if (!Array.isArray(parsed.data)) return [];
    return parsed.data as WakapiHeartbeat[];
  } catch {
    throw new Error(`wakapi returned a non-JSON body for ${day}`);
  }
}

/**
 * Collect heartbeat signals from Wakapi, one request per local day since `since`.
 *
 * Days are fetched in parallel so a slow server costs one timeout, not three
 * in sequence. All-or-nothing: if any day fails the whole source reports empty
 * and the sweep warns — a half-day's signals would be a silent hole in a day
 * that looks complete.
 */
export async function collectWakapiSignals(
  opts: CollectWakapiSignalsOptions,
): Promise<CollectWakapiResult> {
  const now = opts.now ?? new Date();
  const nowMs = now.getTime();
  const today = daysToFetch(now, now)[0];
  // One day of preroll so a midnight-crossing run keeps its anchor.
  const days = daysToFetch(new Date(opts.since.getTime() - ANCHOR_PREROLL_MS), now);
  if (days.length === 0) return { signals: [], warnings: [] };

  const conn: WakapiConnection = { url: opts.url, apiKey: opts.apiKey };
  const fetched = await Promise.all(
    days.map(async (day) => {
      // Today always goes to the server; a finished day may come from cache.
      const ttlMs = day === today ? 0 : WAKAPI_PAST_DAY_TTL_MS;
      const cached = ttlMs > 0 ? opts.cache?.read(day, ttlMs, nowMs) : null;
      if (cached) return cached;
      const heartbeats = await fetchWakapiHeartbeats(conn, day, opts.fetchFn);
      opts.cache?.write(day, heartbeats, nowMs);
      return heartbeats;
    }),
  );
  opts.cache?.prune(days);

  const heartbeats = fetched.flat();
  const warnings: string[] = [];
  const shape = heartbeatShapeWarning(diagnoseHeartbeats(heartbeats));
  if (shape) warnings.push(shape);

  const signals = heartbeatsToSignals(heartbeats, {
    since: opts.since,
    projects: opts.projects,
    ...(opts.maxSpanMin !== undefined ? { maxSpanMin: opts.maxSpanMin } : {}),
  });
  return { signals, warnings };
}
