// ---------------------------------------------------------------------------
// OpenProject APIv3 client (read-only).
//
// A deliberately thin fetch wrapper over the REST API: base-URL join, Basic
// auth via the API key, JSON parse, a hard timeout, and one typed error class
// for every failure mode. The functions in tasks.ts / time-entries.ts build
// the concrete requests on top of this.
//
// Failure philosophy (mirrors connectors/google-sheets): callers own graceful
// degradation — a failed sync must leave the cache untouched, so nothing here
// swallows errors or retries silently. Every failure surfaces as an
// OpenProjectError with enough context to log, and never as an untyped throw.
// Requests cannot hang: AbortSignal.timeout bounds every call.
// ---------------------------------------------------------------------------

export const OPENPROJECT_TIMEOUT_MS = 15_000;

/** A connection to one OpenProject instance. */
export interface OpenProjectConnection {
  url: string;
  apiKey: string;
}

/**
 * Any failure talking to OpenProject: transport error, timeout, or non-2xx
 * response. `status` is the HTTP status when a response arrived, else 0.
 */
export class OpenProjectError extends Error {
  readonly status: number;
  /** Raw response body, capped to a diagnostic snippet. Empty for transport failures. */
  readonly body: string;

  constructor(message: string, status: number, body: string) {
    super(message);
    this.name = 'OpenProjectError';
    this.status = status;
    this.body = body;
  }
}

const BODY_SNIPPET_MAX = 500;

/**
 * GET `path` (e.g. "/api/v3/projects/north10-ai/work_packages") on the
 * instance and return the parsed JSON body. Resolves to `null` on an empty
 * body. Throws OpenProjectError for network errors, timeouts, and non-2xx.
 */
export async function getJson(conn: OpenProjectConnection, path: string): Promise<unknown> {
  const base = conn.url.replace(/\/+$/, '');
  const href = `${base}${path.startsWith('/') ? path : `/${path}`}`;

  let res: Response;
  try {
    res = await fetch(href, {
      method: 'GET',
      headers: {
        // OpenProject APIv3 keys authenticate as HTTP Basic, user "apikey".
        Authorization: `Basic ${Buffer.from(`apikey:${conn.apiKey}`).toString('base64')}`,
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(OPENPROJECT_TIMEOUT_MS),
    });
  } catch (err) {
    throw transportError(err);
  }

  const text = await res.text();

  if (!res.ok) {
    throw new OpenProjectError(
      `OpenProject ${res.status} ${res.statusText}: ${errorDetail(text, res.statusText)}`,
      res.status,
      text.slice(0, BODY_SNIPPET_MAX),
    );
  }

  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    // A 2xx with a non-JSON body is a server bug, not a network hiccup.
    throw new OpenProjectError(
      `OpenProject returned a non-JSON body for ${path}`,
      res.status,
      text.slice(0, BODY_SNIPPET_MAX),
    );
  }
}

function transportError(err: unknown): OpenProjectError {
  const name = typeof err === 'object' && err !== null ? (err as { name?: unknown }).name : undefined;
  if (name === 'TimeoutError') {
    return new OpenProjectError(`OpenProject request timed out after ${OPENPROJECT_TIMEOUT_MS}ms`, 0, '');
  }
  // fetch throws TypeError for DNS/connect failures; the message can embed the
  // URL, which may carry credentials, so keep the generic form only.
  const detail = err instanceof Error ? err.message : String(err);
  return new OpenProjectError(`OpenProject network error: ${detail}`, 0, '');
}

/** Pull a human-readable message out of an OpenProject error body. */
function errorDetail(text: string, statusText: string): string {
  try {
    const parsed = JSON.parse(text) as {
      message?: unknown;
      _embedded?: { errors?: Array<{ message?: unknown }> };
    };
    const embedded = parsed._embedded?.errors
      ?.map((e) => e.message)
      .filter((m): m is string => typeof m === 'string')
      .join('; ');
    if (embedded) return embedded;
    if (typeof parsed.message === 'string' && parsed.message) return parsed.message;
  } catch {
    // Non-JSON error body — fall through to the snippet.
  }
  return text ? text.slice(0, BODY_SNIPPET_MAX) : statusText;
}
