import { describe, it, expect } from 'vitest';
import {
  amountCents,
  billableHours,
  computeInvoice,
  formatUsd,
  DEFAULT_RATE_USD_PER_HOUR,
} from './invoice.js';

const RATE = DEFAULT_RATE_USD_PER_HOUR;

describe('amountCents', () => {
  it('bills whole hours exactly', () => {
    expect(amountCents(60, 20)).toBe(2000);
    expect(amountCents(15 * 60, 20)).toBe(30000);
  });

  it('bills partial hours to the cent', () => {
    expect(amountCents(15, 20)).toBe(500);
    expect(amountCents(45, 20)).toBe(1500);
    // 10m at $20 is $3.3333 — rounds up, never truncates.
    expect(amountCents(10, 20)).toBe(333);
    expect(amountCents(5, 20)).toBe(167);
  });

  it('bills nothing for nothing', () => {
    expect(amountCents(0, 20)).toBe(0);
  });
});

describe('formatUsd', () => {
  it('renders cents with a thousands separator', () => {
    expect(formatUsd(0)).toBe('$0.00');
    expect(formatUsd(500)).toBe('$5.00');
    expect(formatUsd(167)).toBe('$1.67');
    expect(formatUsd(511500)).toBe('$5,115.00');
  });
});

describe('billableHours', () => {
  it('reports decimal hours at two places', () => {
    expect(billableHours(90)).toBe(1.5);
    expect(billableHours(15)).toBe(0.25);
    expect(billableHours(605)).toBe(10.08);
  });
});

describe('computeInvoice', () => {
  const input = {
    month: '2026-08',
    rateUsdPerHour: RATE,
    person: 'Demitri',
    projects: [
      {
        key: 'north10',
        label: 'North10AI',
        rows: [
          { person: 'Demitri', minutes: 120 },
          { person: 'Jamir', minutes: 90 },
        ],
      },
      {
        key: 'lp',
        label: 'LP Internal AI',
        rows: [
          { person: 'Demitri', minutes: 60 },
          { person: 'Jose', minutes: 30 },
        ],
      },
    ],
  };

  it('totals hours and money across projects', () => {
    const inv = computeInvoice(input);
    expect(inv.totalMinutes).toBe(300);
    expect(inv.totalAmountCents).toBe(10000);
    expect(inv.oursMinutes).toBe(180);
    expect(inv.oursAmountCents).toBe(6000);
    expect(inv.othersMinutes).toBe(120);
    expect(inv.othersAmountCents).toBe(4000);
    expect(inv.oursShare).toBeCloseTo(0.6);
  });

  it('keeps a per-project breakdown that sums to the headline', () => {
    const inv = computeInvoice(input);
    expect(inv.byProject.map((p) => p.key)).toEqual(['north10', 'lp']);
    expect(inv.byProject.reduce((s, p) => s + p.amountCents, 0)).toBe(inv.totalAmountCents);
    expect(inv.byProject.reduce((s, p) => s + p.oursAmountCents, 0)).toBe(inv.oursAmountCents);
    const north10 = inv.byProject[0]!;
    expect(north10.minutes).toBe(210);
    expect(north10.oursMinutes).toBe(120);
  });

  it('ranks people by hours, descending, across projects', () => {
    const inv = computeInvoice(input);
    expect(inv.byPerson.map((l) => [l.person, l.minutes])).toEqual([
      ['Demitri', 180],
      ['Jamir', 90],
      ['Jose', 30],
    ]);
    expect(inv.byPerson.filter((l) => l.ours).map((l) => l.person)).toEqual(['Demitri']);
  });

  // The sheet really does hold both spellings; unfolded, one person shows up
  // twice and neither line matches what the invoice claims they worked.
  it('folds casing duplicates onto the first-seen spelling', () => {
    const inv = computeInvoice({
      ...input,
      projects: [
        {
          key: 'lp',
          label: 'LP Internal AI',
          rows: [
            { person: 'Kristian', minutes: 60 },
            { person: 'kristian', minutes: 30 },
          ],
        },
      ],
    });
    expect(inv.byPerson).toEqual([
      { person: 'Kristian', minutes: 90, amountCents: 3000, ours: false },
    ]);
  });

  it('matches our own name case-insensitively', () => {
    const inv = computeInvoice({
      ...input,
      person: 'demitri',
      projects: [{ key: 'lp', label: 'LP Internal AI', rows: [{ person: 'Demitri', minutes: 60 }] }],
    });
    expect(inv.oursMinutes).toBe(60);
    expect(inv.othersMinutes).toBe(0);
    expect(inv.oursShare).toBe(1);
  });

  // Rounding is per line, and the total is the sum of the lines. Three 10m
  // lines are $3.33 each; a fresh multiplication on 30m folded would say
  // $10.00 and the invoice would not equal its own rows.
  it('totals the rounded lines rather than re-multiplying the folded minutes', () => {
    const inv = computeInvoice({
      ...input,
      projects: [
        {
          key: 'lp',
          label: 'LP Internal AI',
          rows: [
            { person: 'A', minutes: 10 },
            { person: 'B', minutes: 10 },
            { person: 'C', minutes: 10 },
          ],
        },
      ],
    });
    expect(inv.totalAmountCents).toBe(999);
    expect(inv.byPerson.reduce((s, l) => s + l.amountCents, 0)).toBe(inv.totalAmountCents);
  });

  it('counts unparsable named rows without billing them', () => {
    const inv = computeInvoice({
      ...input,
      projects: [
        {
          key: 'lp',
          label: 'LP Internal AI',
          rows: [
            { person: 'Demitri', minutes: 60 },
            { person: 'Jose', minutes: null },
            { person: '', minutes: null },
          ],
        },
      ],
    });
    expect(inv.unparsedRows).toBe(1);
    expect(inv.totalMinutes).toBe(60);
  });

  it('reports a zero share for an empty month instead of dividing by zero', () => {
    const inv = computeInvoice({ ...input, projects: [] });
    expect(inv.totalMinutes).toBe(0);
    expect(inv.oursShare).toBe(0);
    expect(inv.totalAmountCents).toBe(0);
  });
});
