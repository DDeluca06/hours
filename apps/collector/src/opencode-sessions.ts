// ---------------------------------------------------------------------------
// OpenCode sessions as a signal source.
//
// OpenCode 1.18+ keeps its sessions and messages in a SQLite database at
// ~/.local/share/opencode/opencode.db: `session_v2` holds one row per session
// (directory, title, time_updated), `session_message` one row per message with
// the message JSON in `data`. An assistant message records both
// `data.time.created` and `data.time.completed` — a measured turn duration
// handed to us directly, better evidence than any other source here, Claude
// Code included, where the end has to be reconstructed from the timestamp of
// the last line written.
//
// Versions before 1.18 kept one JSON file per message under
// ~/.local/share/opencode/storage/message/<sessionID>/<messageID>.json with the
// same shape inside. The legacy reader is kept as the fallback for machines
// still on those versions: a missing database is a normal case, not an error.
//
// Attribution comes from the message's `data.path.cwd`, falling back to the
// session's `path` and then its `directory`. Sessions are filtered by
// `time_updated` before their messages are read, so a sweep costs a handful of
// small queries rather than one per message ever written.
// ---------------------------------------------------------------------------

import { readdir, readFile, stat } from 'node:fs/promises';
import Database from 'better-sqlite3';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_MAX_SPAN_MIN,
  projectForPath,
  type ProjectDef,
  type Signal,
} from '@hours/core';

export const OPENCODE_STORAGE = join(homedir(), '.local', 'share', 'opencode', 'storage');
export const OPENCODE_DB = join(homedir(), '.local', 'share', 'opencode', 'opencode.db');

interface StoredSession {
  id?: string;
  directory?: string;
  title?: string;
  time?: { created?: number; updated?: number };
}

interface StoredMessage {
  id?: string;
  sessionID?: string;
  role?: string;
  time?: { created?: number; completed?: number };
  path?: { cwd?: string; root?: string };
}

/** One row of `session_v2`. */
interface DbSession {
  id: string;
  directory: string | null;
  path: string | null;
  title: string | null;
  time_updated: number | null;
}

/** One row of `session_message`. */
interface DbMessage {
  id: string;
  session_id: string;
  type: string;
  time_created: number | null;
  data: string | null;
}

function fileExists(path: string): Promise<boolean> {
  return stat(path)
    .then((s) => s.isFile())
    .catch(() => false);
}

/**
 * Rewrite another machine's home directory onto this one.
 *
 * OpenCode's database is routinely synced or restored between machines, and the
 * paths inside it are absolute. The real data this was built against is full of
 * `/home/demitridmili/...` on a box whose home is `/home/mili` — without this,
 * every one of those sessions lands unattributed and has to be assigned by hand
 * during review.
 *
 * Only the home segment is replaced, so the project-relative part still has to
 * match a registered repo path. A stranger's home would have to contain a
 * directory at exactly the same sub-path to be mis-attributed, and the review
 * step is what catches that.
 */
export function localizeHome(path: string): string {
  const home = homedir();
  if (path === home || path.startsWith(`${home}/`)) return path;
  const match = /^\/(?:home|Users)\/[^/]+(\/.*)?$/.exec(path);
  if (!match) return path;
  return `${home}${match[1] ?? ''}`;
}

async function readJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, 'utf-8')) as T;
  } catch {
    // Absent, unreadable, or half-written by a session running right now.
    return null;
  }
}

export interface CollectOpenCodeOptions {
  since: Date;
  projects: readonly ProjectDef[];
  /** Override the legacy JSON storage root. Tests only. */
  root?: string;
  /** Override the SQLite database path. Defaults to `OPENCODE_DB`. */
  dbPath?: string;
  /** Cap on a single turn's measured span. Defaults to `DEFAULT_MAX_SPAN_MIN`. */
  maxSpanMin?: number;
  /** Map a foreign home directory onto this one. Defaults to true. */
  remapHome?: boolean;
}

