// ---------------------------------------------------------------------------
// Signals → blocks.
//
// A *signal* is one timestamped thing we observed: a commit landed, a file was
// saved, a Claude Code session turn happened. A *block* is a contiguous stretch
// of work inferred from a run of signals. Blocks are what you review; entries
// (blocks.ts → entries.ts) are what gets pushed to the sheet.
//
// The load-bearing subtlety: most signals are *trailing edges*. A commit at
// 10:45 records work that happened before 10:45, not at it. So a block's end is
// its last signal, and its start is its first signal minus a lead-in — without
// that, a day of six commits infers six zero-length blocks and reports 0 hours.
//
// Signals from an agent harness are the exception: they carry `until`, a real
// clocked end, so their duration is measured rather than guessed. A run that
// opens with a measured span gets no lead-in, and idle gaps are measured from a
// signal's end rather than its start. Everything downstream — apportionment,
// clipping, the workday clamp — is unchanged, which is why inferred time still
// cannot exceed the wall clock.
// ---------------------------------------------------------------------------

import { mergeRanges } from './duration.js';
import {
  bestGuess,
  guessFromPaths,
  guessFromSubject,
  type Activity,
  type ActivityGuess,
} from './taxonomy.js';
import {
  clampToWorkday,
  minutesFromMidnight,
  roundTo,
  DEFAULT_WORKDAY,
  type WorkdayPolicy,
} from './workday.js';

export type SignalKind =
  | 'git_commit'
  | 'git_branch'
  | 'file_edit'
  | 'claude_session'
  | 'opencode_session'
  | 'calendar'
  | 'manual';

export interface Signal {
  /** Stable dedupe key, e.g. `git:<repo>:<sha>` or `claude:<sessionId>:<turn>`. */
  sourceId: string;
  kind: SignalKind;
  at: Date;
  /** Project key, or null when the signal came from outside a watched repo. */
  projectKey: string | null;
  /** Commit subject, session title, or calendar event name. */
  subject?: string;
  /** Repo-relative paths this signal touched. */
  paths?: string[];
  /**
   * Observed end of the work this signal describes — a *measured* span rather
   * than a point.
   *
   * Most signals are trailing edges with no known duration (a commit says
   * nothing about when you started), and for those this stays absent and the
   * lead-in guess applies. An agent harness is the exception: it records when a
   * turn began and when it finished, so that stretch is known rather than
   * inferred. Where it is known, we use it and drop the guess.
   */
  until?: Date;
}

/** True when the harness told us how long this signal's work actually took. */
export function isMeasured(s: Pick<Signal, 'at' | 'until'>): boolean {
  return s.until !== undefined && s.until.getTime() > s.at.getTime();
}

/** The observed end of a signal — its measured end, or its instant. */
export function signalEnd(s: Pick<Signal, 'at' | 'until'>): Date {
  return isMeasured(s) ? (s.until as Date) : s.at;
}

export interface InferredBlock {
  projectKey: string | null;
  /** Minutes from midnight, after clamping and rounding. */
  startMin: number;
  endMin: number;
  minutes: number;
  activity: Activity;
  /** 0–1. Below `CONFIDENT`, the review step should prompt. */
  confidence: number;
  /** Human-readable justification, surfaced in `hours review`. */
  reason: string;
  /** sourceIds of every signal folded into this block. */
  signalIds: string[];
  /** Distinct subjects, in order — becomes the Notes text. */
  subjects: string[];
  /**
   * Evidence strength, used when overlapping blocks have to share a window.
   * Weighted by signal kind rather than raw count, because one commit says more
   * about what you were doing than twenty session turns do.
   */
  weight: number;
  /**
   * OpenProject task id ("136") the block's signals agreed on. Absent when the
   * signals disagreed, the ref was never seen, or the cache has not synced it
   * yet. Set by the collector after inference, never by the parser alone.
   */
  taskId?: string;
}

