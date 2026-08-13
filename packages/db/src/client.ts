// ---------------------------------------------------------------------------
// Prisma client.
//
// Prisma 7 requires a driver adapter, and the URL comes from config rather than
// the schema. SQLite via better-sqlite3 is the default so that `hours log` works
// with nothing running — no Docker, no network. Swapping to the LP repo's
// Postgres means changing the adapter here and the provider in schema.prisma.
// ---------------------------------------------------------------------------

import { PrismaBetterSqlite3 } from '@prisma/adapter-better-sqlite3';
import { loadConfig } from '@hours/config';
import { PrismaClient } from '../generated/client/client.js';

const cfg = loadConfig();

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

/**
 * How long SQLite itself waits for another process's write lock.
 *
 * Deliberately short. The instinct is to set this high so writers wait each
 * other out, but that fails in an instructive way: waiting happens *inside* the
 * transaction, so a generous busy timeout runs down Prisma's transaction budget
 * and the write dies as "Operation has timed out" instead of succeeding. With
 * eight concurrent processes that was 4 of 8 failing.
 *
 * So SQLite gives up quickly and `withBusyRetry` owns the waiting instead —
 * outside the transaction, where a rolled-back attempt holds no locks and a
 * retry can actually make progress.
 */
const BUSY_TIMEOUT_MS = 250;

/**
 * Transaction budget. `maxWait` is how long to wait for a connection, `timeout`
 * how long the body may run. Both are far above what these transactions need —
 * a few statements against a local file — because the cost of hitting them is a
 * failed write and the cost of setting them high is nothing.
 */
export const TX_OPTIONS = { maxWait: 5_000, timeout: 15_000 } as const;

// The collector is long-lived and reloads modules on restart; reusing one client
// avoids leaking a SQLite handle per reload.
export const prisma: PrismaClient =
  globalForPrisma.prisma ??
  new PrismaClient({
    adapter: new PrismaBetterSqlite3({ url: cfg.databaseUrl, timeout: BUSY_TIMEOUT_MS }),
  });

if (process.env['NODE_ENV'] !== 'production') globalForPrisma.prisma = prisma;

/**
 * Put the database in WAL mode, once per process.
 *
 * The default rollback journal takes an exclusive lock for the whole of every
 * write, so a reader arriving mid-write fails rather than waits — with three
 * agent processes and a daemon on one file, that is a routine occurrence rather
 * than a corner case. WAL lets readers proceed against the last committed state
 * while one writer works, which is exactly this workload.
 *
 * The setting is persistent in the file header, so this is a no-op after the
 * first time. It is deliberately not fatal: a read-only filesystem or a
 * Postgres URL is a reason to carry on in the default mode, not to refuse to
 * log time.
 */
async function configureConcurrency(): Promise<void> {
  if (!cfg.databaseUrl.startsWith('file:')) return;
  try {
    // $queryRaw, not $executeRaw: both pragmas answer with a row, and the
    // execute path rejects statements that return results.
    await prisma.$queryRawUnsafe('PRAGMA journal_mode = WAL');
    await prisma.$queryRawUnsafe(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
  } catch (err) {
    if (process.env['HOURS_DEBUG']) {
      console.error(`could not set SQLite concurrency pragmas: ${String(err)}`);
    }
  }
}

await configureConcurrency();

// Retry policy lives in retry.ts, which has no database import so it can be
// tested on its own. Re-exported here because every caller already imports the
// client, and the two belong together at the call site.
export { withBusyRetry } from './retry.js';
