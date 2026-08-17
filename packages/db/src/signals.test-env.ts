// Side-effect module: point the shared prisma client at a throwaway SQLite file
// BEFORE client.ts is imported. Import this first, then the modules under test —
// ESM runs imports in source order, so the env is set before the client
// singleton is created.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env['DATABASE_URL'] = `file:${join(mkdtempSync(join(tmpdir(), 'hours-signals-')), 'test.db')}`;