/**
 * How much each kind of signal counts toward a block's claim on a window.
 *
 * A commit is deliberate and self-describing; a session turn only proves you
 * were at the keyboard. Counting them equally let a chatty afternoon in an
 * unwatched directory outvote a real commit.
 */
const KIND_WEIGHT: Record<SignalKind, number> = {
  git_commit: 4,
  manual: 4,
  calendar: 4,
  git_branch: 2,
  file_edit: 1,
  claude_session: 1,
  opencode_session: 1,
};

/** Weight floor for a measured span — see `signalWeight`. */
const MEASURED_WEIGHT = 2;

/**
 * Longest span a single harness turn may claim, in minutes.
 *
 * A turn's span is bounded by the model's own runtime in the normal case, but a
 * tool call parked on a permission prompt while you go to lunch is stamped as one
 * continuous turn. Clamping at two hours keeps that from billing lunch. It lives
 * here, with the other inference policy, because every harness reader needs the
 * same number and none of them should invent its own.
 */
export const DEFAULT_MAX_SPAN_MIN = 120;

/**
 * How much one signal counts toward its block's claim on a window.
 *
 * A measured span outweighs a bare heartbeat: it is evidence of *duration*, not
 * just of presence, so when two activities fight over the same window the one
 * whose time the harness actually clocked should win. It stays below a commit's
 * 4 — wall-clock in a session proves the machine was busy, a commit proves you
 * decided something.
 */
export function signalWeight(s: Pick<Signal, 'kind' | 'at' | 'until'>): number {
  const base = KIND_WEIGHT[s.kind] ?? 1;
  return isMeasured(s) ? Math.max(base, MEASURED_WEIGHT) : base;
}

/**
 * A signal's end as minutes from midnight, saturating at the day boundary.
 *
 * A span that crosses local midnight is clipped at 23:59 rather than wrapping to
 * a small number — blocks are inferred one calendar day at a time
 * (`groupSignalsByDay`), so the minutes past midnight belong to the next day's
 * pass. Wrapping instead would make `endMin` land *before* `startMin` and the
 * block would be silently dropped.
 */
function endMinutes(s: Signal): number {
  if (!isMeasured(s)) return minutesFromMidnight(s.at);
  const end = s.until as Date;
  const sameDay =
    end.getFullYear() === s.at.getFullYear() &&
    end.getMonth() === s.at.getMonth() &&
    end.getDate() === s.at.getDate();
  return sameDay ? minutesFromMidnight(end) : 24 * 60 - 1;
}

export interface InferOptions {
  policy?: WorkdayPolicy;
  /**
   * How far back a block's first signal implies work already underway.
   * Default 20 minutes — deliberately conservative: under-reporting a block is
   * a correctable review nudge, over-reporting is a billing problem.
   */
  leadInMin?: number;
  /** Keep work that fell outside 9–3 rather than discarding it. */
  allowOutsideWorkday?: boolean;
}

/**
 * Group a single day's signals into blocks.
 *
 * Signals must all belong to the same local calendar day; callers are expected
 * to bucket by day first (see `groupSignalsByDay`). A run is broken by either
 * an idle gap longer than `policy.gapMin` or a change of project, since two
 * projects can't be in progress at the same instant.
 */
