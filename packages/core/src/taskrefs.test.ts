import { describe, expect, it } from 'vitest';
import { agreeOnTask, parseTaskRefs, signalTaskRef, taskRefFromBranch } from './taskrefs.js';

describe('parseTaskRefs', () => {
  it('finds a bare hash ref', () => {
    expect(parseTaskRefs('#136')).toEqual(['136']);
  });

  it('finds multiple hash refs in order', () => {
    expect(parseTaskRefs('#136 then #137')).toEqual(['136', '137']);
  });

  it('finds a hash ref in the middle of a sentence', () => {
    expect(parseTaskRefs('fixed #136 in the merge')).toEqual(['136']);
    expect(parseTaskRefs('see #136, then the docs')).toEqual(['136']);
  });

  it.each(['closes', 'fixes', 'refs', 'resolves'])('finds "%s" with a hash', (kw) => {
    expect(parseTaskRefs(`${kw} #136`)).toEqual(['136']);
  });

  it.each(['closes', 'fixes', 'refs', 'resolves'])('finds "%s" without a hash', (kw) => {
    expect(parseTaskRefs(`${kw} 136`)).toEqual(['136']);
  });

  it('is case-insensitive on the keyword', () => {
    expect(parseTaskRefs('FIXES 136')).toEqual(['136']);
    expect(parseTaskRefs('Closes #136')).toEqual(['136']);
  });

  it('dedupes while preserving first-seen order', () => {
    expect(parseTaskRefs('closes #136 and fixes 136')).toEqual(['136']);
    expect(parseTaskRefs('#137 closes #136')).toEqual(['137', '136']);
  });

  it('does not treat a bare verb as a ref', () => {
    expect(parseTaskRefs('fix 136')).toEqual([]);
  });

  it('returns [] for text without refs and for empty text', () => {
    expect(parseTaskRefs('just some work')).toEqual([]);
    expect(parseTaskRefs('')).toEqual([]);
  });
});

describe('taskRefFromBranch', () => {
  it('reads the raw branch form', () => {
    expect(taskRefFromBranch('136-matcher')).toBe('136');
  });

  it.each(['feature', 'fix', 'hotfix', 'chore', 'release'])('strips the "%s/" prefix', (prefix) => {
    expect(taskRefFromBranch(`${prefix}/136-matcher`)).toBe('136');
  });

  it('handles underscore and slash separators', () => {
    expect(taskRefFromBranch('136_foo')).toBe('136');
    expect(taskRefFromBranch('136/foo')).toBe('136');
  });

  it('handles the git_branch signal subject form', () => {
    expect(taskRefFromBranch('switched to 136-matcher')).toBe('136');
    expect(taskRefFromBranch('switched to feature/136-matcher')).toBe('136');
  });

  it('refuses a date-stamped branch that looks like a year', () => {
    // 2026 is not task 2026 — it is a date prefix ("2026-08-13"), and
    // attributing it would invent a work package that does not exist.
    expect(taskRefFromBranch('2026-08-13')).toBeNull();
    expect(taskRefFromBranch('switched to 2026-08-13')).toBeNull();
  });

  it('returns null for names without a leading task number', () => {
    expect(taskRefFromBranch('v2.0')).toBeNull();
    expect(taskRefFromBranch('master')).toBeNull();
    expect(taskRefFromBranch('main')).toBeNull();
    expect(taskRefFromBranch('')).toBeNull();
  });
});

describe('signalTaskRef', () => {
  it('parses git_commit subjects', () => {
    expect(signalTaskRef({ kind: 'git_commit', subject: 'fix #136' })).toBe('136');
    expect(signalTaskRef({ kind: 'git_commit', subject: 'refs 136' })).toBe('136');
    expect(signalTaskRef({ kind: 'git_commit', subject: 'no refs' })).toBeNull();
  });

  it('takes only the first ref of a multi-task subject', () => {
    expect(signalTaskRef({ kind: 'git_commit', subject: 'closes #136 and #137' })).toBe('136');
  });

  it('parses git_branch subjects', () => {
    expect(signalTaskRef({ kind: 'git_branch', subject: 'switched to 136-matcher' })).toBe('136');
    expect(signalTaskRef({ kind: 'git_branch', subject: 'switched to main' })).toBeNull();
  });

  it('parses claude_session subjects, including empty ones', () => {
    expect(signalTaskRef({ kind: 'claude_session', subject: 'worked on #136' })).toBe('136');
    expect(signalTaskRef({ kind: 'claude_session', subject: '' })).toBeNull();
  });

  it('returns null for kinds that never carry refs', () => {
    expect(signalTaskRef({ kind: 'file_edit', subject: '#136' })).toBeNull();
    expect(signalTaskRef({ kind: 'calendar' })).toBeNull();
  });

  it('returns null when the subject is absent', () => {
    expect(signalTaskRef({ kind: 'git_commit' })).toBeNull();
  });
});

describe('agreeOnTask', () => {
  it('agrees on a single ref', () => {
    expect(agreeOnTask(['136'])).toBe('136');
  });

  it('agrees when every signal names the same task', () => {
    expect(agreeOnTask(['136', '136', null])).toBe('136');
  });

  it('disagrees when signals name different tasks', () => {
    expect(agreeOnTask(['136', '137'])).toBeNull();
  });

  it('disagrees when nothing is named', () => {
    expect(agreeOnTask([null, null])).toBeNull();
    expect(agreeOnTask([])).toBeNull();
  });

  it('falls back to the one named task when the rest are silent', () => {
    expect(agreeOnTask([null, '136', null])).toBe('136');
  });
});
