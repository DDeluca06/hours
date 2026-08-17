// ---------------------------------------------------------------------------
// Configuration.
//
// Two layers, in precedence order: environment (secrets, ids, the operator's
// name) and an optional `hours.config.json` in the repo root (project registry,
// workday policy). Secrets never go in the JSON file; project definitions never
// go in the environment. Nothing here throws on load — a missing credential
// only matters when you actually push, and `hours log` must work offline.
// ---------------------------------------------------------------------------

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_MAX_SPAN_MIN,
  DEFAULT_PROJECTS,
  DEFAULT_WORKDAY,
  type ProjectDef,
  type WorkdayPolicy,
} from '@hours/core';

/** OAuth client for the user-consent path (recommended over a service account). */
export interface OAuthSpec {
  clientId: string;
  clientSecret: string;
  /** Where the refresh token lives, e.g. ~/.config/hours/credentials.json. */
  tokenPath: string;
}

/**
 * Read-only OpenProject connection for the task-hours cache.
 *
 * `url` and `apiKey` come from the environment only (secrets stay out of
 * hours.config.json, same rule as the Google credentials); `projects` is the
 * only file-backed part — it maps an hours project key to an OpenProject
 * project identifier. A missing url/apiKey is fine on load: nothing here
 * throws, the connector just cannot sync until the env is filled in.
 */
export interface OpenProjectConfig {
  /** Base URL of the instance, e.g. https://projects.liftofflearning.tech. Env only. */
  url: string | undefined;
  /** API key used as Basic auth (`apikey:<key>`). Env only. */
  apiKey: string | undefined;
  /** Hours project key → OpenProject project identifier, e.g. { "north10": "north10-ai" }. */
  projects: Record<string, string> | undefined;
}

/**
 * Which agent harnesses and editors the sweep reads.
 *
 * All on by default, and a missing source is silently empty rather than an
 * error — the same machine may have three of these installed or one, and the
 * collector must not care. Turning one off is for when a harness is shared with
 * someone else's work, or when you want a day's timesheet to rest on commits
 * alone.
 */
export interface HarnessConfig {
  /** Claude Code transcripts under ~/.claude/projects. */
  claudeCode: boolean;
  /** OpenCode message storage under ~/.local/share/opencode. */
  openCode: boolean;
  /** VS Code-family local history (VSCodium, Cursor, …). */
  editors: boolean;
  /** WakaTime heartbeats from a self-hosted Wakapi server. Needs env creds to do anything. */
  wakapi: boolean;
  /** Cap on one turn's measured span, so a parked tool call can't bill lunch. */
  maxSpanMin: number;
  /** Rewrite a foreign home directory in OpenCode paths onto this machine's. */
  remapOpenCodeHome: boolean;
  /** Override the editor history roots. Undefined means probe the known ones. */
  editorHistoryRoots: string[] | undefined;
}

export interface HoursConfig {
  /** Name written into the sheet's Person column. */
  person: string;
  /** Spreadsheet id of the shared Hours sheet. */
  sheetId: string | undefined;
  /** Base64 service-account JSON, same convention as the LP repo. */
  serviceAccountJson: string | undefined;
  /** OAuth client for the user-consent path. Takes precedence over the service account. */
  googleOAuth: OAuthSpec | undefined;
  /** Read-only OpenProject connection for the task-hours cache. */
  openproject: OpenProjectConfig;
  /** Read-only Wakapi connection for heartbeat collection. Env only. */
  wakapi: { url: string | undefined; apiKey: string | undefined };
  projects: ProjectDef[];
  workday: WorkdayPolicy;
  harnesses: HarnessConfig;
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
  harnesses?: Partial<HarnessConfig>;
  allowOutsideWorkday?: boolean;
  /**
   * Only `projects` belongs here. `url`/`apiKey` are env-only — a secret in
   * the JSON file is ignored, not read (same rule as the Google credentials).
   */
  openproject?: { projects?: Record<string, string> };
}

function readFileConfig(): FileConfig {
  // HOURS_CONFIG_FILE points the loader at one exact file instead of the repo
  // root's. Tests use it so they never have to overwrite the operator's real
  // project registry, and it also lets a second checkout run against its own.
  const override = process.env['HOURS_CONFIG_FILE'];
  const candidates = override
    ? [override]
    : ['hours.config.json', 'hours.config.local.json'].map((n) => resolve(REPO_ROOT, n));

  for (const path of candidates) {
    try {
      const raw = readFileSync(path, 'utf-8');
      return JSON.parse(raw) as FileConfig;
    } catch {
      // Absent or unreadable is the normal case — defaults are usable.
    }
  }
  return {};
}

/**
 * A source toggle: env wins over the file, and only `0`/`false` turns one off.
 *
 * Opt-out rather than opt-in, and deliberately: a harness that quietly collects
 * nothing produces a timesheet that looks complete and is not, which is the one
 * failure mode worth designing against here.
 */
function toggle(envValue: string | undefined, fileValue: boolean | undefined): boolean {
  if (envValue !== undefined && envValue !== '') return envValue !== '0' && envValue !== 'false';
  return fileValue ?? true;
}

