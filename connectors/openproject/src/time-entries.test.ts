import { afterEach, describe, expect, it, vi } from 'vitest';
import { OpenProjectError, type OpenProjectConnection } from './client.js';
import {
  createTimeEntry,
  listTimeEntries,
  minutesToIsoDuration,
  workPackageTimeFilters,
} from './time-entries.js';

const CONN: OpenProjectConnection = { url: 'https://op.example', apiKey: 'secret' };

/** Replace global fetch with a stub answering `body` at `status`. */
function stubFetch(response: { status: number; body: unknown }): ReturnType<typeof vi.fn> {
  const fn = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit): Promise<Response> => {
    const body = typeof response.body === 'string' ? response.body : JSON.stringify(response.body);
    return new Response(body, { status: response.status });
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

function lastUrl(fn: ReturnType<typeof vi.fn>): string {
  return String(fn.mock.calls.at(-1)?.[0]);
}

describe('workPackageTimeFilters', () => {
  // The filter key is `entity`, not `work_package_id` — TimeEntry was
  // generalised to attach to meetings too, and the old name no longer exists
  // (the working server.mjs against the real instance says so).
  it('scopes time entries to one work package via the entity filter', () => {
    expect(workPackageTimeFilters('136')).toEqual([
      { entity: { operator: '=', values: ['136'] } },
    ]);
    expect(workPackageTimeFilters(136)).toEqual([{ entity: { operator: '=', values: ['136'] } }]);
  });
});

describe('listTimeEntries', () => {
  it('maps entries, parses hours, and sums totalMinutes', async () => {
    stubFetch({
      status: 200,
      body: {
        _embedded: {
          elements: [
            { id: 501, spentOn: '2026-08-12', hours: 'PT1H', comment: { raw: 'grants rebuild' } },
            { id: 502, spentOn: null, hours: 'PT45M', comment: null },
            { id: 503, spentOn: '2026-08-11', hours: 'PT0H15M' },
          ],
        },
      },
    });

    const out = await listTimeEntries({ ...CONN, workPackage: 136 });
    expect(out.entries).toEqual([
      { id: '501', hoursMinutes: 60, spentOn: '2026-08-12', comment: 'grants rebuild' },
      { id: '502', hoursMinutes: 45, spentOn: null, comment: null },
      { id: '503', hoursMinutes: 15, spentOn: '2026-08-11', comment: null },
    ]);
    expect(out.totalMinutes).toBe(120);
    expect(out.parseWarnings).toBeUndefined();
  });

  it('encodes the entity filter into the time_entries query', async () => {
    const fetchMock = stubFetch({ status: 200, body: { _embedded: { elements: [] } } });
    await listTimeEntries({ ...CONN, workPackage: '136' });

    const parsed = new URL(lastUrl(fetchMock));
    expect(parsed.pathname).toBe('/api/v3/time_entries');
    expect(parsed.searchParams.get('pageSize')).toBe('200');
    expect(parsed.searchParams.get('filters')).toBe(JSON.stringify(workPackageTimeFilters(136)));
  });

  it('surfaces unparseable entry hours as a parseWarnings count, counting them as 0', async () => {
    stubFetch({
      status: 200,
      body: {
        _embedded: {
          elements: [
            { id: 601, spentOn: '2026-08-12', hours: 'PT30M' },
            { id: 602, spentOn: null, hours: 'not-a-duration' },
          ],
        },
      },
    });

    const out = await listTimeEntries({ ...CONN, workPackage: 1 });
    expect(out.entries[0]?.hoursMinutes).toBe(30);
    expect(out.entries[1]?.hoursMinutes).toBe(0);
    expect(out.totalMinutes).toBe(30);
    expect(out.parseWarnings).toBe(1);
  });

  it('throws OpenProjectError on a non-2xx response', async () => {
    stubFetch({ status: 403, body: { message: 'You are not authorized to access this resource.' } });
    const err = await listTimeEntries({ ...CONN, workPackage: 136 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OpenProjectError);
    const opErr = err as OpenProjectError;
    expect(opErr.status).toBe(403);
    expect(opErr.message).toContain('403');
    expect(opErr.message).toContain('not authorized');
  });
});

describe('minutesToIsoDuration', () => {
  it('formats whole minutes as ISO-8601 durations', () => {
    expect(minutesToIsoDuration(90)).toBe('PT1H30M');
    expect(minutesToIsoDuration(45)).toBe('PT45M');
    expect(minutesToIsoDuration(0)).toBe('PT0S');
    expect(minutesToIsoDuration(60)).toBe('PT1H');
    expect(minutesToIsoDuration(135)).toBe('PT2H15M');
  });

  // A fractional minute is a caller bug, not data to massage — the sheet
  // stores whole minutes, so rounding here would silently drift the ledgers.
  it('refuses fractional and negative minutes', () => {
    expect(() => minutesToIsoDuration(1.5)).toThrow(RangeError);
    expect(() => minutesToIsoDuration(-5)).toThrow(RangeError);
  });
});

describe('createTimeEntry', () => {
  it('POSTs the duration, day, comment, and work package link to the notify-free URL', async () => {
    const fetchMock = stubFetch({ status: 201, body: { id: 777 } });

    const out = await createTimeEntry({
      ...CONN,
      workPackage: 136,
      minutes: 90,
      spentOn: '2026-08-12',
      comment: 'grants rebuild',
    });
    expect(out).toEqual({ id: '777' });

    const [url, init] = fetchMock.mock.calls.at(-1) as [string, RequestInit];
    expect(url).toBe('https://op.example/api/v3/time_entries?notify=false');
    expect(init.method).toBe('POST');
    const headers = init.headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Basic ' + Buffer.from('apikey:secret').toString('base64'));
    expect(headers['Content-Type']).toBe('application/json');
    expect(JSON.parse(String(init.body))).toEqual({
      hours: 'PT1H30M',
      spentOn: '2026-08-12',
      comment: { format: 'markdown', raw: 'grants rebuild' },
      _links: { workPackage: { href: '/api/v3/work_packages/136' } },
    });
  });

  it('omits the comment entirely when none is given', async () => {
    const fetchMock = stubFetch({ status: 201, body: { id: 778 } });

    await createTimeEntry({ ...CONN, workPackage: '136', minutes: 45, spentOn: '2026-08-12' });

    const init = fetchMock.mock.calls.at(-1)?.[1];
    expect(JSON.parse(String(init?.body))).toEqual({
      hours: 'PT45M',
      spentOn: '2026-08-12',
      _links: { workPackage: { href: '/api/v3/work_packages/136' } },
    });
  });

  it('throws OpenProjectError on a non-2xx response', async () => {
    stubFetch({ status: 422, body: { message: 'Work package 999 does not exist.' } });

    const err = await createTimeEntry({
      ...CONN,
      workPackage: 999,
      minutes: 45,
      spentOn: '2026-08-12',
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OpenProjectError);
    const opErr = err as OpenProjectError;
    expect(opErr.status).toBe(422);
    expect(opErr.message).toContain('422');
    expect(opErr.message).toContain('does not exist');
  });
});
