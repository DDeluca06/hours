// ---------------------------------------------------------------------------
// Note collection for the review-and-approve step.
//
// The sheet's Notes column carries the clock range plus a short "what did you
// do?" description. Reconstructed entries get an auto-subject, but manual and
// inferred entries can still end up note-less; the approve step is where a
// person's memory of the day is freshest, so that is where the tool asks.
//
// The ask is injected so the same walk serves the interactive CLI and any
// future non-interactive caller: skip entries that already have a note or are
// already in the sheet.
// ---------------------------------------------------------------------------

export interface NoteCandidate {
  id: string;
  description?: string;
  status: string;
}

/** An entry is worth asking about when it has no note and is not already pushed. */
export function needsNote(e: NoteCandidate): boolean {
  return !e.description && e.status !== 'pushed';
}

export interface NotePatch {
  id: string;
  description: string;
}

/**
 * Walk entries, asking for a note on each that needs one.
 *
 * `ask` returns the raw answer; empty answers are skipped so Enter means
 * "no note". Returns the patches to apply — the caller persists them, keeping
 * this module I/O-free.
 */
export async function collectNotes<T extends NoteCandidate>(
  entries: readonly T[],
  ask: (e: T) => Promise<string | undefined>,
): Promise<NotePatch[]> {
  const patches: NotePatch[] = [];
  for (const e of entries) {
    if (!needsNote(e)) continue;
    const answer = await ask(e);
    const note = answer?.trim();
    if (note) patches.push({ id: e.id, description: note });
  }
  return patches;
}
