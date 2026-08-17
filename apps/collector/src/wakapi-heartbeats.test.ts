// Wakapi heartbeat collapsing. The fixture shapes are taken from what the
// wakatime-compatible compat endpoint actually returns — including the
// `entity_type` field wakapi uses and the `type` field wakatime.com uses, the
// non-write heartbeats sent on focus/open, and the untitled buffer.

import { describe, expect, it } from 'vitest';
import type { ProjectDef } from '@hours/core';
import {
  WAKAPI_PAST_DAY_TTL_MS,
  WAKAPI_RUN_GAP_MIN,
  WakapiDayCache,
  collectWakapiSignals,
  daysToFetch,
  diagnoseHeartbeats,
  fetchWakapiHeartbeats,
  heartbeatEntity,
  heartbeatMs,
  heartbeatShapeWarning,
  heartbeatsToSignals,
  type WakapiHeartbeat,
} from './wakapi-heartbeats.js';

const REPO = '/home/dev/Projects/NorthAI';

const PROJECTS: ProjectDef[] = [
  { key: 'north10', name: 'North10AI', sheetTab: 'North10AI', repoPaths: [REPO] },
  { key: 'lp', name: 'LP Internal AI', sheetTab: 'LP Internal AI', repoPaths: ['/home/dev/Projects/lp'] },
];

function hb(
  time: string,
  entity: string,
  extra: Partial<WakapiHeartbeat> = {},
  day: Date = new Date(2026, 7, 12),
): WakapiHeartbeat {
  const [h, m, s] = time.split(':').map(Number);
  const at = new Date(day);
  at.setHours(h ?? 0, m ?? 0, s ?? 0);
  return {
    entity,
    entity_type: 'file',
    time: at.getTime() / 1000,
    is_write: true,
    machine_name_id: 'm1',
    ...extra,
  };
}

const DAY = new Date(2026, 7, 12, 0, 0, 0);
const since = (time: string): Date => {
  const [h, m] = time.split(':').map(Number);
  return new Date(2026, 7, 12, h ?? 0, m ?? 0, 0);
};

describe('heartbeatEntity', () => {
  it('accepts absolute paths, with or without a file:// prefix', () => {
    expect(heartbeatEntity({ entity: '/repos/a/b.ts' })).toBe('/repos/a/b.ts');
    expect(heartbeatEntity({ entity: 'file:///repos/a/b.ts' })).toBe('/repos/a/b.ts');
  });

  it('rejects everything that is not a real file', () => {
    expect(heartbeatEntity({ entity: 'untitled:Untitled-1' })).toBeNull();
    expect(heartbeatEntity({ entity: 'https://example.com' })).toBeNull();
    expect(heartbeatEntity({ entity: 'MyApp' })).toBeNull();
    expect(heartbeatEntity({ entity: '' })).toBeNull();
    expect(heartbeatEntity({})).toBeNull();
  });
});

describe('heartbeatMs', () => {
  it('keeps fractional seconds so sourceIds stay unique', () => {
    expect(heartbeatMs({ time: 1775756940.656 })).toBe(1775756940656);
  });

  it('rejects non-numbers and zero', () => {
    expect(heartbeatMs({ time: 'x' })).toBeNull();
    expect(heartbeatMs({ time: 0 })).toBeNull();
    expect(heartbeatMs({})).toBeNull();
  });
});

