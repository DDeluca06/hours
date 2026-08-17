import { describe, expect, it } from 'vitest';
import {
  ACTIVITIES,
  ACTIVITY_GUIDE,
  ACTIVITY_SHORTHANDS,
  LEGACY_ACTIVITIES,
  activityListText,
  activityParamHint,
  activityParamText,
  canonicalActivity,
  resolveActivity,
} from './taxonomy.js';

describe('ACTIVITY_GUIDE', () => {
  it('describes every activity exactly once, without empty lines', () => {
    const keys = Object.keys(ACTIVITY_GUIDE);
    expect(keys).toEqual([...ACTIVITIES]);
    for (const a of ACTIVITIES) {
      expect(ACTIVITY_GUIDE[a].trim().length).toBeGreaterThan(0);
    }
  });
});

describe('ACTIVITY_SHORTHANDS', () => {
  it('is derived from the resolver: every listed shorthand resolves to its activity', () => {
    for (const a of ACTIVITIES) {
      for (const short of ACTIVITY_SHORTHANDS[a]) {
        expect(resolveActivity(short)).toBe(a);
      }
    }
  });

  it('never lists the full activity name as a shorthand', () => {
    for (const a of ACTIVITIES) {
      expect(ACTIVITY_SHORTHANDS[a]).not.toContain(a.toLowerCase());
    }
  });

  // The record's type says it is total. It used to be built only from the alias
  // table, so an activity with no alias had no key and activityListText — which
  // reads .length off it — threw a TypeError instead of reporting the error it
  // was called to report.
  it('has an entry for every activity, alias or not', () => {
    for (const a of ACTIVITIES) {
      expect(Array.isArray(ACTIVITY_SHORTHANDS[a]), `entry for ${a}`).toBe(true);
    }
    expect(() => activityListText()).not.toThrow();
  });

  it('does not advertise the retired activity names as choices', () => {
    const advertised = ACTIVITIES.flatMap((a) => ACTIVITY_SHORTHANDS[a]);
    for (const legacy of Object.keys(LEGACY_ACTIVITIES)) {
      expect(advertised).not.toContain(legacy);
    }
  });
});

describe('retired activities', () => {
  // Dropping these from ACTIVITIES without a remap turned every stored row that
  // carried one into a validation *error* — including already-approved rows,
  // which then could never be pushed.
  it('remaps a stored legacy activity to where its work lives now', () => {
    expect(canonicalActivity('Documentation')).toBe('Misc');
    expect(canonicalActivity('Deployment')).toBe('Misc');
    expect(canonicalActivity('Research/Learning')).toBe('Misc');
  });

  it('passes a current activity through untouched', () => {
    for (const a of ACTIVITIES) expect(canonicalActivity(a)).toBe(a);
  });

  it('still rejects an activity that is neither current nor retired', () => {
    // Silently laundering an unknown label into Misc would hide a real mistake.
    expect(canonicalActivity('Vibes')).toBeNull();
  });

  it('resolves the retired names and the shorthands the guide advertises', () => {
    for (const input of ['Documentation', 'deployment', 'research/learning']) {
      expect(resolveActivity(input)).toBe('Misc');
    }
    // ACTIVITY_GUIDE.Misc promises "docs, CI/infra, research included", and
    // guessFromSubject already maps docs:/ci:/build: there, so the resolver has
    // to agree with both.
    for (const input of ['docs', 'doc', 'deploy', 'ci', 'infra', 'research', 'learning']) {
      expect(resolveActivity(input), input).toBe('Misc');
    }
  });
});

describe('activityListText', () => {
  it('renders one indented line per activity, carrying its guidance', () => {
    const text = activityListText();
    const lines = text.split('\n');
    expect(lines).toHaveLength(ACTIVITIES.length);
    for (const a of ACTIVITIES) {
      const line = lines.find((l) => l.startsWith(`  ${a} `));
      expect(line, `line for ${a}`).toBeDefined();
      expect(line).toContain(ACTIVITY_GUIDE[a]);
    }
    // At least one line shows a shorthand, so agents learn "dev" resolves.
    const devLine = lines.find((l) => l.startsWith('  Development '));
    expect(devLine).toContain('dev');
  });
});

describe('activityParamText', () => {
  it('says activity is the fixed column value and points free text at note', () => {
    const text = activityParamText();
    expect(text).toContain('Activity/Category column');
    expect(text).toContain('"note" parameter');
    expect(text).toContain(activityListText());
  });
});

describe('activityParamHint', () => {
  // Six MCP parameters describe this field, so the long form shipped ~90 words
  // six times in every tools/list payload — the cost list_activities exists to
  // remove. What the trim must keep is the part agents get wrong.
  it('keeps the constraints but not the list', () => {
    const hint = activityParamHint();
    expect(hint).toContain('list_activities');
    expect(hint).toContain('"note"');
    expect(hint).toContain('OpenProject');
    expect(hint).not.toContain(activityListText());
    expect(hint.length).toBeLessThan(activityParamText().length / 2);
  });
});