function resolveHarnesses(
  file: Partial<HarnessConfig> | undefined,
  env: NodeJS.ProcessEnv,
): HarnessConfig {
  const spanRaw = Number(env['HOURS_MAX_SPAN_MIN'] ?? file?.maxSpanMin ?? DEFAULT_MAX_SPAN_MIN);
  return {
    claudeCode: toggle(env['HOURS_HARNESS_CLAUDE'], file?.claudeCode),
    openCode: toggle(env['HOURS_HARNESS_OPENCODE'], file?.openCode),
    editors: toggle(env['HOURS_HARNESS_EDITORS'], file?.editors),
    wakapi: toggle(env['HOURS_HARNESS_WAKAPI'], file?.wakapi),
    // A garbled override falls back rather than throwing: nothing in this loader
    // throws, and an unbounded span is worse than the default one.
    maxSpanMin: Number.isFinite(spanRaw) && spanRaw > 0 ? spanRaw : DEFAULT_MAX_SPAN_MIN,
    remapOpenCodeHome: toggle(env['HOURS_OPENCODE_REMAP_HOME'], file?.remapOpenCodeHome),
    editorHistoryRoots: file?.editorHistoryRoots,
  };
}

let cached: HoursConfig | null = null;

function defaultTokenPath(): string {
  return join(homedir(), '.config', 'hours', 'credentials.json');
}

export function loadConfig(): HoursConfig {
  if (cached) return cached;
  const file = readFileConfig();
  const env = process.env;

  const clientId = env['GOOGLE_OAUTH_CLIENT_ID'];
  const clientSecret = env['GOOGLE_OAUTH_CLIENT_SECRET'];

  cached = {
    person: env['HOURS_PERSON'] ?? file.person ?? '',
    sheetId: env['HOURS_SHEET_ID'] ?? env['GOOGLE_SHEETS_HOURS_ID'],
    serviceAccountJson: env['GOOGLE_SERVICE_ACCOUNT_JSON'],
    googleOAuth:
      clientId && clientSecret
        ? {
            clientId,
            clientSecret,
            tokenPath: env['GOOGLE_OAUTH_TOKEN_PATH'] ?? defaultTokenPath(),
          }
        : undefined,
    openproject: {
      // Empty env values count as unset, same as DATABASE_URL: a copied
      // .env.example leaves these blank until the operator fills them in.
      url: env['OPENPROJECT_URL'] ? env['OPENPROJECT_URL'] : undefined,
      apiKey: env['OPENPROJECT_API_KEY'] ? env['OPENPROJECT_API_KEY'] : undefined,
      projects: file.openproject?.projects,
    },
    wakapi: {
      url: env['WAKAPI_URL'] ? env['WAKAPI_URL'] : undefined,
      apiKey: env['WAKAPI_API_KEY'] ? env['WAKAPI_API_KEY'] : undefined,
    },
    projects: file.projects ?? DEFAULT_PROJECTS,
    workday: { ...DEFAULT_WORKDAY, ...file.workday },
    harnesses: resolveHarnesses(file.harnesses, env),
    databaseUrl: env['DATABASE_URL'] || `file:${resolve(REPO_ROOT, 'hours.db')}`,
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
export type AuthSpec =
  | { kind: 'oauth'; clientId: string; clientSecret: string; tokenPath: string }
  | { kind: 'serviceAccount'; serviceAccountJson: string };

export function requirePushConfig(cfg: HoursConfig = loadConfig()): {
  sheetId: string;
  person: string;
  auth: AuthSpec;
} {
  const missing: string[] = [];
  if (!cfg.sheetId) missing.push('HOURS_SHEET_ID');
  if (!cfg.person) missing.push('HOURS_PERSON');
  // OAuth env vars alone don't authorize anything — a token must actually be on
  // disk. Otherwise a half-configured OAuth client would silently disable a
  // working service-account fallback (and blow up only at push time).
  const oauthUsable = cfg.googleOAuth !== undefined && existsSync(cfg.googleOAuth.tokenPath);
  if (!oauthUsable && !cfg.serviceAccountJson) {
    missing.push('GOOGLE_OAUTH_CLIENT_ID + GOOGLE_OAUTH_CLIENT_SECRET (recommended) or GOOGLE_SERVICE_ACCOUNT_JSON');
  }
  if (missing.length) {
    throw new Error(
      `cannot push: ${missing.join(', ')} not set. Copy .env.example to .env and fill them in.`,
    );
  }
  let auth: AuthSpec;
  if (oauthUsable && cfg.googleOAuth) {
    auth = {
      kind: 'oauth',
      clientId: cfg.googleOAuth.clientId,
      clientSecret: cfg.googleOAuth.clientSecret,
      tokenPath: cfg.googleOAuth.tokenPath,
    };
  } else {
    if (cfg.googleOAuth) {
      // OAuth is configured but un-authorized — surface it so the user knows
      // `pnpm sheets:auth` is still pending instead of silently switching.
      console.error(
        `GOOGLE_OAUTH_CLIENT_ID/SECRET are set but no token at ${cfg.googleOAuth.tokenPath} — ` +
          'falling back to the service account. Run `pnpm sheets:auth` to authorize OAuth.',
      );
    }
    auth = { kind: 'serviceAccount', serviceAccountJson: cfg.serviceAccountJson as string };
  }
  return {
    sheetId: cfg.sheetId as string,
    person: cfg.person,
    auth,
  };
}
