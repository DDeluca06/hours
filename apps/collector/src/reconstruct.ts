// ---------------------------------------------------------------------------
// End-of-day reconstruction.
//
// Reads a day's unconsumed signals, infers blocks, and writes them as *draft*
// entries. Nothing here is authoritative — the whole point is to hand you a
// starting draft at 3 PM instead of a blank cell, and every draft carries its
// provenance so you can tell why the tool thinks you spent 90 minutes on a data
// model.
//
// Signals are marked consumed as they are folded in, so re-running is safe: it
// picks up only what arrived since.
// ---------------------------------------------------------------------------

import { loadConfig } from '@hours/config';
import {
  agreeOnTask,
  entryFromBlock,
  inferBlocks,
  localDayKey,
  signalTaskRef,
  type Entry,
  type InferredBlock,
} from '@hours/core';
import { consumeSignals, createEntries, getTask, loadSignals, type StoredEntry } from '@hours/lib-db';

export interface ReconstructResult {
  day: string;
  created: StoredEntry[];
  /** Blocks that could not be attributed to a project — need your input. */
  unattributed: InferredBlock[];
  signalsRead: number;
}

export interface ReconstructOptions {
  /** Local day, YYYY-MM-DD. Defaults to today. */
  day?: string;
  /** Write nothing; just report what would be created. */
  dryRun?: boolean;
  /** Person for the created rows. Defaults to config. */
  person?: string;
}

export async function reconstruct(opts: ReconstructOptions = {}): Promise<ReconstructResult> {
  const cfg = loadConfig();
  const day = opts.day ?? localDayKey(new Date());
  const person = opts.person ?? cfg.person;
  if (!person) {
    throw new Error('HOURS_PERSON is not set — reconstruction needs a name for the Person column');
  }

  const signals = await loadSignals({ day, unconsumedOnly: true });
  const blocks = inferBlocks(signals, {
    policy: cfg.workday,
    allowOutsideWorkday: cfg.allowOutsideWorkday,
  });

  // Task attribution: a block carries a task only when its signals *agree* on
  // one ref AND the cache has seen that task. The parsing is pure (taskrefs.ts)
  // and the cache lives here, so this step is the seam between them. It runs
  // even in dryRun — reporting what *would* be attributed is the point of the
  // dry run — and it adds no signals and consumes none.
  const bySourceId = new Map(signals.map((s) => [s.sourceId, s]));
  for (const b of blocks) {
    // A signal missing from the map (it was filtered between load and here)
    // votes null, which never breaks consensus toward a task.
    const refs = b.signalIds.map((id) => signalTaskRef(bySourceId.get(id) ?? { kind: '' }));
    const candidate = agreeOnTask(refs);
    if (candidate === null) continue;

    const cached = await getTask(candidate);
    if (cached) {
      b.taskId = candidate;
    } else {
      // The entry is still created for the project — project attribution is
      // separate, only the task link waits — and the ref is not lost: it lands
      // in the reason so the reviewer sees why there is no task. The sweep
      // refreshes the cache every 10 minutes, so a missing task resolves on
      // the next run.
      b.reason = `${b.reason}; task #${candidate} ref seen but not cached yet (sweep will sync it)`;
    }
  }

  const attributed: InferredBlock[] = [];
  const unattributed: InferredBlock[] = [];
  for (const b of blocks) {
    if (b.projectKey) attributed.push(b);
    else unattributed.push(b);
  }

  if (opts.dryRun) {
    return { day, created: [], unattributed, signalsRead: signals.length };
  }

  const entries: Entry[] = attributed.map((b) =>
    entryFromBlock(b, day, person, b.projectKey as string),
  );
  const created = await createEntries(entries);

  // Only consume the signals that actually became entries. An unattributed
  // block's signals stay in the pool so assigning a project later still works.
  await consumeSignals(attributed.flatMap((b) => b.signalIds));

  return { day, created, unattributed, signalsRead: signals.length };
}
