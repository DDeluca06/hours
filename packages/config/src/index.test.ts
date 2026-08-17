import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig, requirePushConfig, resetConfigCache } from './index.js';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

const SAVED_ENV = { ...process.env };

afterEach(() => {
  process.env = { ...SAVED_ENV };
  resetConfigCache();
});

function withTempDir(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'hours-config-'));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('googleOAuth config', () => {
  it('is undefined without client credentials', () => {
    delete process.env['GOOGLE_OAUTH_CLIENT_ID'];
    delete process.env['GOOGLE_OAUTH_CLIENT_SECRET'];
    expect(loadConfig().googleOAuth).toBeUndefined();
  });

  it('is built from GOOGLE_OAUTH_CLIENT_ID/SECRET with the default token path', () => {
    process.env['GOOGLE_OAUTH_CLIENT_ID'] = 'a.apps.googleusercontent.com';
    process.env['GOOGLE_OAUTH_CLIENT_SECRET'] = 'GOCSPX-secret';
    expect(loadConfig().googleOAuth).toEqual({
      clientId: 'a.apps.googleusercontent.com',
      clientSecret: 'GOCSPX-secret',
      tokenPath: join(homedir(), '.config', 'hours', 'credentials.json'),
    });
  });

  it('honors GOOGLE_OAUTH_TOKEN_PATH', () => {
    process.env['GOOGLE_OAUTH_CLIENT_ID'] = 'id';
    process.env['GOOGLE_OAUTH_CLIENT_SECRET'] = 'secret';
    process.env['GOOGLE_OAUTH_TOKEN_PATH'] = '/tmp/tokens.json';
    expect(loadConfig().googleOAuth?.tokenPath).toBe('/tmp/tokens.json');
  });
});

describe('databaseUrl', () => {
  it('falls back to the repo SQLite file when DATABASE_URL is unset', () => {
    delete process.env['DATABASE_URL'];
    expect(loadConfig().databaseUrl).toBe(`file:${process.cwd()}/hours.db`);
  });

  it('treats an empty DATABASE_URL as unset (copied .env.example)', () => {
    process.env['DATABASE_URL'] = '';
    expect(loadConfig().databaseUrl).toBe(`file:${process.cwd()}/hours.db`);
  });

  it('honors a real DATABASE_URL', () => {
    process.env['DATABASE_URL'] = 'postgres://localhost/lp';
    expect(loadConfig().databaseUrl).toBe('postgres://localhost/lp');
  });
});

// Point loadConfig at a fixture in a temp dir via HOURS_CONFIG_FILE. Writing
// the repo root's real hours.config.json instead would leave the operator's
// project registry replaced by a fixture if the run were interrupted, and
// would race any other worker calling loadConfig().
function withRepoConfigFile(content: string, fn: () => void): void {
  withTempDir((dir) => {
    const path = join(dir, 'hours.config.json');
    writeFileSync(path, content, 'utf-8');
    process.env['HOURS_CONFIG_FILE'] = path;
    resetConfigCache();
    try {
      fn();
    } finally {
      delete process.env['HOURS_CONFIG_FILE'];
      resetConfigCache();
    }
  });
}

// "No config file" has to be pointed at a path that does not exist, not just
// left alone: the loader falls back to the repo root, where the operator's own
// hours.config.json lives, and these assertions then read their machine's
// project registry instead of nothing.
function withNoRepoConfigFile(fn: () => void): void {
  withTempDir((dir) => {
    process.env['HOURS_CONFIG_FILE'] = join(dir, 'absent.config.json');
    resetConfigCache();
    try {
      fn();
    } finally {
      delete process.env['HOURS_CONFIG_FILE'];
      resetConfigCache();
    }
  });
}

