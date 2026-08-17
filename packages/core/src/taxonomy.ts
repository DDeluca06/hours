// ---------------------------------------------------------------------------
// Activity taxonomy.
//
// These are not invented labels — they are the exact strings already in use in
// the shared Hours sheet's Activity/Category column (verified against both tabs,
// 2026-08-14), ordered by how often they appear across the tabs. Pushing
// anything else would fragment the pivot tables that live to the right of the
// data on every tab, so the writer refuses unknown activities and the
// classifier can only ever return one of these.
//
// The two tabs disagree on the header ("Activity" on some, "Category" on
// others) but hold one value set. OpenProject's own activity vocabulary
// (Management, Specification, Development, …) is a different thing and is never
// accepted here — an agent that read it must translate, not copy.
// ---------------------------------------------------------------------------

export const ACTIVITIES = [
  'Project Management',
  'Development',
  'Wireframes',
  'Data model',
  'Client Meeting',
  'Scoping',
  'Testing/QA',
  'User Stories',
  'Misc',
] as const;

export type Activity = (typeof ACTIVITIES)[number];

export function isActivity(v: string): v is Activity {
  return (ACTIVITIES as readonly string[]).includes(v);
}

/**
 * Activities this tool used to offer, mapped to where their work goes now.
 *
 * `Documentation`, `Deployment` and `Research/Learning` were dropped once the
 * sheet was verified — they are not in its value set, so pushing them would
 * fragment the pivot tables. But rows carrying them are already in the local
 * store, some of them already approved, and without this table they become
 * validation *errors* the moment the taxonomy shrinks: an approved entry that
 * can never be pushed and has to be hand-edited. Reads remap instead
 * (`packages/db/src/entries.ts`), and `resolveActivity` still accepts the old
 * names so an agent quoting one from an older transcript lands in the right
 * bucket rather than getting an error.
 *
 * Deliberately not advertised in `ACTIVITY_SHORTHANDS`: these are accepted for
 * compatibility, not offered as choices.
 */
export const LEGACY_ACTIVITIES: Record<string, Activity> = {
  documentation: 'Misc',
  deployment: 'Misc',
  'research/learning': 'Misc',
};

/**
 * The canonical activity for a stored value, remapping the retired ones.
 *
 * Returns null for anything that is neither current nor retired — an unknown
 * activity is a real error and must not be silently swallowed into Misc.
 */
export function canonicalActivity(v: string): Activity | null {
  if (isActivity(v)) return v;
  return LEGACY_ACTIVITIES[v.trim().toLowerCase()] ?? null;
}

/**
 * Every shorthand `resolveActivity` accepts, mapped to its canonical activity.
 * Declared before the derived constants below — they invert this table.
 */
const aliases: Record<string, Activity> = {
  dev: 'Development',
  code: 'Development',
  coding: 'Development',
  pm: 'Project Management',
  mgmt: 'Project Management',
  standup: 'Project Management',
  'stand-up': 'Project Management',
  meeting: 'Client Meeting',
  client: 'Client Meeting',
  call: 'Client Meeting',
  qa: 'Testing/QA',
  test: 'Testing/QA',
  tests: 'Testing/QA',
  testing: 'Testing/QA',
  schema: 'Data model',
  db: 'Data model',
  database: 'Data model',
  migration: 'Data model',
  design: 'Wireframes',
  ui: 'Wireframes',
  ux: 'Wireframes',
  wireframe: 'Wireframes',
  scope: 'Scoping',
  stories: 'User Stories',
  story: 'User Stories',
  misc: 'Misc',
  other: 'Misc',
  // These seven name the work the retired activities used to hold. They point at
  // Misc because that is what `ACTIVITY_GUIDE.Misc` promises and what
  // `guessFromPaths`/`guessFromSubject` already classify docs, CI/infra and
  // research as. Dropping them instead would make `hours log 1h docs` fail
  // while the error message it prints advertises them as included.
  docs: 'Misc',
  doc: 'Misc',
  deploy: 'Misc',
  ci: 'Misc',
  infra: 'Misc',
  research: 'Misc',
  learning: 'Misc',
};

/**
 * What each activity is for, one line each. These live here — not in the MCP
 * server — so the CLI, the MCP tools, and the error messages all describe the
 * taxonomy identically. The lines exist to disambiguate the overlapping cases
 * agents get wrong: Development vs Data model, Client Meeting vs Project
 * Management, Testing/QA vs Development.
 */
export const ACTIVITY_GUIDE: Record<Activity, string> = {
  'Project Management': 'standups, planning, retros, task admin, status syncs',
  Development: 'writing or refactoring code — features, bug fixes, perf',
  Wireframes: 'UI design — mockups, layouts, styling, frontend look',
  'Data model': 'schema, migrations, database work',
  'Client Meeting': 'calls, demos, and meetings with the client',
  Scoping: 'estimates, proposals, SOW, requirement analysis',
  'Testing/QA': 'writing tests, manual QA, verification',
  'User Stories': 'stories, acceptance criteria, backlog grooming',
  Misc: 'anything that fits no other bucket — docs, CI/infra, research included',
};