export function inferBlocks(signals: readonly Signal[], opts: InferOptions = {}): InferredBlock[] {
  const policy = opts.policy ?? DEFAULT_WORKDAY;
  const leadIn = opts.leadInMin ?? 20;
  const allowOutside = opts.allowOutsideWorkday ?? false;

  const sorted = [...signals].sort((a, b) => a.at.getTime() - b.at.getTime());
  if (sorted.length === 0) return [];

  // Each project's signals form their own stream, and runs are cut by idle gaps
  // *within* a stream. Splitting one interleaved timeline by project instead
  // would shred a single push into one run per commit, because a Claude session
  // signal from an unwatched directory lands between every pair of commits.
  const streams = new Map<string, Signal[]>();
  for (const s of sorted) {
    const key = s.projectKey ?? '';
    const stream = streams.get(key);
    if (stream) stream.push(s);
    else streams.set(key, [s]);
  }

  const runs: Signal[][] = [];
  for (const stream of streams.values()) {
    let current: Signal[] = [];
    for (const s of stream) {
      const prev = current[current.length - 1];
      // Measured from the previous signal's *end*, not its instant. A 40-minute
      // agent turn followed by a commit five minutes later is one stretch of
      // work; measuring the gap from the turn's start would call it 45 minutes
      // idle and split the block in two.
      const gap = prev ? (s.at.getTime() - signalEnd(prev).getTime()) / 60_000 : Infinity;
      if (current.length > 0 && gap <= policy.gapMin) {
        current.push(s);
      } else {
        if (current.length) runs.push(current);
        current = [s];
      }
    }
    if (current.length) runs.push(current);
  }

  const blocks: InferredBlock[] = [];
  for (const run of runs) {
    const first = run[0];
    const last = run[run.length - 1];
    if (!first || !last) continue;

    // The lead-in exists to compensate for not knowing when work began. When the
    // run opens with a measured span, we *do* know — the harness stamped it — so
    // guessing 20 minutes on top of a known start would invent time.
    const measuredStart = isMeasured(first);
    const rawStart = minutesFromMidnight(first.at) - (measuredStart ? 0 : leadIn);
    // `last` is the latest by start time, but a span that began earlier can end
    // later, so the run's end is the max over every signal's observed end.
    const rawEnd = Math.max(...run.map(endMinutes));

    const clamped = clampToWorkday(rawStart, Math.max(rawEnd, rawStart + 1), policy, allowOutside);
    if (!clamped) continue;

    const startMin = roundTo(clamped.startMin, policy.roundToMin);
    let endMin = roundTo(clamped.endMin, policy.roundToMin);
    // A run whose signals all round into the same slot still represents real
    // work — give it one granule rather than dropping it.
    if (endMin <= startMin) endMin = startMin + policy.roundToMin;

    const minutes = endMin - startMin;
    if (minutes < policy.minBlockMin) continue;

    const paths = [...new Set(run.flatMap((s) => s.paths ?? []))];
    const subjects = [...new Set(run.map((s) => s.subject).filter((s): s is string => !!s))];
    const guess = classifyRun(subjects, paths);

    // Say so in the reason: a reviewer looking at 95 minutes needs to know
    // whether that came off a clock or off the lead-in heuristic.
    const measuredCount = run.filter((s) => isMeasured(s)).length;
    const reason =
      measuredCount > 0
        ? `${guess.reason}; ${measuredCount} measured harness span${measuredCount === 1 ? '' : 's'}${measuredStart ? ', no lead-in guess' : ''}`
        : guess.reason;

    blocks.push({
      projectKey: first.projectKey,
      startMin,
      endMin,
      minutes,
      activity: guess.activity,
      confidence: guess.confidence,
      reason,
      signalIds: run.map((s) => s.sourceId),
      subjects,
      weight: run.reduce((sum, s) => sum + signalWeight(s), 0),
    });
  }

  // Blocks come out grouped by stream, so sort before merging — the merge pass
  // only ever looks at its immediate predecessor.
  blocks.sort((a, b) => a.startMin - b.startMin || a.endMin - b.endMin);
  const merged = mergeAdjacentSameActivity(blocks, policy);

  // Arbitrate attributed work first and on its own. Letting an unattributed
  // block into the same cluster meant a long session in an unwatched directory,
  // backed by hundreds of turns, could squeeze a real project's commit down to a
  // single granule — and unattributed blocks are then discarded, so that time
  // vanished entirely instead of being reported.
  const attributed = merged.filter((b) => b.projectKey !== null);
  const unattributed = merged.filter((b) => b.projectKey === null);

  const resolved = resolveOverlaps(attributed, policy);
  const leftover = resolveOverlaps(clipAgainst(unattributed, resolved, policy), policy);

  return [...resolved, ...leftover].sort((a, b) => a.startMin - b.startMin);
}

