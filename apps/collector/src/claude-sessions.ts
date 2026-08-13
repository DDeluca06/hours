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
// A turn is read as a *span*, not a point. The harness does not write a duration
// field anywhere, but it timestamps every line, so a prompt's real end is the
// last line the harness wrote before the next prompt — assistant output, tool
// results, subagent chatter. That converts a 25-minute autonomous run off one
// prompt from a single zero-width heartbeat (which the lead-in guess then
// reported as a flat 20 minutes regardless) into measured time.
//
// Only genuine prompts become signals. Tool-result lines are also `type: "user"`
// and were previously counted too, which over-weighted tool-heavy work by more
// than an order of magnitude — a real day here is ~644 tool results against ~24
// typed prompts, so a single afternoon of agent work outvoted every commit in the
// apportionment. One signal per prompt, spanning the turn, says the same thing
// without the distortion.
//
// Read as a line stream rather than parsed whole — these files reach tens of
// megabytes, and only the turn boundaries matter.
// ---------------------------------------------------------------------------

import { createReadStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_MAX_SPAN_MIN,
  projectForPath,
  type ProjectDef,
  type Signal,
} from '@hours/core';

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
  /** Present on tool-result lines, which are also `type: "user"`. */
  toolUseResult?: unknown;
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

/** A line that starts a turn: something a person (or the harness) submitted. */
function isPrompt(d: TranscriptLine): boolean {
  return (
    d.type === 'user' &&
    !d.isMeta &&
    !d.isSidechain &&
    // Tool results ride in on `type: "user"` too. They are the *middle* of a
    // turn, so they extend the current span instead of starting a new one.
    d.toolUseResult === undefined &&
    !!d.timestamp &&
    !!d.uuid &&
    !!d.cwd
  );
}

async function collectFromFile(
  filePath: string,
  since: Date,
  projects: readonly ProjectDef[],
  maxSpanMin: number,
): Promise<Signal[]> {
  const signals: Signal[] = [];
  const stream = createReadStream(filePath, { encoding: 'utf-8' });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });

  // The turn currently being measured. Its span grows with every harness line
  // that follows, and closes when the next prompt arrives or the file ends.
  let open: Signal | null = null;
  const close = (): void => {
    if (open) signals.push(open);
    open = null;
  };

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
      if (!d.timestamp) continue;
      const stamp = new Date(d.timestamp);
      if (Number.isNaN(stamp.getTime())) continue;

      if (isPrompt(d)) {
        close();
        // Prompts older than the window are still parsed — a turn that began
        // before `since` and is still running would otherwise have its later
        // lines misattributed to whatever prompt came next.
        if (stamp < since) continue;

        const project = projectForPath(d.cwd as string, projects);
        const subject = summarizePrompt(turnText(d.message?.content));
        open = {
          sourceId: `claude:${d.sessionId ?? 'unknown'}:${d.uuid as string}`,
          kind: 'claude_session',
          at: stamp,
          // Unattributed rather than guessed: a session run outside a watched
          // repo is real work whose project only you can name.
          projectKey: project?.key ?? null,
          ...(subject ? { subject } : {}),
        };
        continue;
      }

      // Any other timestamped line — assistant output, tool result, sidechain
      // turn from a subagent — is proof the turn was still running.
      if (open && stamp > open.at) {
        const capped = Math.min(stamp.getTime(), open.at.getTime() + maxSpanMin * 60_000);
        if (!open.until || capped > open.until.getTime()) open.until = new Date(capped);
      }
    }
    close();
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
  /** Cap on a single turn's measured span. Defaults to `DEFAULT_MAX_SPAN_MIN`. */
  maxSpanMin?: number;
}

/**
 * Scan every transcript touched since `since`.
 *
 * Filtering by file mtime first is what keeps this cheap — there are dozens of
 * project slugs and hundreds of sessions, but only a handful were written today.
 */
export async function collectSessionSignals(opts: CollectSessionsOptions): Promise<Signal[]> {
  const root = opts.root ?? SESSIONS_ROOT;
  const maxSpanMin = opts.maxSpanMin ?? DEFAULT_MAX_SPAN_MIN;

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
        out.push(...(await collectFromFile(path, opts.since, opts.projects, maxSpanMin)));
      } catch {
        continue;
      }
    }
  }

  return out;
}
