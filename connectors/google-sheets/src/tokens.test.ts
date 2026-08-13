import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadTokens, saveTokens, tokensMatch } from './tokens.js';

function withTempDir(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'hours-tokens-'));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const SPEC = {
  clientId: 'a.apps.googleusercontent.com',
  clientSecret: 'GOCSPX-secret',
  tokenPath: '',
};

describe('token store', () => {
  it('round-trips a full token set', () => {
    withTempDir((dir) => {
      const path = join(dir, 'creds.json');
      saveTokens(path, {
        clientId: 'a.apps.googleusercontent.com',
        refreshToken: '1//refresh',
        accessToken: 'ya29.access',
        expiryDate: 1768499900864,
      });
      expect(loadTokens(path)).toEqual({
        clientId: 'a.apps.googleusercontent.com',
        refreshToken: '1//refresh',
        accessToken: 'ya29.access',
        expiryDate: 1768499900864,
      });
    });
  });

  it('writes the file mode 0600', () => {
    withTempDir((dir) => {
      const path = join(dir, 'creds.json');
      saveTokens(path, { clientId: 'id', refreshToken: 'rt' });
      if (process.platform !== 'win32') {
        expect(statSync(path).mode & 0o777).toBe(0o600);
      }
    });
  });

  it('returns null for a missing or malformed file', () => {
    withTempDir((dir) => {
      const path = join(dir, 'creds.json');
      expect(loadTokens(path)).toBeNull();
      const bad = join(dir, 'bad.json');
      saveTokens(bad, { clientId: 'id', refreshToken: 'rt' });
      expect(loadTokens(bad)).not.toBeNull();
      writeFileSync(bad, '{not json');
      expect(loadTokens(bad)).toBeNull();
    });
  });

  it('matches only the client that minted the token', () => {
    expect(
      tokensMatch({ clientId: 'a.apps.googleusercontent.com', refreshToken: 'rt' }, SPEC),
    ).toBe(true);
    expect(
      tokensMatch({ clientId: 'other.apps.googleusercontent.com', refreshToken: 'rt' }, SPEC),
    ).toBe(false);
  });
});
