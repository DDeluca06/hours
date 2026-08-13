// ---------------------------------------------------------------------------
// OpenCode sessions as a signal source.
//
// OpenCode keeps one JSON file per message under
// ~/.local/share/opencode/storage/message/<sessionID>/<messageID>.json, and an
// assistant message records both `time.created` and `time.completed`. That is a
// measured turn duration handed to us directly — better evidence than any other
// source here, Claude Code included, where the end has to be reconstructed from
// the timestamp of the last line written.
//
// Attribution comes from the assistant message's `path.cwd`, falling back to the
// session's `directory`. Sessions are filtered by `time.updated` before their
// message directory is opened, so a sweep costs a handful of small reads rather
// than one per message ever written.
// ---------------------------------------------------------------------------

import { readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_MAX_SPAN_MIN,
  projectForPath,
  type ProjectDef,
  type Signal,
} from '@hours/core';

export const OPENCODE_STORAGE = join(homedir(), '.local', 'share', 'opencode', 'storage');

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

/**
 * Rewrite another machine's home directory onto this one.
 *
 * OpenCode's storage directory is routinely synced or restored between machines,
 * and the paths inside it are absolute. The real data this was built against is
 * full of `/home/demitridmili/...` on a box whose home is `/home/mili` — without
 * this, every one of those sessions lands unattributed and has to be assigned by
 * hand during review.
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
  /** Override the storage root. Tests only. */
  root?: string;
  /** Cap on a single turn's measured span. Defaults to `DEFAULT_MAX_SPAN_MIN`. */
  maxSpanMin?: number;
  /** Map a foreign home directory onto this one. Defaults to true. */
  remapHome?: boolean;
}

export async function collectOpenCodeSignals(
  opts: CollectOpenCodeOptions,
): Promise<Signal[]> {
  const root = opts.root ?? OPENCODE_STORAGE;
  const maxSpanMin = opts.maxSpanMin ?? DEFAULT_MAX_SPAN_MIN;
  const remap = opts.remapHome ?? true;
  const sinceMs = opts.since.getTime();

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

      out.push(...(await collectSession(root, session, opts.projects, { maxSpanMin, remap, sinceMs })));
    }
  }

  return out;
}

async function collectSession(
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

/** Whether this machine has any OpenCode storage worth sweeping. */
export async function hasOpenCodeStorage(root = OPENCODE_STORAGE): Promise<boolean> {
  try {
    return (await stat(join(root, 'session'))).isDirectory();
  } catch {
    return false;
  }
}
