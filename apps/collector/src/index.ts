// ---------------------------------------------------------------------------
// The collector daemon.
//
// Sweeps on an interval and does nothing else — no inference, no writing to the
// sheet. Keeping it this boring is the point: it can crash, be killed, or miss a
// day, and the worst outcome is that `hours reconstruct` reads slightly sparser
// evidence, because a sweep re-reads history rather than tailing it live.
//
// Run it with `pnpm collect`, or leave it out entirely and rely on
// `hours collect` at the end of the day — the results are identical.
// ---------------------------------------------------------------------------

import { sweep } from './collect.js';

const INTERVAL_MS = Number(process.env['HOURS_COLLECT_INTERVAL_MS'] ?? 10 * 60 * 1000);
// First sweep reaches back a week so a fresh install has something to show.
const FIRST_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;

let stopping = false;

function log(message: string): void {
  console.log(`[${new Date().toISOString()}] ${message}`);
}

async function runOnce(lookbackMs: number): Promise<void> {
  try {
    const result = await sweep({ since: new Date(Date.now() - lookbackMs) });
    const detail = Object.entries(result.bySource)
      .filter(([, n]) => n > 0)
      .map(([k, n]) => `${k}=${n}`)
      .join(' ');
    log(`swept ${result.scanned} signals, ${result.recorded} new${detail ? ` (${detail})` : ''}`);
    for (const w of result.warnings) log(`  warning: ${w}`);
  } catch (err) {
    // Never exit on a failed sweep — a transient git lock or a mid-write
    // transcript must not take the daemon down for the rest of the day.
    log(`sweep failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function main(): Promise<void> {
  log(`collector starting, sweeping every ${Math.round(INTERVAL_MS / 60000)} min`);
  await runOnce(FIRST_LOOKBACK_MS);

  // Overlap the lookback with the interval so a sweep that starts late cannot
  // leave a gap.
  const lookback = INTERVAL_MS * 3;

  while (!stopping) {
    await new Promise((resolve) => setTimeout(resolve, INTERVAL_MS));
    if (stopping) break;
    await runOnce(lookback);
  }
  log('collector stopped');
}

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    if (stopping) process.exit(0);
    stopping = true;
    log(`${sig} received, finishing current sweep`);
  });
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.stack : err);
  process.exit(1);
});