/**
 * Remove from `blocks` any time already claimed by `claimed`.
 *
 * Unattributed blocks are suggestions for the review step, so they must describe
 * time that is still *free* — otherwise `hours reconstruct` reports 90 minutes of
 * unassigned work that is really the same 90 minutes it already logged.
 */
export function clipAgainst(
  blocks: readonly InferredBlock[],
  claimed: readonly InferredBlock[],
  policy: WorkdayPolicy = DEFAULT_WORKDAY,
): InferredBlock[] {
  if (claimed.length === 0) return [...blocks];
  const busy = mergeRanges(claimed.map((c) => ({ startMin: c.startMin, endMin: c.endMin })));

  const out: InferredBlock[] = [];
  for (const b of blocks) {
    let pieces: Array<{ startMin: number; endMin: number }> = [
      { startMin: b.startMin, endMin: b.endMin },
    ];
    for (const busyRange of busy) {
      const next: typeof pieces = [];
      for (const piece of pieces) {
        if (busyRange.endMin <= piece.startMin || busyRange.startMin >= piece.endMin) {
          next.push(piece);
          continue;
        }
        if (busyRange.startMin > piece.startMin) {
          next.push({ startMin: piece.startMin, endMin: busyRange.startMin });
        }
        if (busyRange.endMin < piece.endMin) {
          next.push({ startMin: busyRange.endMin, endMin: piece.endMin });
        }
      }
      pieces = next;
    }

    for (const piece of pieces) {
      const minutes = piece.endMin - piece.startMin;
      if (minutes < policy.minBlockMin) continue;
      out.push({ ...b, ...piece, minutes, signalIds: [...b.signalIds], subjects: [...b.subjects] });
    }
  }
  return out;
}

/**
 * Apportion overlapping blocks so their total can never exceed the wall clock.
 *
 * This is the correctness heart of the inference. A push of six commits at 15:02
 * produces six runs whose lead-ins all resolve to the same 14:45–15:00 slot; left
 * alone, each claims the full 15 minutes and one minute of pushing bills as an
 * hour and a half. Since a person does one thing at a time, a cluster of
 * overlapping blocks describes *one* stretch of work whose span is the union, and
 * the activities inside it have to share that span rather than each take it.
 *
 * Shares are proportional to how much evidence backs each activity, floored at
 * one rounding granule. When a cluster is too short to give every activity a
 * granule, the weakest-evidence ones are dropped and said so in the survivors'
 * reason — under-reporting is a review nudge, over-reporting is a billing
 * problem.
 */
export function resolveOverlaps(
  blocks: readonly InferredBlock[],
  policy: WorkdayPolicy = DEFAULT_WORKDAY,
): InferredBlock[] {
  const sorted = [...blocks].sort((a, b) => a.startMin - b.startMin || a.endMin - b.endMin);

  // Maximal runs of blocks that overlap in time, transitively.
  const clusters: InferredBlock[][] = [];
  let current: InferredBlock[] = [];
  let clusterEnd = -Infinity;
  for (const b of sorted) {
    if (current.length > 0 && b.startMin < clusterEnd) {
      current.push(b);
      clusterEnd = Math.max(clusterEnd, b.endMin);
    } else {
      if (current.length) clusters.push(current);
      current = [b];
      clusterEnd = b.endMin;
    }
  }
  if (current.length) clusters.push(current);

  const out: InferredBlock[] = [];
  for (const cluster of clusters) {
    if (cluster.length === 1) {
      out.push(cluster[0] as InferredBlock);
      continue;
    }
    out.push(...apportion(cluster, policy));
  }
  return out;
}

interface Share {
  projectKey: string | null;
  activity: Activity;
  weight: number;
  confidence: number;
  reason: string;
  earliest: number;
  signalIds: string[];
  subjects: string[];
  taskId?: string;
  granules: number;
}

