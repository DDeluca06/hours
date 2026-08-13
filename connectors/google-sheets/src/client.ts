// ---------------------------------------------------------------------------
// Google Sheets client.
//
// Two auth paths, one of which must be configured to push:
//
//   oauth (recommended)     — GOOGLE_OAUTH_CLIENT_ID/SECRET + a refresh token
//                             saved by `pnpm sheets:auth`. The consenting user
//                             is the principal, so no sheet sharing changes
//                             are needed beyond their existing edit access.
//   service account         — base64-encoded service-account JSON in
//                             GOOGLE_SERVICE_ACCOUNT_JSON, same convention as
//                             lp-internal-ai-v1. Its email must be shared into
//                             the spreadsheet as an Editor — read access is not
//                             enough for the push path, and the failure mode is
//                             a 403 at append time.
// ---------------------------------------------------------------------------

import { google, type Auth, type sheets_v4 } from 'googleapis';
import { requirePushConfig, type AuthSpec } from '@hours/config';
import { loadTokens, saveTokens, tokensMatch, type StoredTokens } from './tokens.js';

let cachedSheets: sheets_v4.Sheets | null = null;

function makeOAuthClient(spec: AuthSpec & { kind: 'oauth' }): Auth.OAuth2Client {
  const stored = loadTokens(spec.tokenPath);
  if (!stored) {
    throw new Error(
      `no OAuth token at ${spec.tokenPath} — run \`pnpm sheets:auth\` to authorize once.`,
    );
  }
  if (!tokensMatch(stored, spec)) {
    throw new Error(
      `the token at ${spec.tokenPath} belongs to a different OAuth client — run \`pnpm sheets:auth\` again.`,
    );
  }
  const auth = new google.auth.OAuth2(spec.clientId, spec.clientSecret);
  auth.setCredentials({
    refresh_token: stored.refreshToken,
    access_token: stored.accessToken ?? null,
    expiry_date: stored.expiryDate ?? null,
  });
  auth.on('tokens', (tokens) => {
    const next: StoredTokens = {
      clientId: stored.clientId,
      refreshToken: tokens.refresh_token ?? stored.refreshToken,
      ...(tokens.access_token ? { accessToken: tokens.access_token } : {}),
      ...(tokens.expiry_date ? { expiryDate: tokens.expiry_date } : {}),
    };
    try {
      saveTokens(spec.tokenPath, next);
    } catch {
      // A failed persist (disk full, permissions) must not kill this run — the
      // in-memory access token still works, and the refresh is retried next run.
      console.error(
        `could not persist refreshed token at ${spec.tokenPath} — it will be refreshed again on the next run`,
      );
    }
  });
  return auth;
}

function makeAuthClient(auth: AuthSpec): Auth.OAuth2Client | Auth.GoogleAuth {
  if (auth.kind === 'oauth') return makeOAuthClient(auth);
  const keyJson = Buffer.from(auth.serviceAccountJson, 'base64').toString('utf-8');
  return new google.auth.GoogleAuth({
    credentials: JSON.parse(keyJson) as object,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
}

export function getSheets(): sheets_v4.Sheets {
  if (cachedSheets) return cachedSheets;
  const { auth } = requirePushConfig();
  cachedSheets = google.sheets({ version: 'v4', auth: makeAuthClient(auth) });
  return cachedSheets;
}

export async function getRows(spreadsheetId: string, range: string): Promise<string[][]> {
  const res = await getSheets().spreadsheets.values.get({
    spreadsheetId,
    range,
    // Read what a human sees, so a duration cell arrives as "1:45:00" rather
    // than the underlying serial fraction.
    valueRenderOption: 'FORMATTED_VALUE',
  });
  return (res.data.values ?? []) as string[][];
}

export async function listTabTitles(spreadsheetId: string): Promise<string[]> {
  const res = await getSheets().spreadsheets.get({
    spreadsheetId,
    fields: 'sheets.properties.title',
  });
  return (res.data.sheets ?? [])
    .map((s) => s.properties?.title)
    .filter((t): t is string => !!t);
}

/**
 * Resolve a configured tab name to the sheet's actual title.
 *
 * Tab titles drift — a trailing space or a case change would otherwise turn a
 * push into a confusing 400. Exact match first, then a normalized match, then
 * fail loudly with the available titles rather than writing to a guess.
 */
export function resolveTabTitle(want: string, titles: readonly string[]): string {
  const exact = titles.find((t) => t === want);
  if (exact) return exact;
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  const fuzzy = titles.filter((t) => norm(t) === norm(want));
  if (fuzzy.length === 1) return fuzzy[0] as string;
  throw new Error(
    `tab "${want}" not found in the spreadsheet. Available tabs: ${titles.join(', ')}`,
  );
}