describe('heartbeatsToSignals', () => {
  it('folds a dense run into one measured signal spanning first to last heartbeat', () => {
    const signals = heartbeatsToSignals(
      [
        hb('09:00:00', `${REPO}/src/a.ts`),
        hb('09:00:05', `${REPO}/src/a.ts`),
        hb('09:03:10', `${REPO}/src/b.ts`),
        hb('09:07:00', `${REPO}/src/b.ts`),
      ],
      { since: DAY, projects: PROJECTS },
    );
    expect(signals).toHaveLength(1);
    expect(signals[0]?.kind).toBe('heartbeat');
    expect(signals[0]?.sourceId).toBe(`wakapi:m1:${REPO}/src/a.ts:${hb('09:00:00', 'x').time! * 1000}`);
    expect(signals[0]?.at.toISOString()).toBe(new Date(hb('09:00:00', 'x').time! * 1000).toISOString());
    expect(signals[0]?.until?.toISOString()).toBe(new Date(hb('09:07:00', 'x').time! * 1000).toISOString());
    expect(signals[0]?.projectKey).toBe('north10');
    expect(signals[0]?.paths).toEqual(['src/a.ts', 'src/b.ts']);
  });

  it('leaves a lone heartbeat a point signal — presence, nothing measured', () => {
    const signals = heartbeatsToSignals([hb('09:00:00', `${REPO}/src/a.ts`)], {
      since: DAY,
      projects: PROJECTS,
    });
    expect(signals).toHaveLength(1);
    expect(signals[0]?.until).toBeUndefined();
  });

  it('breaks a run when the gap exceeds the run window', () => {
    const signals = heartbeatsToSignals(
      [
        hb('09:00:00', `${REPO}/src/a.ts`),
        hb(`09:${WAKAPI_RUN_GAP_MIN + 1}:00`, `${REPO}/src/a.ts`),
      ],
      { since: DAY, projects: PROJECTS },
    );
    expect(signals).toHaveLength(2);
  });

  it('splits a run per project so no signal claims another project’s minutes', () => {
    const signals = heartbeatsToSignals(
      [
        hb('09:00:00', `${REPO}/src/a.ts`),
        hb('09:01:00', `${REPO}/src/a.ts`),
        hb('09:02:00', '/home/dev/Projects/lp/b.ts'),
        hb('09:03:00', '/home/dev/Projects/lp/b.ts'),
        hb('09:04:00', `${REPO}/src/c.ts`),
        hb('09:05:00', `${REPO}/src/c.ts`),
      ],
      { since: DAY, projects: PROJECTS },
    );
    const north = signals.filter((s) => s.projectKey === 'north10');
    const lp = signals.filter((s) => s.projectKey === 'lp');
    expect(north).toHaveLength(2);
    expect(lp).toHaveLength(1);
    // The north segment ends where the lp segment begins — no cross-claim.
    expect(north[0]?.until?.toISOString()).toBe(new Date(hb('09:01:00', 'x').time! * 1000).toISOString());
    expect(lp[0]?.at.toISOString()).toBe(new Date(hb('09:02:00', 'x').time! * 1000).toISOString());
    expect(lp[0]?.until?.toISOString()).toBe(new Date(hb('09:03:00', 'x').time! * 1000).toISOString());
    expect(lp[0]?.paths).toEqual(['b.ts']);
    // The split signal keeps the sourceId of its own first heartbeat.
    expect(lp[0]?.sourceId).toBe(`wakapi:m1:/home/dev/Projects/lp/b.ts:${hb('09:02:00', 'x').time! * 1000}`);
  });

  it('keeps work outside a watched repo unattributed and absolute', () => {
    const signals = heartbeatsToSignals([hb('09:00:00', '/home/dev/Projects/Grants/notes.md')], {
      since: DAY,
      projects: PROJECTS,
    });
    expect(signals[0]?.projectKey).toBeNull();
    expect(signals[0]?.paths).toEqual(['/home/dev/Projects/Grants/notes.md']);
  });

  it('drops non-write and non-file heartbeats — a parked editor must not bill', () => {
    const signals = heartbeatsToSignals(
      [
        hb('09:00:00', `${REPO}/src/a.ts`, { is_write: false }),
        hb('09:01:00', 'example.com', { entity_type: 'domain' }),
        hb('09:02:00', 'MyApp', { type: 'app' }),
        hb('09:03:00', `${REPO}/src/b.ts`),
      ],
      { since: DAY, projects: PROJECTS },
    );
    expect(signals).toHaveLength(1);
    expect(signals[0]?.paths).toEqual(['src/b.ts']);
  });

  it('drops runs that ended before the window', () => {
    const signals = heartbeatsToSignals([hb('08:59:59', `${REPO}/src/a.ts`)], {
      since: since('09:00'),
      projects: PROJECTS,
    });
    expect(signals).toEqual([]);
  });

  // The regression this file's header is about. The daemon sweeps every 10
  // minutes with a 30-minute lookback, so `since` slides forward while a session
  // is still running. Filtering heartbeats by `since` before folding them moved
  // the segment anchor with it, and one 2-hour session became a dozen
  // overlapping "measured" signals that nothing could dedupe.
  it('anchors a run at its true start no matter where the window cuts', () => {
    // Gaps of 8 minutes: under the run gap, so this is one continuous stretch
    // of typing from 09:00 to 09:56 whichever sweep observes it.
    const run = Array.from({ length: 8 }, (_, i) =>
      hb(`09:${String(i * 8).padStart(2, '0')}:00`, `${REPO}/src/a.ts`),
    );
    const ids = ['09:00', '09:30', '09:40', '09:50'].map((cut) => {
      const signals = heartbeatsToSignals(run, { since: since(cut), projects: PROJECTS });
      expect(signals).toHaveLength(1);
      return signals[0]?.sourceId;
    });
    expect(new Set(ids).size).toBe(1);
    expect(ids[0]).toBe(`wakapi:m1:${REPO}/src/a.ts:${hb('09:00:00', 'x').time! * 1000}`);
  });

  it('bounds a single signal’s measured span at maxSpanMin', () => {
    // 10 heartbeats 9 minutes apart: one bridged run of 81 minutes.
    const run = Array.from({ length: 10 }, (_, i) =>
      hb(`09:${String(i * 9).padStart(2, '0')}:00`, `${REPO}/src/a.ts`),
    );
    const signals = heartbeatsToSignals(run, { since: DAY, projects: PROJECTS, maxSpanMin: 30 });
    expect(signals.length).toBeGreaterThan(1);
    for (const s of signals) {
      const span = ((s.until ?? s.at).getTime() - s.at.getTime()) / 60_000;
      expect(span).toBeLessThanOrEqual(30);
    }
  });

  // A shrinking end would be worse than an uncapped span: recordSignalSpans only
  // ever moves an end forward, so the stored signal would keep minutes the new
  // piece also claims.
  it('splits at the cap forward-only, leaving earlier pieces untouched as the run grows', () => {
    const grow = (count: number): WakapiHeartbeat[] =>
      Array.from({ length: count }, (_, i) =>
        hb(`09:${String(i * 5).padStart(2, '0')}:00`, `${REPO}/src/a.ts`),
      );
    const opts = { since: DAY, projects: PROJECTS, maxSpanMin: 20 };
    const early = heartbeatsToSignals(grow(5), opts);
    const later = heartbeatsToSignals(grow(9), opts);

    expect(later.length).toBeGreaterThan(early.length);
    for (const [i, s] of early.entries()) {
      // Every piece the earlier fold emitted survives the later one unchanged,
      // except the last, which is the one still growing.
      if (i === early.length - 1) continue;
      expect(later[i]?.sourceId).toBe(s.sourceId);
      expect(later[i]?.until?.getTime()).toBe(s.until?.getTime());
    }
    expect(later[0]?.sourceId).toBe(early[0]?.sourceId);
  });

  it('keeps the sourceId stable when the run grows, so recordSignalSpans can extend it', () => {
    const early = heartbeatsToSignals(
      [hb('09:00:00', `${REPO}/src/a.ts`), hb('09:05:00', `${REPO}/src/a.ts`)],
      { since: DAY, projects: PROJECTS },
    );
    const later = heartbeatsToSignals(
      [hb('09:00:00', `${REPO}/src/a.ts`), hb('09:05:00', `${REPO}/src/a.ts`), hb('09:09:00', `${REPO}/src/a.ts`)],
      { since: DAY, projects: PROJECTS },
    );
    expect(later[0]?.sourceId).toBe(early[0]?.sourceId);
    expect(later[0]?.until?.getTime()).toBeGreaterThan(early[0]?.until?.getTime() ?? 0);
  });

  it('caps the path list so a sprawling session stays a bounded payload', () => {
    const heartbeats = Array.from({ length: 40 }, (_, i) =>
      hb(`09:0${Math.floor(i / 10)}:0${i % 10}`, `${REPO}/src/f${String(i).padStart(2, '0')}.ts`),
    );
    const signals = heartbeatsToSignals(heartbeats, { since: DAY, projects: PROJECTS });
    expect(signals).toHaveLength(1);
    expect(signals[0]?.paths?.length).toBeLessThanOrEqual(25);
  });
});