function apportion(cluster: readonly InferredBlock[], policy: WorkdayPolicy): InferredBlock[] {
  let spanStart = Math.min(...cluster.map((b) => b.startMin));
  const spanEnd = Math.max(...cluster.map((b) => b.endMin));
  const granule = policy.roundToMin > 0 ? policy.roundToMin : 15;

  // Distinct *projects* in one window are strong evidence of genuinely separate
  // work, so the window is stretched backward to fit one granule each. Distinct
  // *activities* within one project are not — a single push routinely touches
  // code, docs, and CI at the same instant — so those must share the window.
  const distinctProjects = new Set(cluster.map((b) => b.projectKey)).size;
  const capacity = Math.max(1, Math.floor((spanEnd - spanStart) / granule), distinctProjects);
  const needed = capacity * granule;
  if (needed > spanEnd - spanStart) spanStart = Math.max(0, spanEnd - needed);

  // One share per project+activity: two Development blocks in the same cluster
  // are one activity with twice the evidence, not two competing claims.
  const shares = new Map<string, Share>();
  for (const b of cluster) {
    const key = `${b.projectKey ?? ''}|${b.activity}`;
    const existing = shares.get(key);
    if (existing) {
      existing.weight += b.weight;
      existing.confidence = Math.max(existing.confidence, b.confidence);
      existing.earliest = Math.min(existing.earliest, b.startMin);
      existing.signalIds.push(...b.signalIds);
      existing.subjects = [...new Set([...existing.subjects, ...b.subjects])];
      // Same rule — and the same dormancy — as mergeAdjacentSameActivity: a
      // share keeps its task only while every block folded into it names the
      // same one. Blocks carry no taskId this early in the current pipeline;
      // the rule exists for callers of the exported helper.
      if (existing.taskId !== b.taskId) delete existing.taskId;
    } else {
      shares.set(key, {
        projectKey: b.projectKey,
        activity: b.activity,
        weight: Math.max(1, b.weight),
        confidence: b.confidence,
        reason: b.reason,
        earliest: b.startMin,
        signalIds: [...b.signalIds],
        subjects: [...b.subjects],
        ...(b.taskId !== undefined ? { taskId: b.taskId } : {}),
        granules: 0,
      });
    }
  }

  const ranked = [...shares.values()].sort(
    (a, b) => b.weight - a.weight || b.confidence - a.confidence,
  );
  const kept = ranked.slice(0, capacity);
  const dropped = ranked.slice(capacity);

  // Every survivor gets one granule, then the remainder goes out by largest
  // fractional share of the evidence weight.
  const totalWeight = kept.reduce((s, k) => s + k.weight, 0) || 1;
  let remaining = capacity - kept.length;
  const wants = kept.map((k) => ((capacity * k.weight) / totalWeight) - 1);
  for (const k of kept) k.granules = 1;
  while (remaining > 0) {
    let bestIndex = 0;
    let bestWant = -Infinity;
    wants.forEach((w, i) => {
      if (w > bestWant) {
        bestWant = w;
        bestIndex = i;
      }
    });
    const winner = kept[bestIndex];
    if (!winner) break;
    winner.granules += 1;
    wants[bestIndex] = (wants[bestIndex] ?? 0) - 1;
    remaining--;
  }

  // Lay the shares out contiguously in the order the work started, so the Notes
  // clock ranges read as a plausible sequence rather than a pile.
  const inTimeOrder = [...kept].sort((a, b) => a.earliest - b.earliest);
  const droppedNote =
    dropped.length > 0
      ? `; ${dropped.length} lower-evidence activit${dropped.length === 1 ? 'y' : 'ies'} dropped (${dropped
          .map((d) => d.activity)
          .join(', ')}) — the ${spanEnd - spanStart}m window could not hold them`
      : '';

  // A dropped share's signals must still be accounted for, or reconstruction
  // would re-infer them tomorrow and log the same window twice. Hand them to the
  // strongest survivor so they are consumed with it.
  const strongest = kept[0];
  if (strongest) {
    for (const d of dropped) strongest.signalIds.push(...d.signalIds);
  }

  const out: InferredBlock[] = [];
  let cursor = spanStart;
  for (const share of inTimeOrder) {
    const minutes = share.granules * granule;
    if (minutes < policy.minBlockMin) {
      cursor += minutes;
      continue;
    }
    out.push({
      projectKey: share.projectKey,
      startMin: cursor,
      endMin: cursor + minutes,
      minutes,
      activity: share.activity,
      confidence: share.confidence,
      reason:
        cluster.length > 1
          ? `${share.reason}; apportioned ${minutes}m of a ${spanEnd - spanStart}m window shared by ${shares.size} activit${shares.size === 1 ? 'y' : 'ies'}${droppedNote}`
          : share.reason,
      signalIds: share.signalIds,
      subjects: share.subjects,
      weight: share.weight,
      ...(share.taskId !== undefined ? { taskId: share.taskId } : {}),
    });
    cursor += minutes;
  }

  return out;
}

