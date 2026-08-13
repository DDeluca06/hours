// Editor local-history reading. The entries.json shape is copied from a real
// VSCodium history directory, including the `vscode-userdata:` resource the
// editor writes for its own settings — which must never become a work signal.

import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import type { ProjectDef } from '@hours/core';
import {
  collectEditorHistorySignals,
  defaultHistoryRoots,
  resourcePath,
} from './editor-history.js';

const HOME = homedir();
const REPO = join(HOME, 'Projects', 'NorthAI');

const PROJECTS: ProjectDef[] = [
  { key: 'north10', name: 'North10AI', sheetTab: 'North10AI', repoPaths: [REPO] },
];

function ms(time: string): number {
  const [h, m] = time.split(':').map(Number);
  return new Date(2026, 7, 12, h ?? 0, m ?? 0, 0).getTime();
}

let root: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'hours-editor-'));

  const write = async (dir: string, body: unknown): Promise<void> => {
    await mkdir(join(root, dir), { recursive: true });
    await writeFile(join(root, dir, 'entries.json'), JSON.stringify(body), 'utf-8');
  };

  await write('-11c131cd', {
    version: 1,
    resource: `file://${join(REPO, 'packages', 'db', 'prisma', 'schema.prisma')}`,
    entries: [
      { id: 'aaa.prisma', timestamp: ms('09:30') },
      { id: 'bbb.prisma', timestamp: ms('09:50') },
      { id: 'old.prisma', timestamp: new Date(2026, 6, 1).getTime() },
    ],
  });

  // Outside every watched repo — real work, unknown project.
  await write('-22222222', {
    version: 1,
    resource: `file://${join(HOME, 'Projects', 'Grants', 'notes', 'bullets.md')}`,
    entries: [{ id: 'ccc.md', timestamp: ms('11:00') }],
  });

  // The editor's own settings, stored in the same place under another scheme.
  await write('-33333333', {
    version: 1,
    resource: `vscode-userdata:${join(HOME, '.config', 'VSCodium', 'User', 'settings.json')}`,
    entries: [{ id: 'ddd.json', timestamp: ms('12:00') }],
  });

  await write('-44444444', { version: 1 });
  await mkdir(join(root, '-55555555'), { recursive: true });
  await writeFile(join(root, '-55555555', 'entries.json'), '{ torn', 'utf-8');
});

const since = new Date(2026, 7, 12, 0, 0, 0);

describe('resourcePath', () => {
  it('accepts file URIs and rejects every other scheme', () => {
    expect(resourcePath('file:///repos/a/b.ts')).toBe('/repos/a/b.ts');
    expect(resourcePath('vscode-userdata:/home/x/settings.json')).toBeNull();
    expect(resourcePath('untitled:Untitled-1')).toBeNull();
  });

  it('decodes percent-escapes, so a path with a space still attributes', () => {
    expect(resourcePath('file:///repos/my%20app/b.ts')).toBe('/repos/my app/b.ts');
  });
});

describe('defaultHistoryRoots', () => {
  it('probes the VS Code forks in both platform locations', () => {
    const roots = defaultHistoryRoots('/home/test');
    expect(roots).toContain('/home/test/.config/VSCodium/User/History');
    expect(roots).toContain('/home/test/.config/Cursor/User/History');
    expect(roots).toContain('/home/test/Library/Application Support/Code/User/History');
  });
});

describe('collectEditorHistorySignals', () => {
  it('emits one file_edit per save inside the window', async () => {
    const signals = await collectEditorHistorySignals({ since, projects: PROJECTS, roots: [root] });
    const ids = signals.map((s) => s.sourceId);
    expect(ids).toContain('editor:-11c131cd:aaa.prisma');
    expect(ids).toContain('editor:-11c131cd:bbb.prisma');
    expect(ids).not.toContain('editor:-11c131cd:old.prisma');
    expect(signals.every((s) => s.kind === 'file_edit')).toBe(true);
  });

  it('leaves saves as point signals — a save is a trailing edge', async () => {
    const signals = await collectEditorHistorySignals({ since, projects: PROJECTS, roots: [root] });
    expect(signals.every((s) => s.until === undefined)).toBe(true);
  });

  it('reports repo-relative paths so the taxonomy rules match', async () => {
    const signals = await collectEditorHistorySignals({ since, projects: PROJECTS, roots: [root] });
    const schema = signals.find((s) => s.sourceId === 'editor:-11c131cd:aaa.prisma');
    expect(schema?.paths).toEqual(['packages/db/prisma/schema.prisma']);
    expect(schema?.projectKey).toBe('north10');
  });

  it('keeps work outside a watched repo, unattributed and absolute', async () => {
    const signals = await collectEditorHistorySignals({ since, projects: PROJECTS, roots: [root] });
    const grant = signals.find((s) => s.sourceId === 'editor:-22222222:ccc.md');
    expect(grant?.projectKey).toBeNull();
    expect(grant?.paths?.[0]).toBe(join(HOME, 'Projects', 'Grants', 'notes', 'bullets.md'));
  });

  it('ignores the editor settings it stores in the same directory', async () => {
    const signals = await collectEditorHistorySignals({ since, projects: PROJECTS, roots: [root] });
    expect(signals.some((s) => s.sourceId.startsWith('editor:-33333333'))).toBe(false);
  });

  it('skips malformed and empty index files', async () => {
    const signals = await collectEditorHistorySignals({ since, projects: PROJECTS, roots: [root] });
    expect(signals.some((s) => s.sourceId.startsWith('editor:-44444444'))).toBe(false);
    expect(signals.some((s) => s.sourceId.startsWith('editor:-55555555'))).toBe(false);
  });

  it('returns nothing for a root that does not exist', async () => {
    const signals = await collectEditorHistorySignals({
      since,
      projects: PROJECTS,
      roots: [join(root, 'nope')],
    });
    expect(signals).toEqual([]);
  });
});
