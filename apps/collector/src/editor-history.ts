// ---------------------------------------------------------------------------
// Editor local history as a signal source.
//
// VS Code and every fork of it keep a local history of file saves at
// <userDir>/History/<hash>/entries.json:
//
//   { "version": 1, "resource": "file:///abs/path.ts",
//     "entries": [ { "id": "kOK2.ts", "timestamp": 1775756940656 } ] }
//
// One entry per save, timestamped, with the file it belongs to — which is exactly
// the `file_edit` signal `KIND_WEIGHT` has always had a slot for and nothing was
// emitting. It closes the gap the other sources leave wide open: editing a
// spreadsheet-adjacent config, writing docs, or a long session of manual edits
// that ends in one commit at the end of the day.
//
// A save is a *trailing edge* like a commit — the editor records when the file
// was written, not when you started typing — so these are point signals with no
// `until`, and the lead-in guess applies as it always has.
//
// Deliberately lossy, and it has to be treated that way: local history is capped
// by `workbench.localHistory.maxFileEntries`, skips anything matching
// `workbench.localHistory.exclude`, and is off entirely if the user disabled it.
// Good evidence that you *were* working; never evidence that you were not.
// ---------------------------------------------------------------------------

import { readdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { projectForPath, type ProjectDef, type Signal } from '@hours/core';

/**
 * User-data directories of the editors that write this format.
 *
 * Names are the ones the editors actually use on disk, and absent ones cost a
 * failed `readdir` each. Both the Linux (`~/.config`) and macOS
 * (`~/Library/Application Support`) locations are listed because the file format
 * is identical and the check is free.
 */
const EDITOR_DIRS = [
  'Code',
  'Code - OSS',
  'Code - Insiders',
  'VSCodium',
  'Cursor',
  'Windsurf',
  'Trae',
];

export function defaultHistoryRoots(home = homedir()): string[] {
  const bases = [join(home, '.config'), join(home, 'Library', 'Application Support')];
  return bases.flatMap((base) => EDITOR_DIRS.map((dir) => join(base, dir, 'User', 'History')));
}

interface HistoryIndex {
  resource?: string;
  entries?: Array<{ id?: string; timestamp?: number; source?: string }>;
}

/**
 * Absolute path from a history `resource` URI, or null if it is not a real file.
 *
 * The editor stores its own settings under the `vscode-userdata:` scheme in the
 * same directory. Those are not project work and must not become signals, so
 * anything but `file:` is dropped rather than coerced.
 */
export function resourcePath(resource: string): string | null {
  if (!resource.startsWith('file://')) return null;
  try {
    return fileURLToPath(resource);
  } catch {
    return null;
  }
}

/** Repo-relative path when the file sits in a watched repo, else absolute. */
function describePath(absolute: string, project: ProjectDef | null): string {
  if (!project) return absolute;
  let best: string | null = null;
  for (const repo of project.repoPaths) {
    const r = repo.replace(/\/+$/, '');
    if (absolute === r || absolute.startsWith(`${r}/`)) {
      if (!best || r.length > best.length) best = r;
    }
  }
  return best ? relative(best, absolute) : absolute;
}

export interface CollectEditorHistoryOptions {
  since: Date;
  projects: readonly ProjectDef[];
  /** Override the history roots. Tests, and operators with a portable install. */
  roots?: readonly string[];
}

export async function collectEditorHistorySignals(
  opts: CollectEditorHistoryOptions,
): Promise<Signal[]> {
  const roots = opts.roots ?? defaultHistoryRoots();
  const sinceMs = opts.since.getTime();
  const out: Signal[] = [];

  for (const root of roots) {
    let dirs: string[];
    try {
      dirs = await readdir(root);
    } catch {
      continue; // That editor is not installed, or has no history yet.
    }

    for (const dir of dirs) {
      let index: HistoryIndex;
      try {
        index = JSON.parse(await readFile(join(root, dir, 'entries.json'), 'utf-8')) as HistoryIndex;
      } catch {
        continue;
      }
      if (!index.resource) continue;
      const absolute = resourcePath(index.resource);
      if (!absolute) continue;

      const project = projectForPath(absolute, opts.projects);
      const described = describePath(absolute, project);

      for (const entry of index.entries ?? []) {
        if (!entry.id || typeof entry.timestamp !== 'number') continue;
        if (entry.timestamp < sinceMs) continue;

        out.push({
          // The directory hash is the editor's own key for this file and the
          // entry id is unique within it, so this survives the file being
          // renamed, the history being pruned, and two editors watching the
          // same file — each keeps its own directory.
          sourceId: `editor:${dir}:${entry.id}`,
          kind: 'file_edit',
          at: new Date(entry.timestamp),
          projectKey: project?.key ?? null,
          paths: [described],
        });
      }
    }
  }

  return out;
}