describe('openproject config', () => {
  it('is all-undefined with no env and no file section', () => {
    delete process.env['OPENPROJECT_URL'];
    delete process.env['OPENPROJECT_API_KEY'];
    withNoRepoConfigFile(() => {
      expect(loadConfig().openproject).toEqual({ url: undefined, apiKey: undefined, projects: undefined });
    });
  });

  it('treats empty OPENPROJECT_URL/API_KEY as unset (copied .env.example)', () => {
    process.env['OPENPROJECT_URL'] = '';
    process.env['OPENPROJECT_API_KEY'] = '';
    expect(loadConfig().openproject.url).toBeUndefined();
    expect(loadConfig().openproject.apiKey).toBeUndefined();
  });

  it('reads url and apiKey from the environment', () => {
    process.env['OPENPROJECT_URL'] = 'https://projects.liftofflearning.tech';
    process.env['OPENPROJECT_API_KEY'] = 'super-secret-key';
    const op = loadConfig().openproject;
    expect(op.url).toBe('https://projects.liftofflearning.tech');
    expect(op.apiKey).toBe('super-secret-key');
  });

  it('loads the project-key → identifier mapping from hours.config.json', () => {
    withRepoConfigFile(
      JSON.stringify({ openproject: { projects: { north10: 'north10-ai' } } }),
      () => {
        expect(loadConfig().openproject.projects).toEqual({ north10: 'north10-ai' });
      },
    );
  });

  // Secrets never live in the JSON file; even if one sneaks in, it is ignored
  // rather than read — the same rule as the Google credentials.
  it('never reads url/apiKey from hours.config.json, even when present', () => {
    withRepoConfigFile(
      JSON.stringify({
        openproject: {
          url: 'https://evil.example',
          apiKey: 'file-leaked-secret',
          projects: { north10: 'north10-ai' },
        },
      }),
      () => {
        const op = loadConfig().openproject;
        expect(op.url).toBeUndefined();
        expect(op.apiKey).toBeUndefined();
        expect(op.projects).toEqual({ north10: 'north10-ai' });
      },
    );
  });

  it('is a no-throw load when hours.config.json is absent', () => {
    delete process.env['OPENPROJECT_URL'];
    delete process.env['OPENPROJECT_API_KEY'];
    withNoRepoConfigFile(() => {
      expect(() => loadConfig()).not.toThrow();
      expect(loadConfig().openproject).toEqual({ url: undefined, apiKey: undefined, projects: undefined });
    });
  });
});

describe('requirePushConfig auth selection', () => {
  it('prefers oauth over the service account when both are present and a token is stored', () => {
    withTempDir((dir) => {
      const tokenPath = join(dir, 'creds.json');
      writeFileSync(tokenPath, JSON.stringify({ clientId: 'id', refreshToken: 'rt' }));
      process.env['GOOGLE_OAUTH_CLIENT_ID'] = 'id';
      process.env['GOOGLE_OAUTH_CLIENT_SECRET'] = 'secret';
      process.env['GOOGLE_OAUTH_TOKEN_PATH'] = tokenPath;
      process.env['GOOGLE_SERVICE_ACCOUNT_JSON'] = 'bm90LWEta2V5';
      process.env['HOURS_SHEET_ID'] = 'sheet';
      process.env['HOURS_PERSON'] = 'Demitri';
      expect(requirePushConfig().auth.kind).toBe('oauth');
    });
  });

  it('falls back to the service account when OAuth is configured but no token is stored', () => {
    const originalError = console.error;
    console.error = () => {};
    try {
      withTempDir((dir) => {
        process.env['GOOGLE_OAUTH_CLIENT_ID'] = 'id';
        process.env['GOOGLE_OAUTH_CLIENT_SECRET'] = 'secret';
        process.env['GOOGLE_OAUTH_TOKEN_PATH'] = join(dir, 'missing.json');
        process.env['GOOGLE_SERVICE_ACCOUNT_JSON'] = 'bm90LWEta2V5';
        process.env['HOURS_SHEET_ID'] = 'sheet';
        process.env['HOURS_PERSON'] = 'Demitri';
        const { auth } = requirePushConfig();
        expect(auth).toEqual({ kind: 'serviceAccount', serviceAccountJson: 'bm90LWEta2V5' });
      });
    } finally {
      console.error = originalError;
    }
  });

  it('errors when OAuth is configured but no token is stored and no service account is set', () => {
    withTempDir((dir) => {
      process.env['GOOGLE_OAUTH_CLIENT_ID'] = 'id';
      process.env['GOOGLE_OAUTH_CLIENT_SECRET'] = 'secret';
      process.env['GOOGLE_OAUTH_TOKEN_PATH'] = join(dir, 'missing.json');
      process.env['HOURS_SHEET_ID'] = 'sheet';
      process.env['HOURS_PERSON'] = 'Demitri';
      expect(() => requirePushConfig()).toThrow(/GOOGLE_OAUTH_CLIENT_ID.*or GOOGLE_SERVICE_ACCOUNT_JSON/);
    });
  });

  it('falls back to the service account when no OAuth client is configured', () => {
    process.env['GOOGLE_SERVICE_ACCOUNT_JSON'] = 'bm90LWEta2V5';
    process.env['HOURS_SHEET_ID'] = 'sheet';
    process.env['HOURS_PERSON'] = 'Demitri';
    const { auth } = requirePushConfig();
    expect(auth).toEqual({ kind: 'serviceAccount', serviceAccountJson: 'bm90LWEta2V5' });
  });

  it('lists both auth options in the error when neither is set', () => {
    process.env['HOURS_SHEET_ID'] = 'sheet';
    process.env['HOURS_PERSON'] = 'Demitri';
    expect(() => requirePushConfig()).toThrow(/GOOGLE_OAUTH_CLIENT_ID.*or GOOGLE_SERVICE_ACCOUNT_JSON/);
  });
});

