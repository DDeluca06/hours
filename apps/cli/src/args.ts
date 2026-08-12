// ---------------------------------------------------------------------------
// Argument parsing.
//
// Hand-rolled rather than pulled from a library, for one reason: this CLI's job
// is to be faster to type than opening the spreadsheet, so the grammar is tiny
// and stable, and a dependency here buys nothing.
// ---------------------------------------------------------------------------

export interface ParsedArgs {
  command: string;
  positionals: string[];
  flags: Record<string, string | true>;
}

export function parseArgs(argv: readonly string[]): ParsedArgs {
  const [command = 'help', ...rest] = argv;
  const positionals: string[] = [];
  const flags: Record<string, string | true> = {};

  for (let i = 0; i < rest.length; i++) {
    const token = rest[i];
    if (!token) continue;

    if (token.startsWith('--')) {
      const body = token.slice(2);
      const eq = body.indexOf('=');
      if (eq !== -1) {
        flags[body.slice(0, eq)] = body.slice(eq + 1);
        continue;
      }
      // A following token that is not itself a flag is this flag's value;
      // otherwise the flag is boolean.
      const next = rest[i + 1];
      if (next !== undefined && !next.startsWith('-')) {
        flags[body] = next;
        i++;
      } else {
        flags[body] = true;
      }
      continue;
    }

    if (token.startsWith('-') && token.length > 1) {
      const short: Record<string, string> = { p: 'project', a: 'activity', d: 'day', n: 'note' };
      const name = short[token.slice(1)] ?? token.slice(1);
      const next = rest[i + 1];
      if (next !== undefined && !next.startsWith('-')) {
        flags[name] = next;
        i++;
      } else {
        flags[name] = true;
      }
      continue;
    }

    positionals.push(token);
  }

  return { command, positionals, flags };
}

export function flagString(flags: ParsedArgs['flags'], name: string): string | undefined {
  const v = flags[name];
  return typeof v === 'string' ? v : undefined;
}

export function flagBool(flags: ParsedArgs['flags'], name: string): boolean {
  return flags[name] === true || flags[name] === 'true';
}

/**
 * Parse a duration argument: "90", "90m", "1.5h", "1:30".
 *
 * Bare numbers are minutes, not hours — `hours log 90 dev` should mean 90
 * minutes, and treating it as 90 hours would be a memorable mistake.
 */
export function parseMinutesArg(raw: string): number | null {
  const t = raw.trim().toLowerCase();
  if (!t) return null;

  const hm = /^(\d+):([0-5]\d)$/.exec(t);
  if (hm) return Number(hm[1]) * 60 + Number(hm[2]);

  const hours = /^(\d+(?:\.\d+)?)\s*(?:h|hr|hrs|hours?)$/.exec(t);
  if (hours) return Math.round(Number(hours[1]) * 60);

  const mins = /^(\d+(?:\.\d+)?)\s*(?:m|min|mins|minutes?)?$/.exec(t);
  if (mins) return Math.round(Number(mins[1]));

  return null;
}

/**
 * Resolve a day argument: "today", "yesterday", "2026-08-12", "8/12", "-1".
 *
 * Returns a YYYY-MM-DD key in local time.
 */
export function parseDayArg(raw: string | undefined, now = new Date()): string {
  const key = (d: Date): string =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

  if (!raw) return key(now);
  const t = raw.trim().toLowerCase();

  if (t === 'today') return key(now);
  if (t === 'yesterday') {
    const d = new Date(now);
    d.setDate(d.getDate() - 1);
    return key(d);
  }

  const rel = /^-(\d+)$/.exec(t);
  if (rel) {
    const d = new Date(now);
    d.setDate(d.getDate() - Number(rel[1]));
    return key(d);
  }

  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return t;

  // "8/12" or "8/12/26" — the sheet's own convention.
  const us = /^(\d{1,2})\/(\d{1,2})(?:\/(\d{2}|\d{4}))?$/.exec(t);
  if (us) {
    const month = Number(us[1]);
    const day = Number(us[2]);
    let year = now.getFullYear();
    if (us[3]) year = us[3].length === 2 ? 2000 + Number(us[3]) : Number(us[3]);
    return key(new Date(year, month - 1, day));
  }

  throw new Error(`cannot read "${raw}" as a day (try today, yesterday, -2, 2026-08-12, or 8/12)`);
}
