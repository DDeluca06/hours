// ---------------------------------------------------------------------------
// Task reference parsing.
//
// Signals carry prose — commit messages, branch names, session subjects — and
// some of that prose names an OpenProject task ("fix #136",
// "feature/136-matcher"). This module extracts those refs deterministically.
// Parsing is pure: it never consults the task cache, so the same signal always
// parses the same way. The cache check lives in apps/collector, where the DB is
// reachable.
//
// The philosophy matches project attribution: unattributed rather than
// guessed. A ref sticks only when a block's signals *agree* on it
// (`agreeOnTask`), and the collector additionally refuses refs the cache has
// never seen.
// ---------------------------------------------------------------------------

// `#136` anywhere in prose (the `\b` on the digit side keeps "#136" from
// matching inside a longer number like "#1369"), plus the GitHub-style keyword
// forms with an optional hash. Keywords are case-insensitive ("CLOSES 136").
const TASK_REF = /#(\d+)\b|\b(?:closes|fixes|refs|resolves)\b\s*#?\s*(\d+)\b/gi;

/**
 * Deterministic task refs in prose: `#136` anywhere, and
 * `closes|fixes|refs|resolves` followed by an optional `#` and a number.
 *
 * Deduplicated, preserving first-seen order (a commit that says both
 * "closes #136" and "fixes 136" mentions one task). Empty text yields [].
 */
export function parseTaskRefs(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(TASK_REF)) {
    const id = m[1] ?? m[2];
    if (id && !out.includes(id)) out.push(id);
  }
  return out;
}

/** Branch-name prefixes that are scaffolding, not part of the task ref. */
const BRANCH_PREFIX = /^(?:feature|fix|hotfix|chore|release)\//;

/**
 * A task id from a branch name, or null when the name names no task.
 *
 * Handles both the raw branch form (`136-matcher`, `feature/136-matcher`,
 * `136_foo`, `136/foo`) and the git_branch signal subject form
 * (`switched to 136-matcher`), which is how the collector sees branches.
 */
export function taskRefFromBranch(subject: string): string | null {
  let name = subject.startsWith('switched to ') ? subject.slice('switched to '.length) : subject;
  name = name.replace(BRANCH_PREFIX, '');
  const m = name.match(/^(\d+)[-_/]/);
  const id = m?.[1];
  if (!id) return null;

  const n = Number(id);
  // Year guard: a 4-digit leading number in 1900–2100 is a date-stamped branch
  // ("2026-08-13", "release/2026-01"), not a task — attributing it would guess
  // task 2026 exists. Task ids here are small work-package numbers, so the
  // false-negative cost of the guard is negligible.
  if (n >= 1900 && n <= 2100) return null;

  return id;
}

/**
 * One task ref per signal, by kind.
 *
 * git_commit and claude_session refs are parsed from the subject prose;
 * git_branch refs come from the branch name behind the "switched to" prefix;
 * every other kind has no ref. When a subject mentions several tasks, only the
 * first is taken — a multi-task mention is ambiguous, and ambiguity must fail
 * toward no attribution, which is what the consensus step turns into "no
 * task" when the other signals disagree.
 */
export function signalTaskRef(signal: { kind: string; subject?: string }): string | null {
  switch (signal.kind) {
    case 'git_commit':
    case 'claude_session':
      return parseTaskRefs(signal.subject ?? '')[0] ?? null;
    case 'git_branch':
      return signal.subject ? taskRefFromBranch(signal.subject) : null;
    default:
      return null;
  }
}

/**
 * The consensus rule: a block's signals name a task only when they name *one*
 * task.
 *
 * Zero distinct refs means nothing was named; two or more means the signals
 * disagree about what was being worked on. Both must stay unattributed —
 * guessing in either direction would attach hours to the wrong work package,
 * and the repo's rule is "unattributed rather than guessed".
 */
export function agreeOnTask(refs: readonly (string | null)[]): string | null {
  const distinct = new Set(refs.filter((r): r is string => r !== null));
  if (distinct.size === 1) {
    for (const v of distinct) return v;
  }
  return null;
}
