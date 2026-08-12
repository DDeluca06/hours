// ---------------------------------------------------------------------------
// Google Sheets client.
//
// Same auth convention as lp-internal-ai-v1's connector: a base64-encoded
// service-account JSON in GOOGLE_SERVICE_ACCOUNT_JSON. The service account's
// email must be shared into the spreadsheet as an Editor — read access is not
// enough for the push path, and the failure mode is a 403 at append time.
// ---------------------------------------------------------------------------

import { google, type sheets_v4 } from 'googleapis';
import { requirePushConfig } from '@hours/config';

let cachedSheets: sheets_v4.Sheets | null = null;

export function getSheets(): sheets_v4.Sheets {
  if (cachedSheets) return cachedSheets;
  const { serviceAccountJson } = requirePushConfig();
  const keyJson = Buffer.from(serviceAccountJson, 'base64').toString('utf-8');
  const auth = new google.auth.GoogleAuth({
    credentials: JSON.parse(keyJson) as object,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  cachedSheets = google.sheets({ version: 'v4', auth: auth as any });
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
