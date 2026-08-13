// OpenCode storage reading, against a synthetic storage tree. The JSON shapes
// are copied from real files written by OpenCode 1.1.x — in particular the
// assistant message's `time.completed`, which is the only measured turn duration
// any harness hands us directly.

import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
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

let root: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'hours-opencode-'));
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

describe('collectOpenCodeSignals', () => {
  it('reads the assistant turn as a measured span', async () => {
    const signals = await collectOpenCodeSignals({ since, projects: PROJECTS, root });
    const asst = signals.find((s) => s.sourceId === 'opencode:ses_live:msg_asst');
    expect(asst?.until).toBeDefined();
    expect((asst?.until as Date).getTime() - asst!.at.getTime()).toBe(40 * 60_000 - 5_000);
  });

  it('leaves a prompt as a point signal and carries the session title', async () => {
    const signals = await collectOpenCodeSignals({ since, projects: PROJECTS, root });
    const user = signals.find((s) => s.sourceId === 'opencode:ses_live:msg_user');
    expect(user?.until).toBeUndefined();
    expect(user?.subject).toBe('Wire up the retry helper');
  });

  it('attributes a foreign home path once it is localized', async () => {
    const signals = await collectOpenCodeSignals({ since, projects: PROJECTS, root });
    expect(signals.every((s) => s.projectKey === 'north10')).toBe(true);
  });

  it('leaves the work unattributed when home remapping is off', async () => {
    const signals = await collectOpenCodeSignals({
      since,
      projects: PROJECTS,
      root,
      remapHome: false,
    });
    expect(signals.every((s) => s.projectKey === null)).toBe(true);
  });

  it('skips sessions untouched inside the window', async () => {
    const signals = await collectOpenCodeSignals({ since, projects: PROJECTS, root });
    expect(signals.some((s) => s.sourceId.includes('ses_stale'))).toBe(false);
  });

  it('caps the span', async () => {
    const signals = await collectOpenCodeSignals({
      since,
      projects: PROJECTS,
      root,
      maxSpanMin: 5,
    });
    const asst = signals.find((s) => s.sourceId === 'opencode:ses_live:msg_asst');
    expect((asst?.until as Date).getTime() - asst!.at.getTime()).toBe(5 * 60_000);
  });

  it('returns nothing rather than throwing when OpenCode was never installed', async () => {
    const signals = await collectOpenCodeSignals({
      since,
      projects: PROJECTS,
      root: join(root, 'nope'),
    });
    expect(signals).toEqual([]);
  });
});
