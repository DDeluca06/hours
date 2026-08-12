// ---------------------------------------------------------------------------
// Activity taxonomy.
//
// These are not invented labels — they are the exact strings already in use in
// the shared Hours sheet's Activity/Category column, ordered by how often they
// appear across the tabs. Pushing anything else would fragment the pivot tables
// that live to the right of the data on every tab, so the writer refuses
// unknown activities and the classifier can only ever return one of these.
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
  'Documentation',
  'Deployment',
  'Research/Learning',
  'Misc',
] as const;

export type Activity = (typeof ACTIVITIES)[number];

export function isActivity(v: string): v is Activity {
  return (ACTIVITIES as readonly string[]).includes(v);
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
    docs: 'Documentation',
    doc: 'Documentation',
    deploy: 'Deployment',
    ci: 'Deployment',
    infra: 'Deployment',
    design: 'Wireframes',
    ui: 'Wireframes',
    ux: 'Wireframes',
    wireframe: 'Wireframes',
    scope: 'Scoping',
    research: 'Research/Learning',
    learning: 'Research/Learning',
    stories: 'User Stories',
    story: 'User Stories',
    misc: 'Misc',
    other: 'Misc',
  };
  if (aliases[t]) return aliases[t];

  const exact = ACTIVITIES.find((a) => a.toLowerCase() === t);
  if (exact) return exact;

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
      activity: 'Deployment',
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
      activity: 'Documentation',
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
    docs: 'Documentation',
    ci: 'Deployment',
    build: 'Deployment',
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
    [/\b(deploy|release|pipeline|ecs|fargate|terraform)\b/, 'Deployment', 'deploy keywords'],
    [/\b(wireframe|mockup|figma|layout|styling)\b/, 'Wireframes', 'design keywords'],
    [/\b(scope|scoping|estimate|proposal|sow)\b/, 'Scoping', 'scoping keywords'],
    [/\b(user stor|acceptance criteria|backlog groom)\b/, 'User Stories', 'story keywords'],
    [/\b(standup|stand-up|retro|planning|sync|kickoff)\b/, 'Project Management', 'ceremony keywords'],
    [/\b(client|demo|walkthrough)\b/, 'Client Meeting', 'client keywords'],
    [/\b(research|spike|investigate|read up|learn)\b/, 'Research/Learning', 'research keywords'],
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
