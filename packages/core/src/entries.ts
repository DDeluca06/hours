// ---------------------------------------------------------------------------
// Blocks → sheet rows.
//
// An Entry is one row of the Hours sheet, in the sheet's own conventions: Date
// as "8/12", Hours as a "h:mm:ss" duration, Activity from the fixed taxonomy,
// Notes carrying the clock ranges plus a short description. Entries carry a
// status so nothing reaches the shared sheet without review — draft → approved
// → pushed, one direction only.
// ---------------------------------------------------------------------------

import { formatClockRanges, formatMinutesAsDuration, type ClockRange } from './duration.js';
import type { InferredBlock } from './blocks.js';
import { isActivity, type Activity } from './taxonomy.js';
import { formatSheetDate, localDayKey } from './workday.js';

export type EntryStatus = 'draft' | 'approved' | 'pushed';

export interface Entry {
  /** Local calendar day, YYYY-MM-DD. */
  day: string;
  /** Who the row is for — matches the sheet's Person column. */
  person: string;
  projectKey: string;
  minutes: number;
  activity: Activity;
  /** Clock ranges the minutes came from; may be empty for a manual bulk log. */
  ranges: ClockRange[];
  /** Free text appended after the ranges, behind a " | ". */
  description?: string;
  status: EntryStatus;
  /** Why the tool believed this, for anything inferred. Never pushed. */
  provenance?: string;
  /**
   * sourceIds of the signals this entry was inferred from. Kept so a discarded
   * draft can hand its signals back to the pool rather than burying that time.
   * Absent on a manually logged entry.
   */
  signalIds?: string[];
}

/** The four columns the writer appends, in sheet order. */
export interface SheetRow {
  date: string;
  person: string;
  hours: string;
  activity: string;
  notes: string;
}

export function entryFromBlock(
  block: InferredBlock,
  day: string,
  person: string,
  projectKey: string,
): Entry {
  const entry: Entry = {
    day,
    person,
    projectKey,
    minutes: block.minutes,
    activity: block.activity,
    ranges: [{ startMin: block.startMin, endMin: block.endMin }],
    status: 'draft',
    provenance: `${block.reason} [${block.signalIds.length} signal(s), confidence ${block.confidence.toFixed(2)}]`,
    signalIds: [...block.signalIds],
  };
  const description = summarizeSubjects(block.subjects);
  if (description) entry.description = description;
  return entry;
}

/**
 * Compress a run's subjects into one short Notes tail.
 *
 * Commit subjects are the best free description of what was actually done, but
 * a wall of them is unreadable in a spreadsheet cell — take the first two, drop
 * the Conventional Commit prefix, and count the rest.
 */
export function summarizeSubjects(subjects: readonly string[], max = 2): string | undefined {
  if (subjects.length === 0) return undefined;
  const cleaned = subjects.map((s) => s.replace(/^\w+(?:\([^)]*\))?!?:\s*/, '').trim()).filter(Boolean);
  if (cleaned.length === 0) return undefined;
  const head = cleaned.slice(0, max).join('; ');
  const rest = cleaned.length - max;
  return rest > 0 ? `${head} (+${rest} more)` : head;
}

/** Render an Entry into the exact cells to append. */
export function toSheetRow(entry: Entry, date = new Date(`${entry.day}T12:00:00`)): SheetRow {
  const rangeText = formatClockRanges(entry.ranges);
  const notes = [rangeText, entry.description].filter(Boolean).join(' | ');
  return {
    date: formatSheetDate(date),
    person: entry.person,
    hours: formatMinutesAsDuration(entry.minutes),
    activity: entry.activity,
    notes,
  };
}

export interface ValidationIssue {
  severity: 'error' | 'warning';
  message: string;
}

/**
 * Check an entry set before it can be pushed.
 *
 * Errors block the push; warnings are printed and require an explicit
 * confirmation. The distinction matters because a legitimately long day is a
 * warning, but an unknown activity would quietly break the tab's pivot table
 * and so is an error.
 */
export function validateEntries(
  entries: readonly Entry[],
  opts: { contractHoursRemaining?: number; maxDayMinutes?: number } = {},
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const maxDay = opts.maxDayMinutes ?? 10 * 60;

  for (const e of entries) {
    if (!isActivity(e.activity)) {
      issues.push({
        severity: 'error',
        message: `"${e.activity}" is not one of the sheet's activities — it would break the tab's pivot table`,
      });
    }
    if (e.minutes <= 0) {
      issues.push({ severity: 'error', message: `${e.day} ${e.activity}: non-positive duration` });
    }
    if (!e.person.trim()) {
      issues.push({ severity: 'error', message: `${e.day} ${e.activity}: missing person` });
    }
    if (e.minutes % 15 !== 0) {
      issues.push({
        severity: 'warning',
        message: `${e.day} ${e.activity}: ${e.minutes}m is not a multiple of 15, unlike every existing row`,
      });
    }
  }

  const byDayPerson = new Map<string, number>();
  for (const e of entries) {
    const k = `${e.day}|${e.person}`;
    byDayPerson.set(k, (byDayPerson.get(k) ?? 0) + e.minutes);
  }
  for (const [k, mins] of byDayPerson) {
    if (mins > maxDay) {
      const [day, person] = k.split('|');
      issues.push({
        severity: 'warning',
        message: `${person} logs ${(mins / 60).toFixed(2)}h on ${day} — over the ${maxDay / 60}h sanity limit`,
      });
    }
  }

  const overlaps = findOverlaps(entries);
  for (const o of overlaps) {
    issues.push({ severity: 'warning', message: o });
  }

  if (opts.contractHoursRemaining !== undefined) {
    const total = entries.reduce((s, e) => s + e.minutes, 0) / 60;
    if (total > opts.contractHoursRemaining) {
      issues.push({
        severity: 'warning',
        message: `pushing ${total.toFixed(2)}h exceeds the ${opts.contractHoursRemaining.toFixed(2)}h left on the contract`,
      });
    }
  }

  return issues;
}

/** Same person, same day, overlapping clock ranges — usually a double-log. */
function findOverlaps(entries: readonly Entry[]): string[] {
  const out: string[] = [];
  const groups = new Map<string, Entry[]>();
  for (const e of entries) {
    const k = `${e.day}|${e.person}`;
    const g = groups.get(k);
    if (g) g.push(e);
    else groups.set(k, [e]);
  }
  for (const [k, group] of groups) {
    const flat = group.flatMap((e) => e.ranges.map((r) => ({ r, e })));
    flat.sort((a, b) => a.r.startMin - b.r.startMin);
    for (let i = 1; i < flat.length; i++) {
      const prev = flat[i - 1];
      const cur = flat[i];
      if (prev && cur && cur.r.startMin < prev.r.endMin) {
        out.push(
          `${k.replace('|', ' ')}: "${prev.e.activity}" and "${cur.e.activity}" overlap in time`,
        );
      }
    }
  }
  return out;
}

export { localDayKey };
