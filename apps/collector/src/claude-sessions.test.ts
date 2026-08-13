// Transcript reading, against a synthetic ~/.claude/projects tree. The shapes
// here are copied from real transcripts (Claude Code 2.1.x): tool results arrive
// as `type: "user"` with a `toolUseResult`, which is why prompt detection cannot
// just test `type`.

import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import type { ProjectDef } from '@hours/core';
import { collectSessionSignals, summarizePrompt } from './claude-sessions.js';

const PROJECTS: ProjectDef[] = [
  { key: 'north10', name: 'North10AI', sheetTab: 'North10AI', repoPaths: ['/repos/north'] },
];

/** ISO stamp on 2026-08-12, local time. */
function stamp(time: string): string {
  const [h, m, s] = time.split(':').map(Number);
  return new Date(2026, 7, 12, h ?? 0, m ?? 0, s ?? 0).toISOString();
}

function prompt(uuid: string, time: string, text: string, cwd = '/repos/north'): string {
  return JSON.stringify({
    type: 'user',
    uuid,
    sessionId: 'sess1',
    timestamp: stamp(time),
    cwd,
    promptSource: 'typed',
    message: { role: 'user', content: text },
  });
}

function assistant(time: string): string {
  return JSON.stringify({
    type: 'assistant',
    uuid: `a-${time}`,
    sessionId: 'sess1',
    timestamp: stamp(time),
    cwd: '/repos/north',
    message: { role: 'assistant', content: [{ text: 'working' }] },
  });
}

function toolResult(time: string): string {
  return JSON.stringify({
    type: 'user',
    uuid: `t-${time}`,
    sessionId: 'sess1',
    timestamp: stamp(time),
    cwd: '/repos/north',
    toolUseResult: { stdout: 'ok' },
    message: { role: 'user', content: '<tool-result>ok</tool-result>' },
  });
}

let root: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'hours-claude-'));
  const dir = join(root, '-repos-north');
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, 'sess1.jsonl'),
    [
      prompt('u1', '10:00:00', 'fix the retry loop'),
      assistant('10:00:30'),
      toolResult('10:01:00'),
      assistant('10:20:00'),
      toolResult('10:40:00'),
      assistant('10:44:00'),
      prompt('u2', '11:00:00', 'now write the test'),
      assistant('11:05:00'),
      'not json at all',
      '{"type":"assistant","timestamp":"broken',
    ].join('\n'),
    'utf-8',
  );
});

const since = new Date(2026, 7, 12, 0, 0, 0);

describe('collectSessionSignals', () => {
  it('emits one signal per prompt, not one per tool result', async () => {
    const signals = await collectSessionSignals({ since, projects: PROJECTS, root });
    expect(signals).toHaveLength(2);
    expect(signals.map((s) => s.sourceId)).toEqual(['claude:sess1:u1', 'claude:sess1:u2']);
  });

  it('spans a turn to the last harness line before the next prompt', async () => {
    const [first] = await collectSessionSignals({ since, projects: PROJECTS, root });
    // 10:00 → 10:44. Not 11:00: the 16 minutes between the last assistant line
    // and the next prompt are you reading the output, not the harness working.
    expect(first?.until?.getHours()).toBe(10);
    expect(first?.until?.getMinutes()).toBe(44);
  });

  it('closes the final turn at the end of the file', async () => {
    const signals = await collectSessionSignals({ since, projects: PROJECTS, root });
    expect(signals[1]?.until?.getHours()).toBe(11);
    expect(signals[1]?.until?.getMinutes()).toBe(5);
  });

  it('caps a span so a parked tool call cannot bill the afternoon', async () => {
    const signals = await collectSessionSignals({
      since,
      projects: PROJECTS,
      root,
      maxSpanMin: 10,
    });
    const spanMin = ((signals[0]?.until?.getTime() ?? 0) - (signals[0]?.at.getTime() ?? 0)) / 60_000;
    expect(spanMin).toBe(10);
  });

  it('attributes by cwd and keeps the prompt as the subject', async () => {
    const [first] = await collectSessionSignals({ since, projects: PROJECTS, root });
    expect(first?.projectKey).toBe('north10');
    expect(first?.subject).toBe('fix the retry loop');
  });

  it('survives a torn last line and non-JSON noise', async () => {
    // Asserted by the tests above returning at all — a transcript is appended to
    // while we read it, so a half-written line is the normal case, not a fault.
    const signals = await collectSessionSignals({ since, projects: PROJECTS, root });
    expect(signals.every((s) => !Number.isNaN(s.at.getTime()))).toBe(true);
  });

  it('drops prompts older than the window without misattributing their output', async () => {
    // `since` after both prompts: nothing is emitted, and in particular the
    // assistant lines do not get folded into some later turn.
    const signals = await collectSessionSignals({
      since: new Date(2026, 7, 12, 12, 0, 0),
      projects: PROJECTS,
      root,
    });
    expect(signals).toHaveLength(0);
  });

  it('returns nothing rather than throwing when there is no transcript root', async () => {
    const signals = await collectSessionSignals({
      since,
      projects: PROJECTS,
      root: join(root, 'nope'),
    });
    expect(signals).toEqual([]);
  });
});

describe('summarizePrompt', () => {
  it('drops harness blocks and slash commands, keeps real prose', () => {
    expect(summarizePrompt('<command-name>/clear</command-name>')).toBe('');
    expect(summarizePrompt('/loop 5m')).toBe('');
    expect(summarizePrompt('  fix the retry loop\nsecond line ')).toBe('fix the retry loop');
  });
});
