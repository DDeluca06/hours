// ---------------------------------------------------------------------------
// One collection sweep.
//
// Idempotent by construction: every signal carries a stable sourceId and the
// store skips duplicates, so running this once a minute, once an hour, or twice
// by accident all produce the same set. That property is what lets the daemon be
// dumb and the CLI's `collect` be safe to run whenever you feel like it.
// ---------------------------------------------------------------------------

import { loadConfig } from '@hours/config';
import { findConsumedSpanOverlaps, recordSignals, recordSignalSpans } from '@hours/lib-db';
import type { Signal } from '@hours/core';
import { collectCheckoutSignals, collectGitSignals, gitIdentity } from './git.js';
import { collectSessionSignals } from './claude-sessions.js';
import { collectOpenCodeSignals } from './opencode-sessions.js';
import { collectEditorHistorySignals } from './editor-history.js';
import { collectWakapiSignals, WakapiDayCache } from './wakapi-heartbeats.js';
import { syncTasks } from './tasks.js';

/**
 * Reused across sweeps so the daemon stops re-downloading finished days every
 * ten minutes. A CLI `hours collect` is a fresh process, so its cache is empty
 * and it fetches everything — which is what you want from a manual run.
 */
const wakapiCache = new WakapiDayCache();

/**
 * Cap on how many overlap warnings one sweep prints. A backfill of a whole
 * offline day can produce dozens, and a wall of them is read as noise — the
 * count that follows them is the part that matters.
 */
const MAX_OVERLAP_WARNINGS = 5;

export interface SweepResult {
  scanned: number;
  recorded: number;
  /**
   * Already-stored signals whose measured span grew because the turn was still
   * running last sweep. Not part of `recorded` — nothing new was observed, an
   * existing observation got longer.
   */
  spansAdvanced: number;
  /** Signals seen per source. Every value counts signals — nothing else belongs here. */
  bySource: Record<string, number>;
  /**
   * Work packages refreshed in the task cache. Deliberately not in `bySource`:
   * tasks are not signals, and a consumer summing that map would over-report
   * the sweep by the size of the cache.
   */
  tasksSynced: number;
  warnings: string[];
}

export interface SweepOptions {
  /** How far back to look. Defaults to 3 days — long enough to cover a weekend. */
  since?: Date;
  /** Restrict git to your own commits. Defaults to the repo's configured email. */
  authorEmail?: string | null;
}

