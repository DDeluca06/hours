// ---------------------------------------------------------------------------
// Project registry.
//
// A project is the join between three things: a tab in the shared Hours sheet,
// one or more local repo paths the collector watches, and a short key you type
// on the CLI. Anything the collector observes outside a registered repo path is
// still recorded as a signal, but lands with no project and has to be assigned
// during review — better an explicit gap than a mislabeled push.
//
// This defaults to the two engagements the team actually works in, and is
// overridable from config so a third project needs no code change.
// ---------------------------------------------------------------------------

export interface ProjectDef {
  /** Short CLI key: `hours log 90 dev --project north10`. */
  key: string;
  /** Human name. */
  name: string;
  /** Exact tab title in the Hours spreadsheet. Case- and space-sensitive. */
  sheetTab: string;
  /** Absolute repo paths whose git activity belongs to this project. */
  repoPaths: string[];
  /** Contract ceiling in hours, if the engagement has one. */
  contractHours?: number;
}

export const DEFAULT_PROJECTS: ProjectDef[] = [
  {
    key: 'north10',
    name: 'North10AI',
    sheetTab: 'North10AI',
    repoPaths: ['/home/mili/Projects/NorthAI'],
  },
  {
    key: 'lp',
    name: 'LP Internal AI',
    sheetTab: 'LP Internal AI',
    repoPaths: ['/home/mili/Projects/lp-internal-ai-v1'],
  },
];

/**
 * Find the project that owns a filesystem path.
 *
 * Longest-prefix wins, so nesting one watched repo inside another resolves to
 * the inner one instead of silently picking whichever was registered first.
 */
export function projectForPath(
  path: string,
  projects: readonly ProjectDef[] = DEFAULT_PROJECTS,
): ProjectDef | null {
  const norm = path.replace(/\/+$/, '');
  let best: { project: ProjectDef; len: number } | null = null;
  for (const p of projects) {
    for (const repo of p.repoPaths) {
      const r = repo.replace(/\/+$/, '');
      if (norm === r || norm.startsWith(`${r}/`)) {
        if (!best || r.length > best.len) best = { project: p, len: r.length };
      }
    }
  }
  return best?.project ?? null;
}

export function projectByKey(
  key: string,
  projects: readonly ProjectDef[] = DEFAULT_PROJECTS,
): ProjectDef | null {
  const t = key.trim().toLowerCase();
  return (
    projects.find((p) => p.key.toLowerCase() === t) ??
    projects.find((p) => p.name.toLowerCase() === t) ??
    projects.find((p) => p.sheetTab.toLowerCase() === t) ??
    null
  );
}