/**
 * Classify a run from everything it touched.
 *
 * Subjects and paths are voted on together via `bestGuess`; a run with several
 * subjects that agree gets a small confidence bump, because independent
 * evidence pointing the same way is stronger than one commit message.
 */
export function classifyRun(
  subjects: readonly string[],
  paths: readonly string[],
): ActivityGuess {
  const subjectGuesses = subjects.map((s) => guessFromSubject(s));
  const guess = bestGuess(guessFromPaths(paths), ...subjectGuesses);

  const agreeing = subjectGuesses.filter((g) => g?.activity === guess.activity).length;
  if (agreeing > 1) {
    return {
      ...guess,
      confidence: Math.min(0.95, guess.confidence + 0.1),
      reason: `${guess.reason}; ${agreeing} signals agree`,
    };
  }
  return guess;
}

/**
 * Fold neighbouring blocks that share a project and activity.
 *
 * Two commits 30 minutes apart on the same feature are one stretch of work in
 * any honest timesheet, even though the gap rule split them. Merging keeps the
 * sheet readable — the team logs a handful of rows a day, not twenty.
 */
export function mergeAdjacentSameActivity(
  blocks: readonly InferredBlock[],
  policy: WorkdayPolicy,
): InferredBlock[] {
  const out: InferredBlock[] = [];
  for (const b of blocks) {
    const last = out[out.length - 1];
    const contiguous =
      last &&
      last.projectKey === b.projectKey &&
      last.activity === b.activity &&
      b.startMin - last.endMin <= policy.roundToMin;

    if (contiguous && last) {
      last.endMin = Math.max(last.endMin, b.endMin);
      last.minutes = last.endMin - last.startMin;
      last.signalIds.push(...b.signalIds);
      last.subjects = [...new Set([...last.subjects, ...b.subjects])];
      last.confidence = Math.max(last.confidence, b.confidence);
      last.weight += b.weight;
      // A merged block must not carry a task its halves disagree on — the
      // merged signals no longer name one task, so the task link would be a
      // guess. The task survives only while both halves name the same one.
      //
      // Dormant in the current pipeline: reconstruct assigns taskId *after*
      // inferBlocks returns, so blocks reaching here carry none, and consensus
      // is enforced by agreeOnTask instead. Kept because this function is
      // exported — a caller that pre-assigns tasks gets the rule, not a silent
      // wrong link.
      if (last.taskId !== b.taskId) delete last.taskId;
    } else {
      out.push({ ...b, signalIds: [...b.signalIds], subjects: [...b.subjects] });
    }
  }
  return out;
}

/** Bucket signals by local calendar day, so each day infers independently. */
export function groupSignalsByDay(signals: readonly Signal[]): Map<string, Signal[]> {
  const byDay = new Map<string, Signal[]>();
  for (const s of signals) {
    const y = s.at.getFullYear();
    const m = String(s.at.getMonth() + 1).padStart(2, '0');
    const d = String(s.at.getDate()).padStart(2, '0');
    const key = `${y}-${m}-${d}`;
    const list = byDay.get(key);
    if (list) list.push(s);
    else byDay.set(key, [s]);
  }
  return byDay;
}