export async function collectOpenCodeSignals(
  opts: CollectOpenCodeOptions,
): Promise<Signal[]> {
  const dbPath = opts.dbPath ?? OPENCODE_DB;
  const maxSpanMin = opts.maxSpanMin ?? DEFAULT_MAX_SPAN_MIN;
  const remap = opts.remapHome ?? true;
  const sinceMs = opts.since.getTime();

  // Newer OpenCode writes everything to SQLite; older ones kept JSON files.
  // The database wins when both exist, because it is the store actually being
  // written — reading the dead tree would duplicate nothing (different
  // sourceIds) but would waste a sweep on months of stable rows.
  if (await fileExists(dbPath)) {
    try {
      return collectFromDb(opts, { dbPath, maxSpanMin, remap, sinceMs });
    } catch {
      // A half-written or foreign reader view of the db is a missing store:
      // the other sources stand alone.
      return [];
    }
  }
  return collectFromLegacyStorage(opts, { maxSpanMin, remap, sinceMs });
}

// ---------------------------------------------------------------------------
// SQLite store (OpenCode 1.18+)
// ---------------------------------------------------------------------------

function collectFromDb(
  opts: CollectOpenCodeOptions,
  cfg: { dbPath: string; maxSpanMin: number; remap: boolean; sinceMs: number },
): Signal[] {
  const { dbPath, maxSpanMin, remap, sinceMs } = cfg;

  // Read-only: this database belongs to a running OpenCode process, and the
  // collector must never write to another application's store.
  const db = new Database(dbPath, { readonly: true, fileMustExist: true, timeout: 5_000 });
  try {
    db.pragma('busy_timeout = 5000');
    // A pre-1.18 database has no `session_v2`; treat it as empty rather than
    // failing the whole sweep.
    const sessions = (db.prepare(
      `SELECT id, directory, path, title, time_updated
         FROM session_v2 WHERE time_updated >= ?`,
    ).all(sinceMs) as unknown as DbSession[]).filter((s) => s.id);

    if (sessions.length === 0) return [];

    const byId = new Map(sessions.map((s) => [s.id, s]));
    const messages = (db.prepare(
      `SELECT id, session_id, type, time_created, data
         FROM session_message WHERE time_created >= ?`,
    ).all(sinceMs) as unknown as DbMessage[]).filter((m) => m.id);

    const out: Signal[] = [];
    for (const msg of messages) {
      const session = byId.get(msg.session_id);
      // A message whose session row predates the window cannot be in it; the
      // session query is the cheap filter (same as the legacy reader).
      if (!session) continue;
      const created = typeof msg.time_created === 'number' ? msg.time_created : 0;
      if (created < sinceMs) continue;

      const parsed = parseMessageData(msg.data);
      if (!parsed) continue;
      const dataCreated = parsed.time?.created;
      const atMs = typeof dataCreated === 'number' ? dataCreated : created;
      if (atMs < sinceMs) continue;

      const at = new Date(atMs);
      // `path` is routinely an empty string in the DB (not null), so a plain
      // `??` chain would stop on it and drop the attribution the session's
      // `directory` carries. Pick the first non-empty candidate.
      const cwdPath =
        parsed.path?.cwd ?? [session.path, session.directory].find((p) => !!p?.trim()) ?? '';
      const cwd = cwdPath ? (remap ? localizeHome(cwdPath) : cwdPath) : '';
      const projectKey = cwd ? (projectForPath(cwd, opts.projects)?.key ?? null) : null;

      const signal: Signal = {
        sourceId: `opencode:${session.id}:${msg.id}`,
        kind: 'opencode_session',
        at,
        projectKey,
      };

      // Same convention as the legacy reader: the session title rides on the
      // prompts alone, not on the far more numerous assistant messages.
      if (msg.type === 'user') {
        const title = (session.title ?? '').trim();
        if (title) signal.subject = title;
      }

      const completed = parsed.time?.completed;
      if (typeof completed === 'number' && completed > atMs) {
        signal.until = new Date(Math.min(completed, atMs + maxSpanMin * 60_000));
      }

      out.push(signal);
    }
    return out;
  } finally {
    db.close();
  }
}