/**
 * Every shorthand `resolveActivity` accepts, per activity. Derived from the
 * alias table so the guidance can never drift from the resolver.
 */
export const ACTIVITY_SHORTHANDS: Record<Activity, string[]> = (() => {
  // Seeded for *every* activity, not just the ones that appear in the alias
  // table, because the type says this record is total and `activityListText`
  // reads `.length` off it unguarded. An activity added without an alias would
  // otherwise turn every invalid-activity error message — the one place that
  // has to work when something is already wrong — into a TypeError.
  const out: Record<string, string[]> = {};
  for (const a of ACTIVITIES) out[a] = [];
  for (const [alias, activity] of Object.entries(aliases)) {
    // The full name lowercased is not a shorthand ("data model" → Data model).
    if (alias === activity.toLowerCase()) continue;
    const list = (out[activity] ??= []);
    list.push(alias);
  }
  for (const a of ACTIVITIES) out[a]?.sort();
  return out as Record<Activity, string[]>;
})();

/** One activity per line with its shorthands and guidance — for errors and tool output. */
export function activityListText(): string {
  return ACTIVITIES.map((a) => {
    const short = ACTIVITY_SHORTHANDS[a];
    return `  ${a}${short.length ? ` (${short.join(', ')})` : ''} — ${ACTIVITY_GUIDE[a]}`;
  }).join('\n');
}

/**
 * The wording for the `activity` parameter on every MCP tool and CLI error.
 *
 * The sheet's header disagrees per tab (Activity on some, Category on others —
 * see CLAUDE.md) but it is one column with one value set, and that set is what
 * the pivot tables pivot on. Saying it out loud here is what stops an agent
 * treating the parameter as a free-form description of the work.
 */
export function activityParamText(): string {
  return (
    'The fixed value for the sheet\'s Activity/Category column (some tabs call it "Activity", others "Category" — one column, one value set). ' +
    'Not a free-form description — what you actually did goes in the "note" parameter. ' +
    'OpenProject\'s own activity names (Management, Specification, …) are a different vocabulary and are not accepted here. One of:\n' +
    activityListText()
  );
}

/**
 * The one-line form of the above, for MCP tool parameter descriptions.
 *
 * Six parameters across four tools describe this same field, and the full text
 * is nine lines, so `activityParamText()` shipped ~90 words six times in every
 * `tools/list` payload — the exact cost the `list_activities` tool exists to
 * remove. What has to survive the trim is the part an agent gets wrong: that
 * this is a fixed value set, that the description of the work belongs in `note`,
 * and that OpenProject's vocabulary is not this one. The list itself is one tool
 * call away, and every rejection prints it in full.
 */
export function activityParamHint(): string {
  return (
    "One of the sheet's fixed Activity/Category values (some tabs call the column \"Activity\", others \"Category\" — one value set) — call list_activities for the list. " +
    'Not a free-form description: what you actually did goes in "note". ' +
    "OpenProject's own activity names (Management, Specification, …) are a different vocabulary and are not accepted."
  );
}

/**
 * Resolve a loose user-typed activity to a canonical one.
 *
 * Accepts case-insensitive matches, common shorthands, and unique prefixes, so
 * `hours log 90 dev` and `hours log 90 "data model"` both work. Returns null
 * rather than guessing when the input is ambiguous.
 */
export function resolveActivity(input: string): Activity | null {
  const t = input.trim().toLowerCase();
  if (!t) return null;

  if (aliases[t]) return aliases[t];

  const exact = ACTIVITIES.find((a) => a.toLowerCase() === t);
  if (exact) return exact;

  // A retired activity resolves to where its work lives now rather than
  // failing — see LEGACY_ACTIVITIES. Checked after the current names so a
  // re-added activity always wins over its own compatibility entry.
  const legacy = LEGACY_ACTIVITIES[t];
  if (legacy) return legacy;

  const prefixed = ACTIVITIES.filter((a) => a.toLowerCase().startsWith(t));
  return prefixed.length === 1 ? (prefixed[0] as Activity) : null;
}

/** A classification with the reason attached, so the review UI can justify it. */
export interface ActivityGuess {
  activity: Activity;
  /** 0–1. Below `CONFIDENT` the review step should ask rather than assume. */
  confidence: number;
  reason: string;
}

export const CONFIDENT = 0.6;

/**
 * Guess an activity from the file paths a block of work touched.
 *
 * Ordered most-specific-first: a commit that touches both `prisma/schema.prisma`
 * and a test file is data-model work with tests, not the reverse. Only paths
 * carry signal here; commit subjects are handled by `guessFromSubject`.
 */
