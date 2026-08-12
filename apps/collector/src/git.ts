// ---------------------------------------------------------------------------
// Git as a signal source.
//
// Commits are the highest-quality passive evidence available: timestamped,
// attributed, and they carry both a subject and the exact files touched. We read
// them with `git log` rather than a library — no dependency, and the format is
// stable.
//
// Two deliberate choices:
//   * Author date, not commit date. A rebase rewrites commit dates and would
//     teleport last week's work onto today's timesheet.
//   * All local branches plus the reflog window, not just HEAD. Work on a branch
//     you have since switched away from still happened.
// ---------------------------------------------------------------------------

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { ProjectDef, Signal } from '@hours/core';

const exec = promisify(execFile);

const FIELD = '';
const RECORD = '';

async function git(repoPath: string, args: string[]): Promise<string> {
  const { stdout } = await exec('git', ['-C', repoPath, ...args], {
    maxBuffer: 32 * 1024 * 1024,
  });
  return stdout;
}

export async function isGitRepo(repoPath: string): Promise<boolean> {
  try {
    const out = await git(repoPath, ['rev-parse', '--is-inside-work-tree']);
    return out.trim() === 'true';
  } catch {
    return false;
  }
}

/** The identities git will attribute your commits to, for filtering. */
export async function gitIdentity(repoPath: string): Promise<{ name: string; email: string }> {
  const [name, email] = await Promise.all([
    git(repoPath, ['config', 'user.name']).then((s) => s.trim()).catch(() => ''),
    git(repoPath, ['config', 'user.email']).then((s) => s.trim()).catch(() => ''),
  ]);
  return { name, email };
}

export interface CollectGitOptions {
  /** Only commits at or after this instant. */
  since: Date;
  /** Restrict to commits authored by this email. Omit to take every author. */
  authorEmail?: string;
}

/**
 * Read commits from a repo as signals.
 *
 * sourceId is `git:<repoKey>:<sha>`, so re-scanning the same commit is a no-op
 * and the same sha appearing on two branches is recorded once.
 */
export async function collectGitSignals(
  project: ProjectDef,
  repoPath: string,
  opts: CollectGitOptions,
): Promise<Signal[]> {
  if (!(await isGitRepo(repoPath))) return [];

  const args = [
    'log',
    '--all',
    '--no-merges',
    `--since=${opts.since.toISOString()}`,
    // %aI is the author date in strict ISO-8601, which preserves the local
    // offset the commit was actually made in.
    `--pretty=format:${RECORD}%H${FIELD}%aI${FIELD}%ae${FIELD}%s`,
    '--name-only',
  ];
  if (opts.authorEmail) args.push(`--author=${opts.authorEmail}`);

  let raw: string;
  try {
    raw = await git(repoPath, args);
  } catch {
    // A repo with no commits yet exits non-zero; that is not an error here.
    return [];
  }

  const signals: Signal[] = [];
  for (const chunk of raw.split(RECORD)) {
    if (!chunk.trim()) continue;
    const [header, ...pathLines] = chunk.split('\n');
    const [sha, isoDate, email, subject] = (header ?? '').split(FIELD);
    if (!sha || !isoDate) continue;

    const at = new Date(isoDate);
    if (Number.isNaN(at.getTime())) continue;
    if (opts.authorEmail && email && email.toLowerCase() !== opts.authorEmail.toLowerCase()) {
      continue;
    }

    const paths = pathLines.map((l) => l.trim()).filter(Boolean);

    signals.push({
      sourceId: `git:${project.key}:${sha}`,
      kind: 'git_commit',
      at,
      projectKey: project.key,
      ...(subject ? { subject } : {}),
      ...(paths.length ? { paths } : {}),
    });
  }

  return signals;
}

/**
 * Read branch checkouts from the reflog as signals.
 *
 * A checkout marks a context switch, which is exactly the boundary the block
 * inference wants — and a branch name like `writing/dev` or `grants/matcher` is
 * often a better description of the work than any single commit subject.
 */
export async function collectCheckoutSignals(
  project: ProjectDef,
  repoPath: string,
  opts: CollectGitOptions,
): Promise<Signal[]> {
  if (!(await isGitRepo(repoPath))) return [];

  let raw: string;
  try {
    raw = await git(repoPath, [
      'reflog',
      '--date=iso-strict',
      `--pretty=format:%gd${FIELD}%cI${FIELD}%gs`,
    ]);
  } catch {
    return [];
  }

  const signals: Signal[] = [];
  for (const line of raw.split('\n')) {
    const [ref, isoDate, message] = line.split(FIELD);
    if (!ref || !isoDate || !message) continue;
    const m = /^checkout: moving from (\S+) to (\S+)$/.exec(message.trim());
    if (!m) continue;

    const at = new Date(isoDate);
    if (Number.isNaN(at.getTime()) || at < opts.since) continue;

    signals.push({
      // The reflog selector (HEAD@{n}) shifts as the reflog grows, so it cannot
      // be part of the key — timestamp plus destination branch is stable.
      sourceId: `checkout:${project.key}:${at.toISOString()}:${m[2]}`,
      kind: 'git_branch',
      at,
      projectKey: project.key,
      subject: `switched to ${m[2]}`,
    });
  }

  return signals;
}
