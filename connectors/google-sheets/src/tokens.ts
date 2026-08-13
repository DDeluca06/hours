// ---------------------------------------------------------------------------
// Local token store for the OAuth path.
//
// One file, mode 0600, holding the refresh token minted by `pnpm sheets:auth`.
// The clientId is stored alongside so a token can be detected as belonging to
// a different OAuth client than the one currently configured — in which case
// re-consent is required.
// ---------------------------------------------------------------------------

import { mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import type { OAuthSpec } from '@hours/config';

export interface StoredTokens {
  clientId: string;
  refreshToken: string;
  accessToken?: string;
  expiryDate?: number;
}

export function loadTokens(tokenPath: string): StoredTokens | null {
  try {
    const parsed = JSON.parse(readFileSync(tokenPath, 'utf-8')) as Partial<StoredTokens>;
    if (typeof parsed.clientId !== 'string' || typeof parsed.refreshToken !== 'string') {
      return null;
    }
    return {
      clientId: parsed.clientId,
      refreshToken: parsed.refreshToken,
      ...(typeof parsed.accessToken === 'string' ? { accessToken: parsed.accessToken } : {}),
      ...(typeof parsed.expiryDate === 'number' ? { expiryDate: parsed.expiryDate } : {}),
    };
  } catch {
    return null;
  }
}

export function saveTokens(tokenPath: string, tokens: StoredTokens): void {
  mkdirSync(dirname(tokenPath), { recursive: true });
  writeFileSync(tokenPath, JSON.stringify(tokens, null, 2) + '\n', { mode: 0o600 });
  chmodSync(tokenPath, 0o600);
}

/** The stored token is only usable by the client that minted it. */
export function tokensMatch(tokens: StoredTokens, spec: OAuthSpec): boolean {
  return tokens.clientId === spec.clientId;
}
