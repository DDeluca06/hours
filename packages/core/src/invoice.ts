// ---------------------------------------------------------------------------
// Invoice math.
//
// Turns logged minutes into money at a flat hourly rate, and separates our
// hours from everyone else's on the same tab — the two engagements are billed
// off shared spreadsheets that the whole team writes into, so "what is this
// month worth" and "how much of it is ours" are different questions and both
// get asked at invoice time.
//
// Pure, like the rest of this package: the caller supplies rows already read
// from wherever they live. Nothing here knows about Google, SQLite, or which
// rows fell in the month — that filtering happens where the date format is
// known, because only the sheet reader knows that "8/12" may carry no year.
// ---------------------------------------------------------------------------

/** Flat billing rate for both engagements, in dollars per hour. */
export const DEFAULT_RATE_USD_PER_HOUR = 20;

/** One row of billable time, already narrowed to the invoice period. */
export interface BillableRow {
  person: string;
  /** Null is an unparsable Hours cell. Counted nowhere, reported separately. */
  minutes: number | null;
}

export interface InvoiceProjectInput {
  /** Short project key, e.g. "north10". */
  key: string;
  /** Display label — the sheet tab title, normally. */
  label: string;
  rows: readonly BillableRow[];
}

export interface InvoiceInput {
  /** Period label, YYYY-MM. Carried through for display; no math depends on it. */
  month: string;
  rateUsdPerHour: number;
  /** Whose hours count as "ours". Matched case-insensitively. */
  person: string;
  projects: readonly InvoiceProjectInput[];
}

export interface InvoiceLine {
  /** First-seen spelling, so the label matches the sheet the reader will check. */
  person: string;
  minutes: number;
  amountCents: number;
  /** True when this line is the invoicing person. */
  ours: boolean;
}

export interface ProjectInvoice {
  key: string;
  label: string;
  minutes: number;
  amountCents: number;
  oursMinutes: number;
  oursAmountCents: number;
  /** Rows whose Hours cell could not be read, so a gap is visible not silent. */
  unparsedRows: number;
  /** Descending by minutes. */
  byPerson: InvoiceLine[];
}

export interface Invoice {
  month: string;
  rateUsdPerHour: number;
  person: string;
  totalMinutes: number;
  oursMinutes: number;
  othersMinutes: number;
  totalAmountCents: number;
  oursAmountCents: number;
  othersAmountCents: number;
  /** Our minutes as a fraction of the total, 0 when nothing was logged. */
  oursShare: number;
  unparsedRows: number;
  byProject: ProjectInvoice[];
  /** Across all projects, descending by minutes. */
  byPerson: InvoiceLine[];
}

/**
 * Minutes → cents at an hourly rate, rounded half-up.
 *
 * Cents, not dollars, and integers all the way through: an invoice assembled
 * from floating-point dollars lands a cent off its own line items often enough
 * to matter, and the person reading it has no way to tell that from a real
 * disagreement about hours.
 */
export function amountCents(minutes: number, rateUsdPerHour: number): number {
  return Math.round((minutes / 60) * rateUsdPerHour * 100);
}

/** 123456 → "$1,234.56". */
export function formatUsd(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  const dollars = Math.floor(abs / 100).toLocaleString('en-US');
  return `${sign}$${dollars}.${String(abs % 100).padStart(2, '0')}`;
}

/** Minutes as decimal hours, the unit an invoice is read in. */
export function billableHours(minutes: number): number {
  return Math.round((minutes / 60) * 100) / 100;
}

function foldPeople(rows: readonly BillableRow[]): {
  people: Map<string, { label: string; minutes: number }>;
  unparsedRows: number;
} {
  const people = new Map<string, { label: string; minutes: number }>();
  let unparsedRows = 0;
  for (const row of rows) {
    const label = row.person.trim();
    if (row.minutes === null) {
      // A blank spacing row carries neither; only a named row is a real gap.
      if (label) unparsedRows += 1;
      continue;
    }
    if (!label) continue;
    // The sheet holds casing duplicates (Kristian/kristian). Fold them, but
    // keep the first spelling as the label so the line matches the sheet.
    const key = label.toLowerCase();
    const seen = people.get(key);
    if (seen) seen.minutes += row.minutes;
    else people.set(key, { label, minutes: row.minutes });
  }
  return { people, unparsedRows };
}

function toLines(
  people: ReadonlyMap<string, { label: string; minutes: number }>,
  rateUsdPerHour: number,
  ourKey: string,
): InvoiceLine[] {
  return [...people.entries()]
    .map(([key, v]) => ({
      person: v.label,
      minutes: v.minutes,
      amountCents: amountCents(v.minutes, rateUsdPerHour),
      ours: key === ourKey,
    }))
    .sort((a, b) => b.minutes - a.minutes || a.person.localeCompare(b.person));
}

/**
 * Fold billable rows into an invoice.
 *
 * Every money figure is the sum of the per-person lines beneath it rather than
 * a fresh rate multiplication on the folded minutes. Those differ by up to a
 * cent per line, and an invoice whose total does not equal its own rows is the
 * one thing guaranteed to get it sent back.
 */
export function computeInvoice(input: InvoiceInput): Invoice {
  const ourKey = input.person.trim().toLowerCase();
  const rate = input.rateUsdPerHour;

  const byProject: ProjectInvoice[] = [];
  const overall = new Map<string, { label: string; minutes: number }>();

  for (const project of input.projects) {
    const { people, unparsedRows } = foldPeople(project.rows);
    for (const [key, v] of people) {
      const seen = overall.get(key);
      if (seen) seen.minutes += v.minutes;
      else overall.set(key, { label: v.label, minutes: v.minutes });
    }

    const lines = toLines(people, rate, ourKey);
    const ours = lines.filter((l) => l.ours);
    byProject.push({
      key: project.key,
      label: project.label,
      minutes: lines.reduce((s, l) => s + l.minutes, 0),
      amountCents: lines.reduce((s, l) => s + l.amountCents, 0),
      oursMinutes: ours.reduce((s, l) => s + l.minutes, 0),
      oursAmountCents: ours.reduce((s, l) => s + l.amountCents, 0),
      unparsedRows,
      byPerson: lines,
    });
  }

  const byPerson = toLines(overall, rate, ourKey);
  const totalMinutes = byPerson.reduce((s, l) => s + l.minutes, 0);
  const totalAmountCents = byPerson.reduce((s, l) => s + l.amountCents, 0);
  // Ours is summed per project, not from the folded line: the per-project
  // figures are what get invoiced against each contract, so the headline has
  // to be their sum or the two halves of the report disagree.
  const oursMinutes = byProject.reduce((s, p) => s + p.oursMinutes, 0);
  const oursAmountCents = byProject.reduce((s, p) => s + p.oursAmountCents, 0);

  return {
    month: input.month,
    rateUsdPerHour: rate,
    person: input.person.trim(),
    totalMinutes,
    oursMinutes,
    othersMinutes: totalMinutes - oursMinutes,
    totalAmountCents,
    oursAmountCents,
    othersAmountCents: totalAmountCents - oursAmountCents,
    oursShare: totalMinutes === 0 ? 0 : oursMinutes / totalMinutes,
    unparsedRows: byProject.reduce((s, p) => s + p.unparsedRows, 0),
    byProject,
    byPerson,
  };
}
