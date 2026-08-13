import { describe, expect, it, vi } from 'vitest';
import { isBusyError, withBusyRetry } from './retry.js';

/** No real waiting, and no jitter, so a retry test is deterministic and fast. */
const instant = { sleep: async (): Promise<void> => {}, random: (): number => 1 };

describe('isBusyError', () => {
  // The messages that actually came back from eight concurrent processes.
  it('recognizes SQLite refusing to wait', () => {
    expect(isBusyError(new Error('Invalid `tx.timer.create()` invocation\n\ndatabase is locked'))).toBe(true);
    expect(isBusyError(new Error('SQLITE_BUSY: database is locked'))).toBe(true);
    expect(isBusyError(new Error('database table is locked'))).toBe(true);
  });

  // A transaction that ran out of budget did so waiting for a lock, and it
  // rolled back — same situation, same remedy.
  it('recognizes a transaction that timed out under contention', () => {
    expect(isBusyError(new Error('Operation has timed out'))).toBe(true);
    expect(isBusyError(new Error('Transaction already closed'))).toBe(true);
  });

  it('does not claim ordinary failures are contention', () => {
    expect(isBusyError(new Error('Unique constraint failed on the fields: (`openKey`)'))).toBe(false);
    expect(isBusyError(new Error('no entry abc123'))).toBe(false);
    expect(isBusyError(undefined)).toBe(false);
  });
});

describe('withBusyRetry', () => {
  it('does not retry an operation that succeeds', async () => {
    const op = vi.fn(async () => 'ok');
    await expect(withBusyRetry(op, instant)).resolves.toBe('ok');
    expect(op).toHaveBeenCalledTimes(1);
  });

  it('retries a busy write until it lands', async () => {
    let calls = 0;
    const op = vi.fn(async () => {
      calls++;
      if (calls < 4) throw new Error('database is locked');
      return calls;
    });
    await expect(withBusyRetry(op, instant)).resolves.toBe(4);
    expect(op).toHaveBeenCalledTimes(4);
  });

  // A wrong write must surface immediately: retrying only delays the error and
  // buries what caused it.
  it('rethrows a non-contention error without retrying', async () => {
    const op = vi.fn(async () => {
      throw new Error('Unique constraint failed on the fields: (`openKey`)');
    });
    await expect(withBusyRetry(op, instant)).rejects.toThrow(/Unique constraint/);
    expect(op).toHaveBeenCalledTimes(1);
  });

  it('gives up after the attempt budget rather than hanging', async () => {
    const op = vi.fn(async () => {
      throw new Error('database is locked');
    });
    await expect(withBusyRetry(op, { ...instant, attempts: 5 })).rejects.toThrow(/database is locked/);
    expect(op).toHaveBeenCalledTimes(5);
  });

  // Uncapped exponential backoff spends the whole budget asleep in one wait.
  it('caps the backoff instead of doubling without limit', async () => {
    const waits: number[] = [];
    const op = vi.fn(async () => {
      throw new Error('database is locked');
    });
    await expect(
      withBusyRetry(op, {
        attempts: 8,
        baseDelayMs: 10,
        maxDelayMs: 100,
        random: () => 1,
        sleep: async (ms) => {
          waits.push(ms);
        },
      }),
    ).rejects.toThrow();
    expect(waits).toEqual([10, 20, 40, 80, 100, 100, 100]);
  });

  it('spreads retries with jitter so collided processes do not collide again', async () => {
    const waits: number[] = [];
    const op = vi.fn(async () => {
      throw new Error('database is locked');
    });
    await expect(
      withBusyRetry(op, {
        attempts: 3,
        baseDelayMs: 100,
        maxDelayMs: 1000,
        random: () => 0.25,
        sleep: async (ms) => {
          waits.push(ms);
        },
      }),
    ).rejects.toThrow();
    // Full jitter: a fraction of the ceiling, not the ceiling itself.
    expect(waits).toEqual([25, 50]);
  });
});