export async function sweep(opts: SweepOptions = {}): Promise<SweepResult> {
  const cfg = loadConfig();
  const since = opts.since ?? new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
  const warnings: string[] = [];
  const all: Signal[] = [];
  const bySource: Record<string, number> = {};

  for (const project of cfg.projects) {
    for (const repoPath of project.repoPaths) {
      let authorEmail = opts.authorEmail ?? undefined;
      if (opts.authorEmail === undefined) {
        // Default to your own commits so a teammate's merged work never lands on
        // your timesheet. Pass null explicitly to take every author.
        const id = await gitIdentity(repoPath);
        authorEmail = id.email || undefined;
        if (!id.email) {
          warnings.push(`${repoPath}: no git user.email configured — taking commits from all authors`);
        }
      }

      const gitOpts = { since, ...(authorEmail ? { authorEmail } : {}) };
      try {
        const commits = await collectGitSignals(project, repoPath, gitOpts);
        const checkouts = await collectCheckoutSignals(project, repoPath, gitOpts);
        all.push(...commits, ...checkouts);
        bySource[`git:${project.key}`] = commits.length;
        bySource[`checkout:${project.key}`] = checkouts.length;
      } catch (err) {
        warnings.push(`${repoPath}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  // Each harness is wrapped on its own. One missing or half-written store must
  // not cost the sweep the other sources — a machine with no OpenCode installed
  // is the normal case, not an error.
  const harnesses = cfg.harnesses;
  if (harnesses.claudeCode) {
    try {
      const sessions = await collectSessionSignals({
        since,
        projects: cfg.projects,
        maxSpanMin: harnesses.maxSpanMin,
      });
      all.push(...sessions);
      bySource['claude_sessions'] = sessions.length;
    } catch (err) {
      warnings.push(`claude sessions: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (harnesses.openCode) {
    try {
      const sessions = await collectOpenCodeSignals({
        since,
        projects: cfg.projects,
        maxSpanMin: harnesses.maxSpanMin,
        remapHome: harnesses.remapOpenCodeHome,
      });
      all.push(...sessions);
      bySource['opencode_sessions'] = sessions.length;
    } catch (err) {
      warnings.push(`opencode sessions: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (harnesses.editors) {
    try {
      const edits = await collectEditorHistorySignals({
        since,
        projects: cfg.projects,
        ...(harnesses.editorHistoryRoots ? { roots: harnesses.editorHistoryRoots } : {}),
      });
      all.push(...edits);
      bySource['editor_history'] = edits.length;
    } catch (err) {
      warnings.push(`editor history: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (harnesses.wakapi) {
    // Unlike the local sources, heartbeats need a server and a key, so the
    // unconfigured state is *quiet* — same rule as the OpenProject cache. A
    // half-configured one is a real mistake, though, and gets a warning: it
    // looks exactly like the "tracking silently never starts" failure the
    // source exists to cover.
    const { url, apiKey } = cfg.wakapi;
    if (url && !apiKey) {
      warnings.push('wakapi: WAKAPI_URL set without WAKAPI_API_KEY — heartbeat collection is off');
    } else if (apiKey && !url) {
      warnings.push('wakapi: WAKAPI_API_KEY set without WAKAPI_URL — heartbeat collection is off');
    } else if (url && apiKey) {
      try {
        const result = await collectWakapiSignals({
          url,
          apiKey,
          since,
          projects: cfg.projects,
          // The same bound the harness sources get. Without it a heartbeat run
          // that bridges a lunch break is one multi-hour *measured* signal, and
          // measured spans skip the conservative lead-in precisely because they
          // are supposed to be short and observed.
          maxSpanMin: harnesses.maxSpanMin,
          cache: wakapiCache,
        });
        all.push(...result.signals);
        warnings.push(...result.warnings);
        bySource['wakapi'] = result.signals.length;
      } catch (err) {
        warnings.push(`wakapi: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  // Before writing: does any of this new evidence describe minutes an
  // already-billed signal claimed? That happens when a source's anchor moves —
  // an offline wakatime-cli flushing buffered heartbeats into a run that was
  // already folded into an entry. Apportionment stops it being billed twice;
  // this stops it being invisible. Best-effort: a failure here must not cost the
  // sweep its signals.
  try {
    const overlaps = await findConsumedSpanOverlaps(all);
    for (const o of overlaps.slice(0, MAX_OVERLAP_WARNINGS)) {
      warnings.push(
        `${o.kind}: new signal ${o.sourceId} covers ${o.overlapMinutes}m already counted by ${o.consumedSourceId} — late-arriving evidence re-anchored a run; review ${o.projectKey ?? 'unattributed'} time for that stretch`,
      );
    }
    if (overlaps.length > MAX_OVERLAP_WARNINGS) {
      warnings.push(
        `…and ${overlaps.length - MAX_OVERLAP_WARNINGS} more signal(s) overlapping already-counted evidence`,
      );
    }
  } catch (err) {
    warnings.push(
      `overlap check skipped: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const recorded = await recordSignals(all);

  // A turn seen mid-flight was recorded with a short span or none at all, so the
  // span pass runs every sweep to carry it forward. It only ever moves an
  // unconsumed signal's end later, which is why running it on every sweep is
  // safe rather than merely tolerable.
  const spansAdvanced = await recordSignalSpans(all);

  // Task-cache sync goes last: the connector can take up to 15s to time out,
  // and a slow network must never delay the signal collection above.
  const taskSync = await syncTasks();
  warnings.push(...taskSync.warnings);

  return {
    scanned: all.length,
    recorded,
    spansAdvanced,
    bySource,
    tasksSynced: taskSync.synced,
    warnings,
  };
}