describe('heartbeatShapeWarning', () => {
  it('says nothing when heartbeats were used, or when none were fetched', () => {
    expect(
      heartbeatShapeWarning(diagnoseHeartbeats([hb('09:00:00', `${REPO}/src/a.ts`)])),
    ).toBeNull();
    expect(heartbeatShapeWarning(diagnoseHeartbeats([]))).toBeNull();
  });

  // The failure the source exists to catch, turned on itself: a server version
  // that omits is_write drops every heartbeat through a predicate that looks
  // right, and the sweep then reports wakapi=0 exactly like a quiet afternoon.
  it('names the predicate that ate every heartbeat', () => {
    const noWrite = [
      hb('09:00:00', `${REPO}/src/a.ts`, { is_write: undefined }),
      hb('09:01:00', `${REPO}/src/b.ts`, { is_write: undefined }),
    ];
    expect(heartbeatShapeWarning(diagnoseHeartbeats(noWrite))).toMatch(/is_write/);

    const noType = [hb('09:00:00', `${REPO}/src/a.ts`, { entity_type: undefined })];
    expect(heartbeatShapeWarning(diagnoseHeartbeats(noType))).toMatch(/entity_type\/type/);
  });
});

describe('WakapiDayCache', () => {
  it('serves a day inside its TTL and refetches after it', () => {
    const cache = new WakapiDayCache();
    const beats = [hb('09:00:00', `${REPO}/src/a.ts`)];
    cache.write('2026-08-12', beats, 1_000);
    expect(cache.read('2026-08-12', WAKAPI_PAST_DAY_TTL_MS, 1_000)).toBe(beats);
    expect(cache.read('2026-08-12', WAKAPI_PAST_DAY_TTL_MS, 1_000 + WAKAPI_PAST_DAY_TTL_MS + 1)).toBeNull();
  });

  it('forgets days outside the window so a long-running daemon stays bounded', () => {
    const cache = new WakapiDayCache();
    cache.write('2026-08-11', [], 0);
    cache.write('2026-08-12', [], 0);
    cache.prune(['2026-08-12']);
    expect(cache.read('2026-08-11', WAKAPI_PAST_DAY_TTL_MS, 0)).toBeNull();
    expect(cache.read('2026-08-12', WAKAPI_PAST_DAY_TTL_MS, 0)).toEqual([]);
  });
});

