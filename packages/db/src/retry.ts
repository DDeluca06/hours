// ---------------------------------------------------------------------------
// Write retries for a database several processes share.
//
// Deliberately free of any Prisma or config import, so the policy can be tested
// without a database — the reason this lives apart from client.ts.
//
// The problem it solves is specific. SQLite's busy handler does *not* run when a
// deferred transaction that already holds a read lock tries to upgrade to a
// write lock: retrying inside the connection could deadlock, so it returns
// SQLITE_BUSY immediately instead. Every read-then-write pair in this package is
// that shape, and with the CLI, two MCP servers and the collector daemon on one
// file it happens for real — measured at 3 of 6 concurrent processes failing
// outright before this existed.
//
// Retrying from outside the transaction is what works: the failed attempt rolled
// back and holds nothing, so a fresh one re-reads current state and takes its
// locks from scratch. That is also the constraint on callers — wrap a whole
// transaction, never a half-applied batch of statements.
// ---------------------------------------------------------------------------

export interface BusyRetryOptions {
  /** Total tries, including the first. */
  attempts?: number;
  baseDelayMs?: number;
  /** Ceiling on one wait. Capping matters more than the attempt count: uncapped
   *  exponential backoff spends its whole budget asleep in one long wait. */
  maxDelayMs?: number;
  /** Seam for tests, so they need neither a database nor real elapsed time. */
  sleep?: (ms: number) => Promise<void>;
  /** Seam for tests: full jitter by default. */
  random?: () => number;
}

/**
 * Twelve tries with the wait capped at 250ms is a worst case near 1.5s — longer
 * than any write here takes even under heavy contention, and short enough that a
 * genuinely stuck database surfaces as an error instead of a hang.
 */
const DEFAULTS = {
  attempts: 12,
  baseDelayMs: 10,
  maxDelayMs: 250,
} as const;

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Whether an error means "another process had the database", as opposed to
 * "this write was wrong".
 *
 * Matched on the message because Prisma wraps the driver error and gives these
 * no stable code — P2010 covers all raw failures and the adapter surfaces the
 * rest as a plain invocation error.
 *
 * Transaction-timeout wording counts. It is not a separate problem: a
 * transaction that ran out of budget did so waiting for a lock, and it rolled
 * back, so nothing was left behind and retrying is exactly right.
 */
export function isBusyError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /database is locked|database table is locked|SQLITE_BUSY|Operation has timed out|Transaction (?:already closed|not found|API error)/i.test(
    message,
  );
}

/** Run a write, retrying while another process holds the database. */
export async function withBusyRetry<T>(
  operation: () => Promise<T>,
  options: BusyRetryOptions = {},
): Promise<T> {
  const attempts = options.attempts ?? DEFAULTS.attempts;
  const baseDelayMs = options.baseDelayMs ?? DEFAULTS.baseDelayMs;
  const maxDelayMs = options.maxDelayMs ?? DEFAULTS.maxDelayMs;
  const sleep = options.sleep ?? defaultSleep;
  const random = options.random ?? Math.random;

  for (let attempt = 0; ; attempt++) {
    try {
      return await operation();
    } catch (err) {
      // A wrong write must surface immediately — retrying it only delays the
      // error and hides its cause.
      if (attempt >= attempts - 1 || !isBusyError(err)) throw err;
      // Full jitter rather than a fixed backoff: processes that collided once
      // are in lockstep, and a deterministic delay makes them collide again.
      const ceiling = Math.min(baseDelayMs * 2 ** attempt, maxDelayMs);
      await sleep(random() * ceiling);
    }
  }
}
