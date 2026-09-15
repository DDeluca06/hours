import { describe, expect, it } from 'vitest';
import { summarizeSubjects, toSheetRow, validateEntries, type Entry } from './entries.js';
import { resolveActivity } from './taxonomy.js';
import { projectForPath, topLevelProjects } from './projects.js';

function entry(over: Partial<Entry> = {}): Entry {
  return {
    day: '2026-08-12',
    person: 'Demitri',
    projectKey: 'north10',
    minutes: 105,
    activity: 'Development',
    ranges: [{ startMin: 540, endMin: 645 }],
    status: 'draft',
    ...over,
  };
}

describe('toSheetRow', () => {
  it('emits the sheet conventions exactly', () => {
    const row = toSheetRow(entry({ description: 'Stand-up' }));
    expect(row).toEqual({
      date: '8/12',
      person: 'Demitri',
      hours: '1:45:00',
      activity: 'Development',
      project: '',
      notes: '9:00 AM - 10:45 AM | Stand-up',
    });
  });

  it('carries a project label when the caller supplies one', () => {
    const row = toSheetRow(entry(), undefined, 'NixOS');
    expect(row.project).toBe('NixOS');
  });

  it('omits the pipe when there is no description', () => {
    expect(toSheetRow(entry()).notes).toBe('9:00 AM - 10:45 AM');
  });

  // Parsing "2026-08-12" as a bare date yields UTC midnight, which is the 11th
  // in any negative-offset timezone — the row would carry the wrong date.
  it('does not slip a day in a western timezone', () => {
    expect(toSheetRow(entry({ day: '2026-08-12' })).date).toBe('8/12');
  });

  it('never pushes provenance into the sheet', () => {
    const row = toSheetRow(entry({ provenance: 'inferred from 3 commits' }));
    expect(JSON.stringify(row)).not.toContain('inferred');
  });

  it('prefixes the task ref before the clock range', () => {
    const row = toSheetRow(entry({ taskId: '136', description: 'Stand-up' }));
    expect(row.notes).toBe('[#136] 9:00 AM - 10:45 AM | Stand-up');
  });

  it('is exactly the task ref alone when there is no range or description', () => {
    expect(toSheetRow(entry({ taskId: '136', ranges: [] })).notes).toBe('[#136]');
  });

  it('omits the ref when the entry has no taskId', () => {
    expect(toSheetRow(entry()).notes).toBe('9:00 AM - 10:45 AM');
  });
});

describe('summarizeSubjects', () => {
  it('strips conventional-commit prefixes', () => {
    expect(summarizeSubjects(['feat(grants): real matcher'])).toBe('real matcher');
  });

  it('caps the list and counts the remainder', () => {
    expect(summarizeSubjects(['a', 'b', 'c', 'd'])).toBe('a; b (+2 more)');
  });

  it('is undefined when there is nothing to say', () => {
    expect(summarizeSubjects([])).toBeUndefined();
    expect(summarizeSubjects(['feat:'])).toBeUndefined();
  });

  it('drops raw prompt chatter from the note', () => {
    expect(
      summarizeSubjects([
        "Let's look at where we left off yesterday and plan the day",
        'feat(grants): real matcher',
      ]),
    ).toBe('real matcher');
    expect(
      summarizeSubjects(["Let's review the backlog", 'docs: playbook proposal']),
    ).toBe('playbook proposal');
  });

  it('drops interrupted-marker and continuation lines', () => {
    expect(summarizeSubjects(['[Request interrupted by user]', 'docs: playbook proposal'])).toBe(
      'playbook proposal',
    );
    expect(
      summarizeSubjects(['This session is being continued from a previous co…', 'fix: acl rows']),
    ).toBe('acl rows');
  });

  it('leaves the note undefined when every subject is chatter', () => {
    expect(summarizeSubjects(["Let's evaluate today's work packages"])).toBeUndefined();
  });
});

