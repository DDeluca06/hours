import { describe, expect, it } from 'vitest';
import { collectNotes, needsNote, type NoteCandidate } from './notes.js';

function entry(over: Partial<NoteCandidate> = {}): NoteCandidate {
  return { id: 'abc', status: 'draft', ...over };
}

describe('needsNote', () => {
  it('asks for drafts and approved entries with no description', () => {
    expect(needsNote(entry({ status: 'draft' }))).toBe(true);
    expect(needsNote(entry({ status: 'approved' }))).toBe(true);
  });

  it('skips entries that already have a note', () => {
    expect(needsNote(entry({ description: 'did the thing' }))).toBe(false);
  });

  it('skips pushed entries — the sheet row already exists', () => {
    expect(needsNote(entry({ status: 'pushed' }))).toBe(false);
  });
});

describe('collectNotes', () => {
  it('asks only where needed and applies trimmed non-empty answers', async () => {
    const asked: string[] = [];
    const patches = await collectNotes(
      [
        entry({ id: 'a', description: 'has a note' }),
        entry({ id: 'b' }),
        entry({ id: 'c', status: 'pushed' }),
        entry({ id: 'd' }),
      ],
      async (e) => {
        asked.push(e.id);
        if (e.id === 'b') return '  did the thing  ';
        if (e.id === 'd') return '   ';
        return undefined;
      },
    );
    expect(asked).toEqual(['b', 'd']);
    expect(patches).toEqual([{ id: 'b', description: 'did the thing' }]);
  });
});