describe('daysToFetch', () => {
  it('lists local days inclusively from since to now', () => {
    const days = daysToFetch(new Date(2026, 7, 12, 23, 59), new Date(2026, 7, 14, 1, 0));
    expect(days).toEqual(['2026-08-12', '2026-08-13', '2026-08-14']);
  });

  it('returns nothing when since is after now', () => {
    expect(daysToFetch(new Date(2026, 7, 15), new Date(2026, 7, 14))).toEqual([]);
  });
});

describe('fetchWakapiHeartbeats', () => {
  it('GETs the compat endpoint for the day with the key as Basic auth', async () => {
    const calls: Array<{ href: string; headers: Record<string, string> }> = [];
    const fetchFn = async (href: string, init: RequestInit) => {
      calls.push({ href, headers: init.headers as Record<string, string> });
      return new Response(JSON.stringify({ data: [hb('09:00:00', `${REPO}/src/a.ts`)] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    };
    const result = await fetchWakapiHeartbeats({ url: 'http://127.0.0.1:3001/', apiKey: 'k123' }, '2026-08-12', fetchFn);
    expect(result).toHaveLength(1);
    expect(calls[0]?.href).toBe(
      'http://127.0.0.1:3001/api/compat/wakatime/v1/users/current/heartbeats?date=2026-08-12',
    );
    expect(calls[0]?.headers['Authorization']).toBe(`Basic ${Buffer.from('k123').toString('base64')}`);
  });

  it('throws on non-2xx so the sweep can warn', async () => {
    const fetchFn = async () => new Response('nope', { status: 500 });
    await expect(
      fetchWakapiHeartbeats({ url: 'http://x', apiKey: 'k' }, '2026-08-12', fetchFn),
    ).rejects.toThrow(/500/);
  });

  it('returns nothing for a malformed body instead of crashing the sweep', async () => {
    const fetchFn = async () => new Response('not json', { status: 200 });
    await expect(
      fetchWakapiHeartbeats({ url: 'http://x', apiKey: 'k' }, '2026-08-12', fetchFn),
    ).rejects.toThrow(/non-JSON/);
  });
});

describe('collectWakapiSignals', () => {
  const NOW = new Date(2026, 7, 12, 12, 0, 0);
  const dayKey = (d: Date): string => {
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${d.getFullYear()}-${m}-${dd}`;
  };
  const YESTERDAY = new Date(2026, 7, 11, 12, 0, 0);
  const TWO_DAYS_AGO = new Date(2026, 7, 10, 12, 0, 0);

  function serve(byDay: Record<string, WakapiHeartbeat[]>, requested: string[]) {
    return async (href: string) => {
      const day = href.slice(-10);
      requested.push(day);
      return new Response(JSON.stringify({ data: byDay[day] ?? [] }), { status: 200 });
    };
  }

  it('fetches each day in the window and collapses across them', async () => {
    const requested: string[] = [];
    const fetchFn = serve(
      {
        [dayKey(YESTERDAY)]: [hb('09:00:00', `${REPO}/src/a.ts`, {}, YESTERDAY)],
        [dayKey(NOW)]: [hb('09:05:00', `${REPO}/src/b.ts`, {}, NOW)],
      },
      requested,
    );
    const { signals, warnings } = await collectWakapiSignals({
      url: 'http://127.0.0.1:3001',
      apiKey: 'k',
      since: new Date(2026, 7, 11, 8, 0),
      projects: PROJECTS,
      fetchFn,
      now: NOW,
    });
    // The window's two days, plus one day of preroll: a run that crosses
    // midnight has to be anchored at the heartbeat it started on, and the
    // endpoint's granularity is a whole day.
    expect(requested).toEqual([dayKey(TWO_DAYS_AGO), dayKey(YESTERDAY), dayKey(NOW)]);
    expect(signals).toHaveLength(2);
    expect(signals.every((s) => s.kind === 'heartbeat')).toBe(true);
    expect(warnings).toEqual([]);
  });

  it('returns nothing when the window contains no days', async () => {
    const fetchFn = async () => new Response(JSON.stringify({ data: [] }), { status: 200 });
    const { signals, warnings } = await collectWakapiSignals({
      url: 'http://x',
      apiKey: 'k',
      since: new Date(2026, 8, 1),
      projects: PROJECTS,
      fetchFn,
      now: NOW,
    });
    expect(signals).toEqual([]);
    expect(warnings).toEqual([]);
  });

  it('warns rather than reporting a quiet afternoon when nothing was usable', async () => {
    const requested: string[] = [];
    const fetchFn = serve(
      { [dayKey(NOW)]: [hb('09:00:00', `${REPO}/src/a.ts`, { is_write: undefined }, NOW)] },
      requested,
    );
    const { signals, warnings } = await collectWakapiSignals({
      url: 'http://x',
      apiKey: 'k',
      since: new Date(2026, 7, 12, 8, 0),
      projects: PROJECTS,
      fetchFn,
      now: NOW,
    });
    expect(signals).toEqual([]);
    expect(warnings.join('\n')).toMatch(/could use none of them/);
  });

  // The daemon sweeps every 10 minutes and the endpoint has no incremental
  // parameter, so without this every sweep re-downloads whole finished days.
  it('re-fetches today every sweep but serves finished days from the cache', async () => {
    const cache = new WakapiDayCache();
    const requested: string[] = [];
    const fetchFn = serve(
      {
        [dayKey(YESTERDAY)]: [hb('09:00:00', `${REPO}/src/a.ts`, {}, YESTERDAY)],
        [dayKey(NOW)]: [hb('09:05:00', `${REPO}/src/b.ts`, {}, NOW)],
      },
      requested,
    );
    const opts = {
      url: 'http://x',
      apiKey: 'k',
      since: new Date(2026, 7, 11, 8, 0),
      projects: PROJECTS,
      fetchFn,
      cache,
      now: NOW,
    };
    await collectWakapiSignals(opts);
    requested.length = 0;
    const second = await collectWakapiSignals(opts);

    expect(requested).toEqual([dayKey(NOW)]);
    // Cached days still contribute their signals — this is a fetch cache, not a
    // collection watermark.
    expect(second.signals).toHaveLength(2);
  });
});
