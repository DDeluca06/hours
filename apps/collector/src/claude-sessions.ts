// ---------------------------------------------------------------------------
// Claude Code sessions as a signal source.
//
// Commits are sparse — an hour of debugging that ends in one commit looks like
// fifteen minutes. Session transcripts fill that gap: every user turn is a
// timestamped, project-attributed heartbeat that you were working, and its text
// usually says what on.
//
// Transcripts live at ~/.claude/projects/<slug>/<sessionId>.jsonl, one JSON
// object per line. Each user turn carries `timestamp`, `cwd`, and `gitBranch`,
// which is everything needed: `cwd` maps to a project through the registry, so
// the slug encoding is never parsed.
//
// Read as a line stream rather than parsed whole — these files reach tens of
// megabytes, and only the user turns matter.
// ---------------------------------------------------------------------------

import { createReadStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { projectForPath, type ProjectDef, type Signal } from '@hours/core';

export const SESSIONS_ROOT = join(homedir(), '.claude', 'projects');

interface TranscriptLine {
  type?: string;
  isMeta?: boolean;
  isSidechain?: boolean;
  uuid?: string;
  sessionId?: string;
  timestamp?: string;
  cwd?: string;
  gitBranch?: string;
  message?: { role?: string; content?: unknown };
}

/** Pull the plain text out of a turn, whatever content shape it uses. */
function turnText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) =>
        typeof part === 'object' && part !== null && 'text' in part
          ? String((part as { text: unknown }).text)
          : '',
      )
      .join(' ');
  }
  return '';
}

/**
 * Condense a prompt into a one-line subject.
 *
 * Slash commands, tool results, and the harness's own caveat blocks are noise —
 * they say nothing about the work. Returns '' for those so the signal is kept
 * (it still proves you were active) with no misleading subject attached.
 */
export function summarizePrompt(text: string, max = 120): string {
  const t = text.trim();
  if (!t) return '';
  if (t.startsWith('<')) return ''; // command-name, local-command-caveat, tool blocks
  if (t.startsWith('/')) return ''; // slash command invocation
  const firstLine = t.split('\n').find((l) => l.trim().length > 0) ?? '';
  const clean = firstLine.trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

async function collectFromFile(
  filePath: string,
  since: Date,
  projects: readonly ProjectDef[],
): Promise<Signal[]> {
  const signals: Signal[] = [];
  const stream = createReadStream(filePath, { encoding: 'utf-8' });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });

  try {
    for await (const line of lines) {
      if (!line.startsWith('{')) continue;
      let d: TranscriptLine;
      try {
        d = JSON.parse(line) as TranscriptLine;
      } catch {
        // A transcript being appended to right now can have a torn last line.
        continue;
      }

      if (d.type !== 'user' || d.isMeta || d.isSidechain) continue;
      if (!d.timestamp || !d.uuid || !d.cwd) continue;

      const at = new Date(d.timestamp);
      if (Number.isNaN(at.getTime()) || at < since) continue;

      const project = projectForPath(d.cwd, projects);
      const subject = summarizePrompt(turnText(d.message?.content));

      signals.push({
        sourceId: `claude:${d.sessionId ?? 'unknown'}:${d.uuid}`,
        kind: 'claude_session',
        at,
        // Unattributed rather than guessed: a session run outside a watched repo
        // is real work whose project only you can name.
        projectKey: project?.key ?? null,
        ...(subject ? { subject } : {}),
      });
    }
  } finally {
    lines.close();
    stream.destroy();
  }

  return signals;
}

export interface CollectSessionsOptions {
  since: Date;
  projects: readonly ProjectDef[];
  /** Override the transcript root. Tests only. */
  root?: string;
}

/**
 * Scan every transcript touched since `since`.
 *
 * Filtering by file mtime first is what keeps this cheap — there are dozens of
 * project slugs and hundreds of sessions, but only a handful were written today.
 */
export async function collectSessionSignals(opts: CollectSessionsOptions): Promise<Signal[]> {
  const root = opts.root ?? SESSIONS_ROOT;

  let slugs: string[];
  try {
    slugs = await readdir(root);
  } catch {
    // No Claude Code history on this machine; git alone is a valid signal set.
    return [];
  }

  const out: Signal[] = [];
  for (const slug of slugs) {
    const dir = join(root, slug);
    let files: string[];
    try {
      files = (await readdir(dir)).filter((f) => f.endsWith('.jsonl'));
    } catch {
      continue;
    }

    for (const file of files) {
      const path = join(dir, file);
      try {
        const info = await stat(path);
        if (info.mtime < opts.since) continue;
        out.push(...(await collectFromFile(path, opts.since, opts.projects)));
      } catch {
        continue;
      }
    }
  }

  return out;
}
