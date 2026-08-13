// ---------------------------------------------------------------------------
// `pnpm sheets:auth` — one-time OAuth consent for the user-consent path.
//
// Runs the installed-app loopback flow: opens a browser, waits for the consent
// callback on 127.0.0.1, exchanges the code for a refresh token, and stores it
// at GOOGLE_OAUTH_TOKEN_PATH (default ~/.config/hours/credentials.json).
//
// Needs GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET from .env — a
// Desktop-app OAuth client in any Google Cloud project with the Sheets API
// enabled. The consenting account must already be an Editor of the sheet.
// ---------------------------------------------------------------------------

import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { loadConfig } from '@hours/config';
import { google } from 'googleapis';
import { loadTokens, saveTokens, tokensMatch } from './tokens.js';

const SCOPE = 'https://www.googleapis.com/auth/spreadsheets';
const TIMEOUT_MS = 10 * 60 * 1000;

const force = process.argv.includes('--force');

function openBrowser(url: string): void {
  const cmd =
    process.platform === 'darwin'
      ? ['open', url]
      : process.platform === 'win32'
        ? ['cmd', '/c', 'start', url]
        : ['xdg-open', url];
  try {
    spawn(cmd[0] as string, cmd.slice(1) as string[], { stdio: 'ignore' }).unref();
  } catch {
    // Browser unavailable is fine — the URL is printed either way.
  }
}

async function main(): Promise<void> {
  const cfg = loadConfig();
  if (!cfg.googleOAuth) {
    console.error(
      'GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET are not set.\n' +
        'Create a Desktop-app OAuth client in any Google Cloud project with the Sheets API\n' +
        'enabled, then put both values in .env.',
    );
    process.exit(1);
  }
  const spec = cfg.googleOAuth;

  const existing = loadTokens(spec.tokenPath);
  if (existing && tokensMatch(existing, spec) && !force) {
    console.log(`already authorized at ${spec.tokenPath} — pass --force to re-authorize`);
    return;
  }

  const server: Server = await new Promise((resolve) => {
    const s = createServer((req, res) => {
      void handleCallback(req.url ?? '', res);
    });
    s.listen(0, '127.0.0.1', () => resolve(s));
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('could not bind the localhost callback server');
  }
  const redirectUri = `http://127.0.0.1:${address.port}/`;
  const oauth2 = new google.auth.OAuth2(spec.clientId, spec.clientSecret, redirectUri);

  // Random state that must round-trip through the consent redirect; without it
  // a forged callback could exchange an attacker's code against our client.
  const state = randomBytes(16).toString('hex');
  const authUrl = oauth2.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: [SCOPE],
    redirect_uri: redirectUri,
    state,
  });

  console.log(`\nOpen this URL in a browser signed in as an Editor of the Hours sheet:\n\n  ${authUrl}\n`);
  openBrowser(authUrl);

  const timeout = setTimeout(() => {
    console.error(`timed out after ${TIMEOUT_MS / 60000} minutes — no consent received`);
    server.close();
    process.exit(1);
  }, TIMEOUT_MS);

  async function handleCallback(url: string, res: import('node:http').ServerResponse): Promise<void> {
    try {
      const parsed = new URL(url, 'http://127.0.0.1');
      if (parsed.pathname !== '/') {
        // Browsers hit /favicon.ico etc. — answer them so the connection
        // doesn't hang open until the consent timeout.
        res.writeHead(404);
        res.end();
        return;
      }
      clearTimeout(timeout);

      const error = parsed.searchParams.get('error');
      if (error) {
        res.writeHead(400, { 'Content-Type': 'text/plain' });
        res.end(`Authorization failed: ${error}`);
        console.error(`authorization failed: ${error}`);
        server.close();
        process.exit(1);
      }

      // The state must match what we sent, or the callback may be a CSRF'd
      // redirect — never exchange a code from a mismatched callback.
      if (parsed.searchParams.get('state') !== state) {
        res.writeHead(400, { 'Content-Type': 'text/plain' });
        res.end('Authorization failed: state mismatch');
        console.error('authorization failed: state mismatch — possible CSRF');
        server.close();
        process.exit(1);
      }

      // Neither a code nor an error: the redirect lost its parameters. The
      // consent timeout is already cleared by this point, so returning quietly
      // would leave the browser tab spinning and the process waiting forever.
      const code = parsed.searchParams.get('code');
      if (!code) {
        res.writeHead(400, { 'Content-Type': 'text/plain' });
        res.end('Authorization failed: the callback carried no code');
        console.error('authorization failed: the callback carried no code — re-run `pnpm sheets:auth`');
        server.close();
        process.exit(1);
      }

      const { tokens } = await oauth2.getToken(code);
      if (!tokens.refresh_token) {
        throw new Error('no refresh token in the exchange response — was prompt=consent honored?');
      }
      saveTokens(spec.tokenPath, {
        clientId: spec.clientId,
        refreshToken: tokens.refresh_token,
        ...(tokens.access_token ? { accessToken: tokens.access_token } : {}),
        ...(tokens.expiry_date ? { expiryDate: tokens.expiry_date } : {}),
      });
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<h2>Authorized — you can close this tab.</h2>');
      console.log(`\nsaved refresh token to ${spec.tokenPath} (mode 0600).`);
      console.log('next: pnpm sheets:probe, then pnpm hours push --dry-run');
      server.close();
      process.exit(0);
    } catch (err) {
      console.error('authorization failed:', err);
      server.close();
      process.exit(1);
    }
  }
}

void main();
