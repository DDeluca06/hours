// ---------------------------------------------------------------------------
// Configuration.
//
// Two layers, in precedence order: environment (secrets, ids, the operator's
// name) and an optional `hours.config.json` in the repo root (project registry,
// workday policy). Secrets never go in the JSON file; project definitions never
// go in the environment. Nothing here throws on load — a missing credential
// only matters when you actually push, and `hours log` must work offline.
// ---------------------------------------------------------------------------

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_PROJECTS, DEFAULT_WORKDAY, type ProjectDef, type WorkdayPolicy } from '@hours/core';

export interface HoursConfig {
  /** Name written into the sheet's Person column. */
  person: string;
  /** Spreadsheet id of the shared Hours sheet. */
  sheetId: string | undefined;
  /** Base64 service-account JSON, same convention as the LP repo. */
  serviceAccountJson: string | undefined;
  projects: ProjectDef[];
  workday: WorkdayPolicy;
  /** SQLite file backing the local store. */
  databaseUrl: string;
  /** Keep inferred work that fell outside the 9–3 window. */
  allowOutsideWorkday: boolean;
}

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

interface FileConfig {
  person?: string;
  projects?: ProjectDef[];
  workday?: Partial<WorkdayPolicy>;
  allowOutsideWorkday?: boolean;
}

function readFileConfig(): FileConfig {
  for (const name of ['hours.config.json', 'hours.config.local.json']) {
    try {
      const raw = readFileSync(resolve(REPO_ROOT, name), 'utf-8');
      return JSON.parse(raw) as FileConfig;
    } catch {
      // Absent or unreadable is the normal case — defaults are usable.
    }
  }
  return {};
}

let cached: HoursConfig | null = null;

export function loadConfig(): HoursConfig {
  if (cached) return cached;
  const file = readFileConfig();
  const env = process.env;

  cached = {
    person: env['HOURS_PERSON'] ?? file.person ?? '',
    sheetId: env['HOURS_SHEET_ID'] ?? env['GOOGLE_SHEETS_HOURS_ID'],
    serviceAccountJson: env['GOOGLE_SERVICE_ACCOUNT_JSON'],
    projects: file.projects ?? DEFAULT_PROJECTS,
    workday: { ...DEFAULT_WORKDAY, ...file.workday },
    databaseUrl: env['DATABASE_URL'] ?? `file:${resolve(REPO_ROOT, 'hours.db')}`,
    allowOutsideWorkday: env['HOURS_ALLOW_OUTSIDE'] === '1' || file.allowOutsideWorkday === true,
  };
  return cached;
}

/** Reset the memoized config. Tests only. */
export function resetConfigCache(): void {
  cached = null;
}

/**
 * Assert the config has everything a push needs.
 *
 * Called only on the write path, so read-only and offline commands stay usable
 * on a machine with no credentials — which is the state this repo was built in.
 */
export function requirePushConfig(cfg: HoursConfig = loadConfig()): {
  sheetId: string;
  serviceAccountJson: string;
  person: string;
} {
  const missing: string[] = [];
  if (!cfg.sheetId) missing.push('HOURS_SHEET_ID');
  if (!cfg.serviceAccountJson) missing.push('GOOGLE_SERVICE_ACCOUNT_JSON');
  if (!cfg.person) missing.push('HOURS_PERSON');
  if (missing.length) {
    throw new Error(
      `cannot push: ${missing.join(', ')} not set. Copy .env.example to .env and fill them in.`,
    );
  }
  return {
    sheetId: cfg.sheetId as string,
    serviceAccountJson: cfg.serviceAccountJson as string,
    person: cfg.person,
  };
}