export function guessFromPaths(paths: readonly string[]): ActivityGuess | null {
  if (paths.length === 0) return null;

  const rules: Array<{ activity: Activity; re: RegExp; reason: string; weight: number }> = [
    {
      activity: 'Data model',
      re: /(^|\/)(prisma\/|migrations?\/|schema\.prisma$|\.sql$)/i,
      reason: 'touched schema/migrations',
      weight: 0.85,
    },
    {
      // CI/infra work has no Deployment category in the sheet — Misc is the
      // catch-all; the reason keeps the reclassification decision visible.
      activity: 'Misc',
      re: /(^|\/)(\.github\/workflows\/|infra\/|docker-compose|Dockerfile|\.tf$)/i,
      reason: 'touched CI/infra',
      weight: 0.8,
    },
    {
      activity: 'Testing/QA',
      re: /(\.(test|spec)\.[tj]sx?$|(^|\/)(tests?|__tests__)\/)/i,
      reason: 'touched tests',
      weight: 0.75,
    },
    {
      // Documentation work has no category of its own in the sheet — it lands
      // in Misc with the reason attached so review can promote it.
      activity: 'Misc',
      re: /(^|\/)(docs?\/|README|CLAUDE\.md$|\.mdx?$)/i,
      reason: 'touched docs',
      weight: 0.7,
    },
    {
      activity: 'Wireframes',
      re: /(^|\/)(components?\/|ui\/|\.css$|tailwind|\.svg$|app\/.*page\.tsx$)/i,
      reason: 'touched UI',
      weight: 0.6,
    },
  ];

  // Score by share of files matched, so one stray docs tweak inside a big
  // feature commit doesn't relabel the whole block.
  let best: ActivityGuess | null = null;
  for (const rule of rules) {
    const hits = paths.filter((p) => rule.re.test(p)).length;
    if (hits === 0) continue;
    const share = hits / paths.length;
    const confidence = rule.weight * (0.4 + 0.6 * share);
    if (!best || confidence > best.confidence) {
      best = { activity: rule.activity, confidence, reason: `${rule.reason} (${hits}/${paths.length})` };
    }
  }

  if (best && best.confidence >= 0.5) return best;
  return { activity: 'Development', confidence: 0.55, reason: `${paths.length} source files changed` };
}

/**
 * Guess an activity from a commit subject or session title.
 *
 * Leans on Conventional Commit prefixes first (this team uses them — see the
 * git logs of both repos), then falls back to keyword hints.
 */
export function guessFromSubject(subject: string): ActivityGuess | null {
  const t = subject.trim().toLowerCase();
  if (!t) return null;

  const cc = /^(\w+)(?:\([^)]*\))?!?:/.exec(t);
  const byType: Record<string, Activity> = {
    feat: 'Development',
    fix: 'Development',
    perf: 'Development',
    refactor: 'Development',
    test: 'Testing/QA',
    // docs:/ci:/build: work has no sheet category — Misc is the catch-all, and
    // the commit type stays visible in the reason for the review step.
    docs: 'Misc',
    ci: 'Misc',
    build: 'Misc',
    chore: 'Misc',
    style: 'Wireframes',
  };
  if (cc) {
    const type = cc[1] ?? '';
    const mapped = byType[type];
    if (mapped) return { activity: mapped, confidence: 0.75, reason: `commit type "${type}:"` };
  }

  const keywords: Array<[RegExp, Activity, string]> = [
    [/\b(schema|migration|prisma|data model|table|column)\b/, 'Data model', 'schema keywords'],
    [/\b(deploy|release|pipeline|ecs|fargate|terraform)\b/, 'Misc', 'deploy keywords'],
    [/\b(wireframe|mockup|figma|layout|styling)\b/, 'Wireframes', 'design keywords'],
    [/\b(scope|scoping|estimate|proposal|sow)\b/, 'Scoping', 'scoping keywords'],
    [/\b(user stor|acceptance criteria|backlog groom)\b/, 'User Stories', 'story keywords'],
    [/\b(standup|stand-up|retro|planning|sync|kickoff)\b/, 'Project Management', 'ceremony keywords'],
    [/\b(client|demo|walkthrough)\b/, 'Client Meeting', 'client keywords'],
    [/\b(research|spike|investigate|read up|learn)\b/, 'Misc', 'research keywords'],
  ];
  for (const [re, activity, reason] of keywords) {
    if (re.test(t)) return { activity, confidence: 0.65, reason };
  }
  return null;
}

/** Combine any number of guesses, preferring the most confident. */
export function bestGuess(...guesses: Array<ActivityGuess | null>): ActivityGuess {
  const real = guesses.filter((g): g is ActivityGuess => g !== null);
  if (real.length === 0) {
    return { activity: 'Development', confidence: 0.3, reason: 'no signal — defaulted' };
  }
  return real.reduce((a, b) => (b.confidence > a.confidence ? b : a));
}
