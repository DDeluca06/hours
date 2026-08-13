// ---------------------------------------------------------------------------
// ISO-8601 duration → minutes.
//
// OpenProject reports time aggregates (spentTime, estimatedTime, remainingTime)
// and per-entry `hours` as ISO-8601 durations ("PT1H30M"). This parser is
// deliberately minimal — only the H/M/S components of the time part, which is
// what a single logged entry can be. Returns null on garbage instead of
// throwing, so callers can treat an unparseable duration as "no data" the same
// way they treat a null field, exactly like parseDurationToMinutes in
// packages/core. Day-scale durations ("P1D…") are outside this parser's remit
// and also yield null — a day component on an entry would indicate something
// the per-task logging never produces.
// ---------------------------------------------------------------------------

// "PT" + optional H, M, S components, each an integer or decimal fraction.
const ISO_DURATION_RE = /^PT(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?$/;

/**
 * Parse an ISO-8601 duration into whole minutes ("PT1H30M" → 90, "PT45M" → 45).
 *
 * Returns null when the input is null/undefined/empty or does not match the
 * minimal H/M/S form (including any day component, which is out of scope).
 * Fractional seconds round to the nearest minute rather than truncating —
 * the same convention the sheet durations use (CLAUDE.md: round, don't
 * truncate — totals drift low otherwise).
 */
export function parseIsoDurationToMinutes(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const m = ISO_DURATION_RE.exec(iso.trim());
  if (!m) return null;
  // At least one component must be present — bare "PT" is not a duration.
  if (m[1] === undefined && m[2] === undefined && m[3] === undefined) return null;
  const hours = m[1] === undefined ? 0 : Number(m[1]);
  const minutes = m[2] === undefined ? 0 : Number(m[2]);
  const seconds = m[3] === undefined ? 0 : Number(m[3]);
  return Math.round(hours * 60 + minutes + seconds / 60);
}
