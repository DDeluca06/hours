// OpenCode storage reading, against synthetic stores. OpenCode 1.18+ keeps
// sessions in SQLite opencode.db (`session_v2` + `session_message`); the JSON
// tree under storage/ is the pre-1.18 layout and the fallback. The JSON shapes
// are copied from real files written by OpenCode 1.1.x, and the DB rows from
// 1.18.4 — in particular the assistant message's `time.completed`, which is the
// only measured turn duration any harness hands us directly.

import { mkdtempSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import Database from 'better-sqlite3';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import type { ProjectDef } from '@hours/core';
import { collectOpenCodeSignals, localizeHome } from './opencode-sessions.js';

const HOME = homedir();

const PROJECTS: ProjectDef[] = [
  {
    key: 'north10',
    name: 'North10AI',
    sheetTab: 'North10AI',
    repoPaths: [join(HOME, 'Projects', 'NorthAI')],
  },
];

function ms(time: string): number {
  const [h, m, s] = time.split(':').map(Number);
  return new Date(2026, 7, 12, h ?? 0, m ?? 0, s ?? 0).getTime();
}

// The temp dir must exist at module scope: the STORES table below is evaluated
// while the file is imported, before `beforeAll` runs.
const root = mkdtempSync(join(tmpdir(), 'hours-opencode-'));
const dbPath = join(root, 'opencode.db');

beforeAll(async () => {
  await mkdir(join(root, 'session', 'global'), { recursive: true });
  await mkdir(join(root, 'message', 'ses_live'), { recursive: true });
  await mkdir(join(root, 'message', 'ses_stale'), { recursive: true });

  // A session synced from another machine: its absolute paths carry a home
  // directory that does not exist here.
  await writeFile(
    join(root, 'session', 'global', 'ses_live.json'),
    JSON.stringify({
      id: 'ses_live',
      directory: '/home/someoneelse/Projects/NorthAI',
      title: 'Wire up the retry helper',
      time: { created: ms('10:00:00'), updated: ms('10:40:00') },
    }),
    'utf-8',
  );
  await writeFile(
    join(root, 'message', 'ses_live', 'msg_user.json'),
    JSON.stringify({ id: 'msg_user', role: 'user', time: { created: ms('10:00:00') } }),
    'utf-8',
  );
  await writeFile(
    join(root, 'message', 'ses_live', 'msg_asst.json'),
    JSON.stringify({
      id: 'msg_asst',
      role: 'assistant',
      time: { created: ms('10:00:05'), completed: ms('10:40:00') },
      path: { cwd: '/home/someoneelse/Projects/NorthAI', root: '/home/someoneelse/Projects/NorthAI' },
      tokens: { input: 700, output: 120 },
      cost: 0.002,
    }),
    'utf-8',
  );

  // Untouched for months — must not be opened at all.
  await writeFile(
    join(root, 'session', 'global', 'ses_stale.json'),
    JSON.stringify({
      id: 'ses_stale',
      directory: join(HOME, 'Projects', 'NorthAI'),
      title: 'Old work',
      time: { created: ms('01:00:00'), updated: new Date(2026, 1, 26).getTime() },
    }),
    'utf-8',
  );
  await writeFile(
    join(root, 'message', 'ses_stale', 'msg_old.json'),
    JSON.stringify({ id: 'msg_old', role: 'user', time: { created: new Date(2026, 1, 26).getTime() } }),
    'utf-8',
  );

  await writeFile(join(root, 'session', 'global', 'broken.json'), '{ not json', 'utf-8');

  // The same fixture as the JSON tree, in the SQLite layout OpenCode 1.18+
  // actually writes. `ses_live` carries a foreign home (synced machine),
  // `ses_stale` predates the window, and `msg_junk` holds unparsable JSON —
  // the DB reader must skip it, exactly as the JSON reader skips broken.json.
  const db = new Database(dbPath);
  db.exec(`CREATE TABLE session_v2 (
      id TEXT PRIMARY KEY, directory TEXT, path TEXT, title TEXT,
      time_created INTEGER, time_updated INTEGER
    )`);
  db.exec(`CREATE TABLE session_message (
      id TEXT PRIMARY KEY, session_id TEXT, type TEXT, seq INTEGER,
      time_created INTEGER, time_updated INTEGER, data TEXT
    )`);
  const sess = db.prepare(
    'INSERT INTO session_v2 (id, directory, path, title, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?)',
  );
  sess.run(
    'ses_live',
    '/home/someoneelse/Projects/NorthAI',
    '',
    'Wire up the retry helper',
    ms('10:00:00'),
    ms('10:40:00'),
  );
  sess.run(
    'ses_stale',
    join(HOME, 'Projects', 'NorthAI'),
    '',
    'Old work',
    ms('01:00:00'),
    new Date(2026, 1, 26).getTime(),
  );
  const msg = db.prepare(
    'INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?, ?)',
  );
  msg.run('msg_user', 'ses_live', 'user', 1, ms('10:00:00'), ms('10:00:00'), '{"time":{"created":' + ms('10:00:00') + '}}');
  msg.run(
    'msg_asst',
    'ses_live',
    'assistant',
    2,
    ms('10:00:05'),
    ms('10:40:00'),
    JSON.stringify({
      time: { created: ms('10:00:05'), completed: ms('10:40:00') },
      path: { cwd: '/home/someoneelse/Projects/NorthAI', root: '/home/someoneelse/Projects/NorthAI' },
      tokens: { input: 700, output: 120 },
      cost: 0.002,
    }),
  );
  msg.run(
    'msg_old',
    'ses_stale',
    'user',
    1,
    new Date(2026, 1, 26).getTime(),
    new Date(2026, 1, 26).getTime(),
    '{"time":{"created":' + new Date(2026, 1, 26).getTime() + '}}',
  );
  msg.run('msg_junk', 'ses_live', 'assistant', 3, ms('10:01:00'), ms('10:01:00'), '{ not json');
  db.close();
});

const since = new Date(2026, 7, 12, 0, 0, 0);

describe('localizeHome', () => {
  it('rewrites another machine home onto this one', () => {
    expect(localizeHome('/home/someoneelse/Projects/NorthAI')).toBe(
      join(HOME, 'Projects', 'NorthAI'),
    );
    expect(localizeHome('/Users/mac-person/code/app')).toBe(join(HOME, 'code', 'app'));
  });

  it('leaves local and non-home paths alone', () => {
    expect(localizeHome(HOME)).toBe(HOME);
    expect(localizeHome(join(HOME, 'Projects'))).toBe(join(HOME, 'Projects'));
    expect(localizeHome('/srv/shared/repo')).toBe('/srv/shared/repo');
  });
});

// The same behaviors must hold against both stores: the legacy JSON tree
// (pre-1.18 fallback) and the SQLite database (1.18+). The `dbPath` for the
// legacy mode points at a file that does not exist so the DB path is not
// accidentally exercised — a real machine's opencode.db is not a fixture.
const STORES: Array<{
  name: string;
  opts: { root?: string; dbPath?: string };
}> = [
  { name: 'legacy JSON tree', opts: { root, dbPath: join(root, 'missing.db') } },
  { name: 'SQLite database', opts: { dbPath } },
];

for (const store of STORES) {
  describe(`collectOpenCodeSignals — ${store.name}`, () => {
    function collect(extra: { maxSpanMin?: number; remapHome?: boolean } = {}) {
      return collectOpenCodeSignals({ since, projects: PROJECTS, ...store.opts, ...extra });
    }

    it('reads the assistant turn as a measured span', async () => {
      const signals = await collect();
      const asst = signals.find((s) => s.sourceId === 'opencode:ses_live:msg_asst');
      expect(asst?.until).toBeDefined();
      expect((asst?.until as Date).getTime() - asst!.at.getTime()).toBe(40 * 60_000 - 5_000);
    });

    it('leaves a prompt as a point signal and carries the session title', async () => {
      const signals = await collect();
      const user = signals.find((s) => s.sourceId === 'opencode:ses_live:msg_user');
      expect(user?.until).toBeUndefined();
      expect(user?.subject).toBe('Wire up the retry helper');
    });

    it('attributes a foreign home path once it is localized', async () => {
      const signals = await collect();
      expect(signals.every((s) => s.projectKey === 'north10')).toBe(true);
    });

    it('leaves the work unattributed when home remapping is off', async () => {
      const signals = await collect({ remapHome: false });
      expect(signals.every((s) => s.projectKey === null)).toBe(true);
    });

    it('skips sessions untouched inside the window', async () => {
      const signals = await collect();
      expect(signals.some((s) => s.sourceId.includes('ses_stale'))).toBe(false);
    });

    it('caps the span', async () => {
      const signals = await collect({ maxSpanMin: 5 });
      const asst = signals.find((s) => s.sourceId === 'opencode:ses_live:msg_asst');
      expect((asst?.until as Date).getTime() - asst!.at.getTime()).toBe(5 * 60_000);
    });

    it('skips unreadable message data', async () => {
      const signals = await collect();
      expect(signals.some((s) => s.sourceId.includes('msg_junk') || s.sourceId.includes('broken'))).toBe(false);
    });
  });
}

describe('collectOpenCodeSignals — store selection', () => {
  it('returns nothing rather than throwing when OpenCode was never installed', async () => {
    const signals = await collectOpenCodeSignals({
      since,
      projects: PROJECTS,
      root: join(root, 'nope'),
      dbPath: join(root, 'nope.db'),
    });
    expect(signals).toEqual([]);
  });

  it('prefers the SQLite database when both stores exist', async () => {
    const dbSignals = await collectOpenCodeSignals({ since, projects: PROJECTS, dbPath });
    const legacySignals = await collectOpenCodeSignals({
      since,
      projects: PROJECTS,
      dbPath: join(root, 'missing.db'),
      root,
    });
    // Both carry the same logical session, but the sourceIds differ per store,
    // so compare the underlying at-times rather than the ids.
    const ats = (sigs: { at: Date }[]) => sigs.map((s) => s.at.getTime()).sort();
    expect(ats(dbSignals)).toEqual(ats(legacySignals));
  });
});
