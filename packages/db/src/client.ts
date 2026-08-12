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

// The collector is long-lived and reloads modules on restart; reusing one client
// avoids leaking a SQLite handle per reload.
export const prisma: PrismaClient =
  globalForPrisma.prisma ??
  new PrismaClient({
    adapter: new PrismaBetterSqlite3({ url: cfg.databaseUrl }),
  });

if (process.env['NODE_ENV'] !== 'production') globalForPrisma.prisma = prisma;
