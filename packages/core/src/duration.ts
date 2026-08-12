// ---------------------------------------------------------------------------
// Durations and clock ranges.
//
// The shared Hours sheet stores the Hours column as a real Google Sheets
// duration, which the API hands back as "h:mm:ss" (e.g. "1:45:00"). Internally
// we only ever deal in whole minutes — every quantity the team logs is a
// multiple of 15 minutes, so minutes are lossless and dodge float drift on
// sums.
//
// The Notes column carries the raw clock ranges the duration was derived from
// ("9:00 - 10:45", "2-2:30, 3:30-3:45", "1:30 - 3:15 | Stand-up"). We both
// parse those (to reconstruct history) and emit them (so a pushed row explains
// itself to a human reading the sheet).
// ---------------------------------------------------------------------------

/** A half-open interval of wall-clock minutes-from-midnight. */
export interface ClockRange {
  /** Minutes from midnight, inclusive. */
  startMin: number;
  /** Minutes from midnight, exclusive. */
  endMin: number;
}

/** Parse a Sheets duration ("1:45:00", "0:45:00", "13:15:00") into minutes. */
export function parseDurationToMinutes(raw: string | undefined | null): number | null {
  if (!raw) return null;
  const t = raw.trim();
  if (!t) return null;

  // h:mm:ss or h:mm
  const hms = /^(\d+):([0-5]\d)(?::([0-5]\d))?$/.exec(t);
  if (hms) {
    const h = Number(hms[1]);
    const m = Number(hms[2]);
    const s = hms[3] ? Number(hms[3]) : 0;
    // The sheet has rows like 13:14:59 where the pivot rounds 13:15:00 — round
    // to the nearest minute rather than truncating, or totals drift low.
    return h * 60 + m + Math.round(s / 60);
  }

  // Decimal hours ("1.75", "2h", "1.5 hrs")
  const dec = /^(\d+(?:\.\d+)?)\s*(?:h|hr|hrs|hours?)?$/i.exec(t);
  if (dec) return Math.round(Number(dec[1]) * 60);

  return null;
}

/** Render minutes as the "h:mm:ss" string the sheet's Hours column expects. */
export function formatMinutesAsDuration(minutes: number): string {
  if (!Number.isFinite(minutes) || minutes < 0) throw new RangeError(`bad minutes: ${minutes}`);
  const total = Math.round(minutes);
  const h = Math.floor(total / 60);
  const m = total % 60;
  return `${h}:${String(m).padStart(2, '0')}:00`;
}

/** Render minutes for humans: "1h 45m", "45m", "2h". */
export function formatMinutesShort(minutes: number): string {
  const total = Math.round(minutes);
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (h && m) return `${h}h ${m}m`;
  if (h) return `${h}h`;
  return `${m}m`;
}

/** Minutes from midnight → "9:00", "14:45" (24h, no leading zero on hour). */
export function formatClock(minutesFromMidnight: number): string {
  const m = ((Math.round(minutesFromMidnight) % 1440) + 1440) % 1440;
  return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}`;
}

/**
 * Parse a single clock token into minutes from midnight.
 *
 * The sheet is written by humans across a 9 AM–3 PM day, so bare hours are
 * ambiguous: "2" means 2 PM, "9" means 9 AM. We resolve with an explicit
 * meridiem when present, otherwise assume the token falls inside the workday
 * window — anything below 8 is treated as afternoon.
 */
export function parseClockToken(raw: string): number | null {
  const t = raw.trim().toLowerCase().replace(/\s+/g, '');
  const m = /^(\d{1,2})(?::([0-5]\d))?(am|pm|a|p)?$/.exec(t);
  if (!m) return null;

  let hour = Number(m[1]);
  const min = m[2] ? Number(m[2]) : 0;
  const mer = m[3]?.[0];

  if (hour > 23) return null;

  if (mer === 'p') {
    if (hour < 12) hour += 12;
  } else if (mer === 'a') {
    if (hour === 12) hour = 0;
  } else if (hour < 8) {
    // No meridiem: 1–7 can only mean afternoon in a 9-to-3 day.
    hour += 12;
  }

  return hour * 60 + min;
}

/**
 * Parse the clock ranges out of a Notes cell.
 *
 * Handles "9:00 - 10:45", "2-2:30, 3:30-3:45", "2:30 PM - 3:30 PM", and
 * ignores any trailing free text after a "|" separator. Returns [] when the
 * cell holds no recognizable range, which is common — plenty of rows are just
 * a description.
 */
export function parseClockRanges(notes: string | undefined | null): ClockRange[] {
  if (!notes) return [];
  const beforePipe = notes.split('|')[0] ?? '';
  const out: ClockRange[] = [];

  const re = /(\d{1,2}(?::\d{2})?\s*(?:am|pm|a\.m\.|p\.m\.)?)\s*(?:-|–|—|to)\s*(\d{1,2}(?::\d{2})?\s*(?:am|pm|a\.m\.|p\.m\.)?)/gi;
  for (const m of beforePipe.matchAll(re)) {
    const startMin = parseClockToken((m[1] ?? '').replace(/\./g, ''));
    let endMin = parseClockToken((m[2] ?? '').replace(/\./g, ''));
    if (startMin === null || endMin === null) continue;
    // "11-1" crosses noon: the end must follow the start.
    if (endMin <= startMin && endMin + 720 > startMin) endMin += 720;
    if (endMin <= startMin) continue;
    out.push({ startMin, endMin });
  }
  return out;
}

/** Render ranges back into the Notes convention: "9:00 - 10:45, 1:00 - 2:30". */
export function formatClockRanges(ranges: readonly ClockRange[]): string {
  return ranges.map((r) => `${formatClock(r.startMin)} - ${formatClock(r.endMin)}`).join(', ');
}

/** Total minutes covered by ranges, treating overlaps as covered only once. */
export function totalRangeMinutes(ranges: readonly ClockRange[]): number {
  return mergeRanges(ranges).reduce((sum, r) => sum + (r.endMin - r.startMin), 0);
}

/** Sort and union overlapping/adjacent ranges. */
export function mergeRanges(ranges: readonly ClockRange[]): ClockRange[] {
  const sorted = [...ranges].sort((a, b) => a.startMin - b.startMin);
  const out: ClockRange[] = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && r.startMin <= last.endMin) {
      last.endMin = Math.max(last.endMin, r.endMin);
    } else {
      out.push({ ...r });
    }
  }
  return out;
}
