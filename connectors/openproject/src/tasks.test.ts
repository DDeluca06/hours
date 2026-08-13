import { afterEach, describe, expect, it, vi } from 'vitest';
import { OpenProjectError, type OpenProjectConnection } from './client.js';
import { getWorkPackage, listWorkPackages } from './tasks.js';

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

function lastCall(fn: ReturnType<typeof vi.fn>): { url: string; headers: Record<string, string> } {
  const call = fn.mock.calls.at(-1);
  return {
    url: String(call?.[0]),
    headers: (call?.[1]?.headers ?? {}) as Record<string, string>,
  };
}

describe('listWorkPackages', () => {
  it('maps elements to summaries and sends Basic auth to the project-scoped URL', async () => {
    const fetchMock = stubFetch({
      status: 200,
      body: {
        _embedded: {
          elements: [
            {
              id: 136,
              subject: 'Rebuild packages/grants',
              _links: { status: { title: 'Closed' } },
              spentTime: 'PT2H',
              estimatedTime: 'PT4H',
            },
            {
              id: 137,
              subject: 'Docs pass',
              _links: { status: { title: 'In progress' } },
              // Some instances omit time aggregates from list elements; the
              // mapped summary must fall back to null, not fail.
            },
          ],
        },
      },
    });

    const out = await listWorkPackages({
      url: 'https://projects.liftofflearning.tech/', // trailing slash must not double up
      apiKey: 'key',
      projectIdentifier: 'north10-ai',
    });

    expect(out).toEqual([
      { id: '136', subject: 'Rebuild packages/grants', status: 'Closed', spentMinutes: 120, estimatedMinutes: 240 },
      { id: '137', subject: 'Docs pass', status: 'In progress', spentMinutes: null, estimatedMinutes: null },
    ]);

    const { url, headers } = lastCall(fetchMock);
    expect(url).toBe(
      'https://projects.liftofflearning.tech/api/v3/projects/north10-ai/work_packages?pageSize=200&offset=1',
    );
    expect(headers['Authorization']).toBe('Basic ' + Buffer.from('apikey:key').toString('base64'));
  });

  it('honors pageSize and rejects out-of-range values before fetching', async () => {
    const fetchMock = stubFetch({ status: 200, body: { _embedded: { elements: [] } } });
    await listWorkPackages({ ...CONN, projectIdentifier: 'north10-ai', pageSize: 50 });
    expect(lastCall(fetchMock).url).toContain('pageSize=50');

    await expect(
      listWorkPackages({ ...CONN, projectIdentifier: 'north10-ai', pageSize: 201 }),
    ).rejects.toThrow(RangeError);
    expect(fetchMock).toHaveBeenCalledTimes(1); // the invalid call never hit the network
  });

  it('returns [] when the collection has no elements', async () => {
    stubFetch({ status: 200, body: {} });
    await expect(listWorkPackages({ ...CONN, projectIdentifier: 'north10-ai' })).resolves.toEqual([]);
  });

  // A task absent from the cache is refused as if it did not exist, so a
  // project past one page must not lose its tail.
  it('pages until the collection is exhausted', async () => {
    const page = (ids: number[], total: number) => ({
      total,
      _embedded: { elements: ids.map((id) => ({ id, subject: `wp-${id}` })) },
    });
    const bodies = [page([1, 2], 3), page([3], 3)];
    const fetchMock = vi.fn(async (): Promise<Response> => {
      const body = bodies.shift() ?? page([], 3);
      return new Response(JSON.stringify(body), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const out = await listWorkPackages({ ...CONN, projectIdentifier: 'north10-ai', pageSize: 2 });
    expect(out.map((w) => w.id)).toEqual(['1', '2', '3']);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('offset=1');
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain('offset=2');
  });

  // A short page ends the loop no matter what `total` claims — a server that
  // over-reports would otherwise spin to MAX_PAGES.
  it('stops on a short page even when total is larger', async () => {
    const fetchMock = stubFetch({
      status: 200,
      body: { total: 999, _embedded: { elements: [{ id: 1, subject: 'only' }] } },
    });
    const out = await listWorkPackages({ ...CONN, projectIdentifier: 'north10-ai', pageSize: 2 });
    expect(out).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('getWorkPackage', () => {
  it('parses the full resource: time aggregates, project, and type', async () => {
    stubFetch({
      status: 200,
      body: {
        id: 136,
        subject: 'Rebuild packages/grants',
        _links: {
          status: { title: 'Closed' },
          project: { href: '/api/v3/projects/north10-ai' },
          type: { title: 'Task' },
        },
        spentTime: 'PT2H30M',
        estimatedTime: 'PT4H',
        remainingTime: 'PT1H30M',
      },
    });

    const w = await getWorkPackage({ ...CONN, id: 136 });
    expect(w).toEqual({
      id: '136',
      subject: 'Rebuild packages/grants',
      status: 'Closed',
      spentMinutes: 150,
      estimatedMinutes: 240,
      remainingMinutes: 90,
      projectIdentifier: 'north10-ai',
      type: 'Task',
    });
  });

  it('maps missing duration fields and links to null', async () => {
    stubFetch({ status: 200, body: { id: '136', subject: 'bare' } });
    const w = await getWorkPackage({ ...CONN, id: '136' });
    expect(w.spentMinutes).toBeNull();
    expect(w.estimatedMinutes).toBeNull();
    expect(w.remainingMinutes).toBeNull();
    expect(w.projectIdentifier).toBeNull();
    expect(w.status).toBeNull();
    expect(w.type).toBeNull();
  });
});

describe('error paths', () => {
  it('throws OpenProjectError with status and a body snippet on non-2xx', async () => {
    stubFetch({ status: 404, body: { message: 'The requested resource could not be found.' } });
    const err = await getWorkPackage({ ...CONN, id: 999 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OpenProjectError);
    const opErr = err as OpenProjectError;
    expect(opErr.status).toBe(404);
    expect(opErr.message).toContain('404');
    expect(opErr.message).toContain('could not be found');
    expect(opErr.body).toContain('could not be found');
  });

  it('wraps network failures as OpenProjectError with status 0', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (): Promise<Response> => {
        throw new TypeError('fetch failed');
      }),
    );
    const err = await listWorkPackages({ ...CONN, projectIdentifier: 'north10-ai' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OpenProjectError);
    expect((err as OpenProjectError).status).toBe(0);
    expect((err as OpenProjectError).message).toContain('network error');
  });

  it('maps a timeout to OpenProjectError with status 0', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (): Promise<Response> => {
        const e = new Error('The operation was aborted due to timeout');
        e.name = 'TimeoutError';
        throw e;
      }),
    );
    const err = await listWorkPackages({ ...CONN, projectIdentifier: 'north10-ai' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OpenProjectError);
    expect((err as OpenProjectError).status).toBe(0);
    expect((err as OpenProjectError).message).toContain('timed out');
  });
});
