# Using it from Claude

The MCP server exposes the same operations as the CLI over stdio, so you can log time
conversationally instead of switching to a terminal — and so Claude working in either repo can
record its own time as it goes.

## Register it

### Claude Code

Per-project, from inside whichever repo you want it available in:

```bash
claude mcp add hours -- pnpm --dir /home/mili/Projects/hours mcp
```

Or globally, for every session on this machine:

```bash
claude mcp add --scope user hours -- pnpm --dir /home/mili/Projects/hours mcp
```

Verify with `claude mcp list`, then `/mcp` inside a session.

### OpenCode

OpenCode has no add command — the server goes in the `mcp` block of
`~/.config/opencode/opencode.json`:

```json
"hours": {
  "type": "local",
  "command": ["pnpm", "--dir", "/home/mili/Projects/hours", "mcp"],
  "enabled": true
}
```

`--dir` is what makes both registrations work from any session: pnpm runs the root `mcp`
script with the repo as its working directory, so `--env-file-if-exists=.env` finds
`hours/.env` no matter where the client was launched from. The store and the project
registry are located from the source file's own path, so they are cwd-independent either way.

## Concurrent agents

Both clients launch their own server process, the CLI is a third, and the collector daemon is
a fourth. They share one SQLite file, so a timer started in OpenCode is the same timer
`hours status` sees — not a second one. Timers are scoped per project: `start_timer lp` and
`start_timer north10` run side by side, while a second start on `lp` replaces the first.

That sharing is enforced, not assumed:

- **At most one open timer per project** is a unique index on `Timer.openKey`, not an
  if-statement. The open timer's row carries its project key in `openKey`, so a different
  project's timer never collides. Eight processes starting a timer on the same project at
  the same instant serialize into a replacement chain and leave exactly one running.
- **Stopping is a conditional update** on `stoppedAt: null`. Eight simultaneous stops produce
  one `StoppedTimer` and seven "no timer running" — so the same stretch of the day can never
  become two entries.
- **Pushing takes a lease** on each entry (`Entry.pushLeaseAt`/`pushLeaseBy`) between the
  confirmation and the append. Two agents pushing the same approved batch cannot both append
  it; the loser reports the entries as held and skips them. A lease older than ten minutes is
  treated as abandoned, so a crashed push does not wedge the entries.
- **Writes retry with jittered backoff** (`withBusyRetry`). SQLite's own busy handler does not
  cover a read-then-write transaction upgrading its lock, which is the shape of nearly every
  mutation here — without the retry, 3 of 6 concurrent processes failed outright with
  "database is locked".

The store is in WAL mode so readers never block behind a writer. A fifth process reads
without writing: the openproject-mcp server's hours-ledger tap (when enabled) opens the file
read-only and queries `Task`/`Entry` for its `hoursLedger` results — best-effort, safe while
the daemon writes, and absent on any failure. None of this makes two agents pushing
simultaneously *sensible* — it makes it safe.

Because the server reads `HOURS_PERSON` and the credentials from `hours/.env`, that file must
be filled in before `log_time` or `push_to_sheet` will work — the server starts fine without
it, but those tools return an explanatory error rather than guessing your name.

## Tools

| Tool | Writes | What |
|---|---|---|
| `list_projects` | — | Registry, watched repos, hours pushed |
| `list_activities` | — | The fixed activity taxonomy: every acceptable value, what each is for, shorthands |
| `get_day` | — | Entries for a day, totals, validation warnings, timer state |
| `sheet_summary` | — | What the spreadsheet tab already says |
| `task_hours` | local | Whether a task has hours — OpenProject's side and the local sheet's, reported separately, never summed |
| `log_time` | local | Record time already spent as a draft; taskId attaches it to an OpenProject work package |
| `start_timer` | local | Begin timing; taskId attaches the result to an OpenProject work package |
| `stop_timer` | local | Stop and turn elapsed time into a draft |
| `timer_status` | — | Which timers are running, one line each |
| `reconstruct_day` | local | Sweep signals, draft the day, explain the reasoning |
| `edit_entry` | local | Set/fix an entry's note, activity, minutes or taskId before it is pushed |
| `approve_day` | local | Mark drafts approved |
| `push_to_sheet` | **shared sheet** | Append approved entries to their tab |

`project` can be omitted on most tools if you pass `cwd` — the project is resolved from the
directory through the registry, so a session in `~/Projects/NorthAI` needs no explicit key.

## Activities

The `activity` parameter on `log_time`, `start_timer`, `stop_timer`, and `edit_entry` is
**not free text** — it is the fixed value for the sheet's Activity/Category column, which
the pivot tables on every tab pivot on. (The tabs disagree on the header — "Activity" on
some, "Category" on others — but it is one column with one value set.)

- The full taxonomy with guidance lives behind `list_activities` — call it whenever no
  activity seems to fit, instead of inventing a label. Unknown labels are refused with an
  error that repeats the full list.
- Shorthands resolve too: `dev`, `qa`, `wire`, `db`, `docs`, … — and any unique prefix.
- A free-form what-did-you-do goes in the `note` parameter, never `activity`. It lands in
  the sheet's Notes column after the clock range.

`hours activities` on the CLI prints the same taxonomy.

## The push guard

`push_to_sheet` takes a required `confirm` boolean. With `confirm: false` it reads the tab,
builds the exact rows, reports any duplicate it found, and writes nothing. Only
`confirm: true` appends.

This is the one operation here that changes something other people see, and there is no
terminal to prompt at, so the confirmation has to be part of the call. Ask for a preview
first; the output is the literal cells that would land in the sheet.

## Things worth saying out loud

- "What did I do today?" → `get_day`
- "Reconstruct today and show me the reasoning" → `reconstruct_day`
- "Log the last 90 minutes as data model work on LP" → `log_time`
- "Log 45m of data model work on task #136" → `log_time` with `taskId`
- "How many hours does the North10AI tab have for me?" → `sheet_summary`
- "Does task #136 already have hours on it?" → `task_hours`
- "Approve today and show me what would go to the sheet" → `approve_day`, then
  `push_to_sheet` with `confirm: false`
- "Add a note to that draft" → `edit_entry` with `note` — one or two sentences of what
  was actually done; it lands in the sheet's Notes column after the clock range
