import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import { defineConfig, env } from 'prisma/config';

const configDir = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(configDir, '.env') });

// SQLite by default, so `pnpm db:push` works on a fresh clone with no .env.
if (!process.env['DATABASE_URL']) {
  process.env['DATABASE_URL'] = `file:${path.resolve(configDir, 'hours.db')}`;
}

export default defineConfig({
  schema: 'packages/db/prisma/schema.prisma',
  migrations: {
    path: 'packages/db/prisma/migrations',
  },
  datasource: {
    url: env('DATABASE_URL'),
  },
});
