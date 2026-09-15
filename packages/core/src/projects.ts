// ---------------------------------------------------------------------------
// Project registry.
//
// A project is the join between three things: a tab in the shared Hours sheet,
// one or more local repo paths the collector watches, and a short key you type
// on the CLI. Anything the collector observes outside a registered repo path is
// still recorded as a signal, but lands with no project and has to be assigned
// during review — better an explicit gap than a mislabeled push.
//
// No project ships hardcoded here — the registry is entirely config-driven, so
// a fresh checkout with no `hours.config.json` tracks nothing rather than
// silently reusing whichever machine's paths used to be baked into source.
// Populate `projects` in `hours.config.json` (see hours.config.example.json);
// adding a new engagement needs no code change.
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
  /**
   * The value written into the tab's Project column, when that tab has one
   * (currently only "Inc Ops", which rolls up `ops`/`nixos`/`lpcli`). Must
   * match one of the dropdown's data-validation options exactly. Omitted on a
   * project whose tab has no Project column — `buildRowCells` never writes to
   * a column that doesn't exist there, so an omitted label is simply not
   * written rather than written blank.
   */
  sheetProjectLabel?: string;
  /**
   * Another project's `key`, if this one is a sub-project sharing that
   * project's tab rather than owning a tab of its own.
   *
   * A sub-project is a full `ProjectDef` — its own key, name and repoPaths, so
   * git signals still attribute correctly and `log_time`/`start_timer` still
   * take its key — but its `sheetTab` is deliberately the *same* tab as its
   * parent's, so a small piece of internal tooling gets its own identity in
   * the registry without asking for a new tab in the shared sheet. Nothing
   * enforces the two `sheetTab`s actually matching; `parent` is read by
   * anything that must not double-count a tab it already covers through the
   * parent (see `topLevelProjects`), and by tools that print the registry for
   * a human, not by the sheet connectors.
   */
  parent?: string;
}

export const DEFAULT_PROJECTS: ProjectDef[] = [];

/**
 * Projects that own their tab, i.e. everything except sub-projects.
 *
 * Used wherever a tab must be read or summed once per tab rather than once
 * per registry entry — a sub-project shares its parent's `sheetTab`, so
 * iterating every configured project and reading each one's tab would count
 * that tab's rows once per sub-project registered against it.
 * `log_time`/`start_timer`/`list_projects` still work with sub-project keys
 * directly; this only trims the "every project" default for tab-level rollups
 * (`invoice_summary`, the dashboard).
 */
export function topLevelProjects(projects: readonly ProjectDef[]): ProjectDef[] {
  return projects.filter((p) => p.parent === undefined);
}

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
