# Harnesses and editors as evidence

Commits are sparse and deliberate; they say *what* you did and almost nothing about
*how long*. This is the other half of the evidence: the agent harnesses and editors
you work through, which timestamp their own activity continuously and — in two cases
— record how long a piece of work actually took.

Read [inference.md](inference.md) first. This document only covers where the signals
come from and which of them carry measured time.

## Point signals versus measured spans

Every signal has an `at`. Some also have an `until`, and that distinction drives
the inference:

| | Point signal | Measured span |
|---|---|---|
| Example | commit, branch checkout, file save | agent turn |
| What it proves | you were working *at* that moment | you were working *for* that stretch |
| Block start | first signal minus a 20-minute lead-in | the signal's own start, no lead-in |
| Idle-gap measured from | the signal's instant | the span's end |
| Weight in apportionment | 1–4 by kind | at least 2 |

The lead-in exists because a commit at 10:45 is a *trailing edge* — it records
work that already happened. A measured span needs no such guess, and adding one
on top of a known start would invent time, so a run that opens with a span does
not get one.

Spans change nothing downstream. Overlapping blocks are still apportioned, never
summed; the workday clamp still applies; a span crossing local midnight is clipped
at 23:59 so the minutes after it belong to the next day's pass. **Inferred time
still cannot exceed wall-clock time** — that is invariant 1, and
`packages/core/src/spans.test.ts` re-asserts it against spans specifically rather
than trusting the point-signal proof.

## Sources

### Claude Code — `apps/collector/src/claude-sessions.ts`

Transcripts at `~/.claude/projects/<slug>/<sessionId>.jsonl`, one JSON object per
line. The harness writes no duration field anywhere, but it timestamps every line,
so a turn's real end is the last line written before the next prompt: assistant
output, tool results, subagent chatter.

Two things worth knowing:

- **Only genuine prompts become signals.** Tool results arrive as `type: "user"`
  too. Counting them — which an earlier version did — over-weighted tool-heavy
  work by more than an order of magnitude: a real day here is ~644 tool results
  against ~24 typed prompts, so one agent-heavy afternoon outvoted every commit in
  the apportionment. One signal per prompt, spanning the turn, says the same thing
  without the distortion.
- **The span ends at the last harness line, not at the next prompt.** The minutes
  between the model finishing and you typing again are you reading the output, and
  they are not billed.

### OpenCode — `apps/collector/src/opencode-sessions.ts`

One JSON file per message under
`~/.local/share/opencode/storage/message/<sessionID>/<messageID>.json`. An
assistant message carries both `time.created` and `time.completed`, which is a
measured turn duration handed over directly — the best evidence of any source here,
Claude Code included, where the end has to be reconstructed.

Attribution comes from the message's `path.cwd`, falling back to the session's
`directory`. Sessions are filtered on `time.updated` before their message
directory is opened, so a sweep is a handful of small reads rather than one per
message ever written.

**Foreign home directories.** This storage is routinely synced or restored between
machines and its paths are absolute, so `localizeHome` rewrites another machine's
home segment onto this one. Without it, every restored session lands unattributed.
The project-relative part still has to match a registered repo path, so the failure
mode is a missing attribution, not a wrong one — and review catches the rest. Turn
it off with `HOURS_OPENCODE_REMAP_HOME=0`.

### Editors — `apps/collector/src/editor-history.ts`

VS Code and every fork of it (VSCodium, Cursor, Windsurf, …) keep a local history
of saves at `<userDir>/History/<hash>/entries.json`:

```json
{ "version": 1, "resource": "file:///abs/path.ts",
  "entries": [ { "id": "kOK2.ts", "timestamp": 1775756940656 } ] }
```

One entry per save, timestamped, with the file it belongs to — the `file_edit`
signal kind that `KIND_WEIGHT` always had a slot for and nothing was emitting. It
covers what the other sources miss entirely: editing config, writing docs, a long
stretch of manual edits that ends in one commit at 3 PM.

A save is a trailing edge like a commit, so these are point signals and the lead-in
applies.

**This source is lossy and has to be treated that way.** Local history is capped by
`workbench.localHistory.maxFileEntries`, skips anything matching
`workbench.localHistory.exclude`, and is absent entirely if the user disabled it.
Good evidence that you *were* working; never evidence that you were not.

Resources under any scheme but `file:` are dropped — the editor stores its own
settings as `vscode-userdata:` in the same directory, and that is not project work.

## Growing a span after the fact

A turn's end is not knowable while the turn is running. The sweep at 10:20 sees a
prompt at 10:19 with one assistant line after it; only the sweep at 10:30 can say
the turn ran until 10:26.

`recordSignals` never updates an existing row, by design — the first sighting's
`at` is the truthful one. `recordSignalSpans` is the one narrow exception, and it
runs every sweep:

- the span only ever moves **forward**, so the pass is monotonic and idempotent —
  no sequence of sweeps can shrink a block or oscillate it;
- it only touches **unconsumed** signals. A consumed signal already justifies a
  created entry, and growing its span would leave that entry's duration
  disagreeing with its own evidence. Entries change through review, not here.

`hours collect` reports these separately as `measured spans extended`, because
nothing new was observed — an existing observation got longer.

## Configuration

All three sources are on by default. `hours.config.json`:

```json
{
  "harnesses": {
    "claudeCode": true,
    "openCode": true,
    "editors": true,
    "maxSpanMin": 120,
    "remapOpenCodeHome": true,
    "editorHistoryRoots": ["/opt/vscodium/User/History"]
  }
}
```

Environment overrides win over the file: `HOURS_HARNESS_CLAUDE`,
`HOURS_HARNESS_OPENCODE`, `HOURS_HARNESS_EDITORS` (`0`/`false` to disable),
`HOURS_MAX_SPAN_MIN`, `HOURS_OPENCODE_REMAP_HOME`. Blank counts as unset, not as
off — a copied `.env.example` must not silently disable collection.

`maxSpanMin` bounds the one case where a measured span lies: a tool call parked on
a permission prompt while you go to lunch is stamped as one continuous turn.

## Adding another harness

The seam is deliberately narrow. A new source is a function in
`apps/collector/src/` that returns `Signal[]`, and:

1. **Stable `sourceId`s.** Re-collecting must be a no-op (invariant 2). Prefer the
   harness's own ids over anything positional — `editor:<dirHash>:<entryId>`
   survives a rename and a prune.
2. **A weight in `KIND_WEIGHT`** if it introduces a new `SignalKind`, in
   `packages/core/src/blocks.ts`.
3. **`until` only when the harness genuinely clocked it.** Guessing a duration and
   presenting it as measured defeats the whole distinction — leave it absent and
   let the lead-in do its job.
4. **Unattributed rather than guessed.** A path outside every watched repo is real
   work whose project only the operator can name. Never fall back to "probably the
   project I saw last".
5. **A missing store is empty, not an error.** Each source is wrapped
   independently in `sweep`, so a machine with only one of these installed is the
   normal case.
6. **Cheap when there is nothing new.** Filter on directory or file mtime before
   opening anything — these stores hold months of history and the daemon sweeps
   every 10 minutes.

### What is not collected, and why

The harness's own aggregate numbers — Claude Code's total wall and API duration
per session, token counts, cost — are deliberately unused. Wall time includes
reading email with the session open, API time counts only the model thinking and
so undercounts your review, and both are per-session rather than per-project, so a
session that moves between two repos has one clock covering both. The per-line
timestamps we do read are attributable, which those numbers are not.