function parseMessageData(data: string | null): StoredMessage | null {
  if (!data) return null;
  try {
    const parsed = JSON.parse(data) as { time?: unknown; path?: unknown };
    if (parsed && typeof parsed === 'object') return parsed as StoredMessage;
  } catch {
    // Half-written while the session is running right now.
  }
  return null;
}

// ---------------------------------------------------------------------------
// Legacy JSON store (OpenCode < 1.18)
// ---------------------------------------------------------------------------

async function collectFromLegacyStorage(
  opts: CollectOpenCodeOptions,
  cfg: { maxSpanMin: number; remap: boolean; sinceMs: number },
): Promise<Signal[]> {
  const root = opts.root ?? OPENCODE_STORAGE;
  const { maxSpanMin, remap, sinceMs } = cfg;

  const sessionRoot = join(root, 'session');
  let groups: string[];
  try {
    groups = await readdir(sessionRoot);
  } catch {
    // OpenCode has never run on this machine; the other sources stand alone.
    return [];
  }

  const out: Signal[] = [];
  for (const group of groups) {
    let files: string[];
    try {
      files = (await readdir(join(sessionRoot, group))).filter((f) => f.endsWith('.json'));
    } catch {
      continue;
    }

    for (const file of files) {
      const session = await readJson<StoredSession>(join(sessionRoot, group, file));
      if (!session?.id) continue;
      // `updated` moves with the last message, so a session untouched inside the
      // window cannot hold a message inside it either.
      if ((session.time?.updated ?? 0) < sinceMs) continue;

      out.push(
        ...(await collectLegacySession(root, session, opts.projects, { maxSpanMin, remap, sinceMs })),
      );
    }
  }

  return out;
}

async function collectLegacySession(
  root: string,
  session: StoredSession,
  projects: readonly ProjectDef[],
  cfg: { maxSpanMin: number; remap: boolean; sinceMs: number },
): Promise<Signal[]> {
  const dir = join(root, 'message', session.id as string);
  let files: string[];
  try {
    files = (await readdir(dir)).filter((f) => f.endsWith('.json'));
  } catch {
    // A session with no messages yet, or storage pruned underneath us.
    return [];
  }

  const sessionDir = session.directory
    ? cfg.remap
      ? localizeHome(session.directory)
      : session.directory
    : null;
  const fallbackKey = sessionDir ? (projectForPath(sessionDir, projects)?.key ?? null) : null;
  const title = (session.title ?? '').trim();

  const signals: Signal[] = [];
  for (const file of files) {
    const msg = await readJson<StoredMessage>(join(dir, file));
    if (!msg?.id) continue;
    const created = msg.time?.created;
    if (typeof created !== 'number' || created < cfg.sinceMs) continue;

    const at = new Date(created);
    const cwd = msg.path?.cwd;
    const resolved = cwd ? (cfg.remap ? localizeHome(cwd) : cwd) : null;
    const projectKey = resolved ? (projectForPath(resolved, projects)?.key ?? null) : fallbackKey;

    const signal: Signal = {
      sourceId: `opencode:${session.id as string}:${msg.id}`,
      kind: 'opencode_session',
      at,
      projectKey,
    };

    // The session title is OpenCode's own summary of the work and is the only
    // description available without opening every `part/` file. Carried on the
    // prompts alone: assistant messages are numerous and would store the same
    // string hundreds of times for a Notes line that dedupes it anyway.
    if (msg.role === 'user' && title) signal.subject = title;

    const completed = msg.time?.completed;
    if (typeof completed === 'number' && completed > created) {
      signal.until = new Date(Math.min(completed, created + cfg.maxSpanMin * 60_000));
    }

    signals.push(signal);
  }

  return signals;
}

/** Whether this machine has any OpenCode store worth sweeping. */
export async function hasOpenCodeStorage(
  root = OPENCODE_STORAGE,
  dbPath = OPENCODE_DB,
): Promise<boolean> {
  if (await fileExists(dbPath)) return true;
  try {
    return (await stat(join(root, 'session'))).isDirectory();
  } catch {
    return false;
  }
}