describe('validateEntries', () => {
  it('accepts a normal day silently', () => {
    expect(validateEntries([entry()])).toEqual([]);
  });

  it('errors on an activity outside the sheet taxonomy', () => {
    const issues = validateEntries([entry({ activity: 'Refactoring' as never })]);
    expect(issues.some((i) => i.severity === 'error')).toBe(true);
  });

  it('warns rather than errors on a long day', () => {
    const issues = validateEntries([entry({ minutes: 11 * 60 })]);
    expect(issues.every((i) => i.severity === 'warning')).toBe(true);
    expect(issues.some((i) => /sanity limit/.test(i.message))).toBe(true);
  });

  it('catches a double-log as overlapping ranges', () => {
    const issues = validateEntries([
      entry(),
      entry({ activity: 'Project Management', ranges: [{ startMin: 600, endMin: 700 }] }),
    ]);
    expect(issues.some((i) => /overlap/.test(i.message))).toBe(true);
  });

  it('warns when a push would blow the contract ceiling', () => {
    const issues = validateEntries([entry({ minutes: 300 })], { contractHoursRemaining: 2 });
    expect(issues.some((i) => /contract/.test(i.message))).toBe(true);
  });

  it('flags off-grid durations', () => {
    const issues = validateEntries([entry({ minutes: 37 })]);
    expect(issues.some((i) => /multiple of 15/.test(i.message))).toBe(true);
  });
});

describe('resolveActivity', () => {
  it('accepts shorthands and unique prefixes', () => {
    expect(resolveActivity('dev')).toBe('Development');
    expect(resolveActivity('QA')).toBe('Testing/QA');
    expect(resolveActivity('wire')).toBe('Wireframes');
    expect(resolveActivity('data model')).toBe('Data model');
  });

  it('refuses to guess on ambiguity or nonsense', () => {
    expect(resolveActivity('D')).toBeNull();
    expect(resolveActivity('gardening')).toBeNull();
    expect(resolveActivity('')).toBeNull();
  });
});

const watchedProjects = [
  { key: 'north10', name: 'North10AI', sheetTab: 'North10AI', repoPaths: ['/home/mili/Projects/NorthAI'] },
  {
    key: 'lp',
    name: 'LP Internal AI',
    sheetTab: 'LP Internal AI',
    repoPaths: ['/home/mili/Projects/lp-internal-ai-v1'],
  },
];

describe('projectForPath', () => {
  it('maps watched repos to their tabs', () => {
    expect(projectForPath('/home/mili/Projects/NorthAI/apps/hq/page.tsx', watchedProjects)?.sheetTab).toBe(
      'North10AI',
    );
    expect(
      projectForPath('/home/mili/Projects/lp-internal-ai-v1/packages/db', watchedProjects)?.sheetTab,
    ).toBe('LP Internal AI');
  });

  it('returns null outside a watched repo rather than guessing a project', () => {
    expect(projectForPath('/home/mili/Projects/BESMTools', watchedProjects)).toBeNull();
  });

  it('returns null with an empty registry, the config-free default', () => {
    expect(projectForPath('/home/mili/Projects/NorthAI/apps/hq/page.tsx')).toBeNull();
  });
});

describe('topLevelProjects', () => {
  it('drops sub-projects that share a parent\'s tab', () => {
    const projects = [
      { key: 'ops', name: 'Internal Operations', sheetTab: 'Inc Ops', repoPaths: [] },
      { key: 'nixos', name: 'NixOS Fleet', sheetTab: 'Inc Ops', repoPaths: ['/a'], parent: 'ops' },
      { key: 'lpcli', name: 'LPCLI', sheetTab: 'Inc Ops', repoPaths: ['/b'], parent: 'ops' },
      ...watchedProjects,
    ];
    expect(topLevelProjects(projects).map((p) => p.key)).toEqual(['ops', 'north10', 'lp']);
  });

  it('prefers the longest matching prefix when repos nest', () => {
    const projects = [
      { key: 'outer', name: 'Outer', sheetTab: 'Outer', repoPaths: ['/a'] },
      { key: 'inner', name: 'Inner', sheetTab: 'Inner', repoPaths: ['/a/b'] },
    ];
    expect(projectForPath('/a/b/c.ts', projects)?.key).toBe('inner');
  });
});
