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
  entryFromBlock,
  inferBlocks,
  localDayKey,
  type Entry,
  type InferredBlock,
} from '@hours/core';
import { consumeSignals, createEntries, loadSignals, type StoredEntry } from '@hours/lib-db';

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