describe('harness config', () => {
  it('reads every source by default — a silently empty source looks like a light day', () => {
    expect(loadConfig().harnesses).toEqual({
      claudeCode: true,
      openCode: true,
      editors: true,
      wakapi: true,
      maxSpanMin: 120,
      remapOpenCodeHome: true,
      editorHistoryRoots: undefined,
    });
  });

  it('turns a source off from the environment', () => {
    process.env['HOURS_HARNESS_OPENCODE'] = '0';
    process.env['HOURS_HARNESS_EDITORS'] = 'false';
    const { harnesses } = loadConfig();
    expect(harnesses.openCode).toBe(false);
    expect(harnesses.editors).toBe(false);
    expect(harnesses.claudeCode).toBe(true);
  });

  it('treats an empty env value as unset rather than as off', () => {
    // A copied .env.example leaves these blank; blank must not disable collection.
    process.env['HOURS_HARNESS_CLAUDE'] = '';
    expect(loadConfig().harnesses.claudeCode).toBe(true);
  });

  it('honors HOURS_MAX_SPAN_MIN and ignores a garbled one', () => {
    process.env['HOURS_MAX_SPAN_MIN'] = '45';
    expect(loadConfig().harnesses.maxSpanMin).toBe(45);
    resetConfigCache();
    process.env['HOURS_MAX_SPAN_MIN'] = 'banana';
    expect(loadConfig().harnesses.maxSpanMin).toBe(120);
    resetConfigCache();
    process.env['HOURS_MAX_SPAN_MIN'] = '-5';
    expect(loadConfig().harnesses.maxSpanMin).toBe(120);
  });

  it('takes file settings, with the environment winning', () => {
    withTempDir((dir) => {
      const path = join(dir, 'hours.config.json');
      writeFileSync(
        path,
        JSON.stringify({
          harnesses: {
            openCode: false,
            editors: false,
            maxSpanMin: 30,
            editorHistoryRoots: ['/opt/vscode/User/History'],
          },
        }),
      );
      process.env['HOURS_CONFIG_FILE'] = path;
      process.env['HOURS_HARNESS_EDITORS'] = '1';
      const { harnesses } = loadConfig();
      expect(harnesses.openCode).toBe(false);
      expect(harnesses.editors).toBe(true);
      expect(harnesses.maxSpanMin).toBe(30);
      expect(harnesses.editorHistoryRoots).toEqual(['/opt/vscode/User/History']);
    });
  });
});
