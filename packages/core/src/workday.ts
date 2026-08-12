// ---------------------------------------------------------------------------
// Workday shape and rounding.
//
// The team is in the office 9 AM–3 PM, and every existing row in the sheet is a
// multiple of 15 minutes. Both facts are policy, not physics, so they live here
// as one configurable object rather than as magic numbers sprinkled through the
// inference code.
// ---------------------------------------------------------------------------

export interface WorkdayPolicy {
  /** Start of the tracked window, minutes from midnight. Default 9:00. */
  startMin: number;
  /** End of the tracked window, minutes from midnight. Default 15:00. */
  endMin: number;
  /** Rounding granularity for pushed durations, in minutes. Default 15. */
  roundToMin: number;
  /** Blocks shorter than this after rounding are dropped. Default 15. */
  minBlockMin: number;
  /** Idle gap that splits one block into two, in minutes. Default 25. */
  gapMin: number;
}

export const DEFAULT_WORKDAY: WorkdayPolicy = {
  startMin: 9 * 60,
  endMin: 15 * 60,
  roundToMin: 15,
  minBlockMin: 15,
  gapMin: 25,
};

/** Round to the nearest multiple, with .5 going up. */
export function roundTo(minutes: number, granularity: number): number {
  if (granularity <= 0) return Math.round(minutes);
  return Math.round(minutes / granularity) * granularity;
}

/** Minutes from midnight for a Date, in local time. */
export function minutesFromMidnight(d: Date): number {
  return d.getHours() * 60 + d.getMinutes();
}

/** Local calendar day as YYYY-MM-DD — never use toISOString(), it shifts to UTC. */
export function localDayKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** The sheet's Date column convention: "8/12" — no year, no leading zeros. */
export function formatSheetDate(d: Date): string {
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

/**
 * Clamp a range into the workday window.
 *
 * Returns null when the range falls entirely outside it. Work genuinely does
 * happen after 3 PM; `allowOutside` exists so the reconstruction step can keep
 * such a block instead of silently deleting evidence of real work.
 */
export function clampToWorkday(
  startMin: number,
  endMin: number,
  policy: WorkdayPolicy = DEFAULT_WORKDAY,
  allowOutside = false,
): { startMin: number; endMin: number } | null {
  if (allowOutside) return { startMin, endMin };
  const s = Math.max(startMin, policy.startMin);
  const e = Math.min(endMin, policy.endMin);
  if (e <= s) return null;
  return { startMin: s, endMin: e };
}
