// ---------------------------------------------------------------------------
// One collection sweep.
//
// Idempotent by construction: every signal carries a stable sourceId and the
// store skips duplicates, so running this once a minute, once an hour, or twice
// by accident all produce the same set. That property is what lets the daemon be
// dumb and the CLI's `collect` be safe to run whenever you feel like it.
// ---------------------------------------------------------------------------

import { loadConfig } from '@hours/config';
import { recordSignals } from '@hours/lib-db';
import type { Signal } from '@hours/core';
import { collectCheckoutSignals, collectGitSignals, gitIdentity } from './git.js';
import { collectSessionSignals } from './claude-sessions.js';

export interface SweepResult {
  scanned: number;
  recorded: number;
  bySource: Record<string, number>;
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

  try {
    const sessions = await collectSessionSignals({ since, projects: cfg.projects });
    all.push(...sessions);
    bySource['claude_sessions'] = sessions.length;
  } catch (err) {
    warnings.push(`claude sessions: ${err instanceof Error ? err.message : String(err)}`);
  }

  const recorded = await recordSignals(all);
  return { scanned: all.length, recorded, bySource, warnings };
}
