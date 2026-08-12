# Using it from Claude

The MCP server exposes the same operations as the CLI over stdio, so you can log time
conversationally instead of switching to a terminal — and so Claude working in either repo can
record its own time as it goes.

## Register it

Per-project, from inside whichever repo you want it available in:

```bash
claude mcp add hours -- pnpm --dir /home/mili/Projects/hours mcp
```

Or globally, for every session on this machine:

```bash
claude mcp add --scope user hours -- pnpm --dir /home/mili/Projects/hours mcp
```

Verify with `claude mcp list`, then `/mcp` inside a session.

Because the server reads `HOURS_PERSON` and the credentials from `hours/.env`, that file must
be filled in before `log_time` or `push_to_sheet` will work — the server starts fine without
it, but those tools return an explanatory error rather than guessing your name.

## Tools

| Tool | Writes | What |
|---|---|---|
| `list_projects` | — | Registry, watched repos, hours pushed, valid activities |
| `get_day` | — | Entries for a day, totals, validation warnings, timer state |
| `sheet_summary` | — | What the spreadsheet tab already says |
| `log_time` | local | Record time already spent as a draft |
| `start_timer` | local | Begin timing |
| `stop_timer` | local | Stop and turn elapsed time into a draft |
| `timer_status` | — | Whether a timer is running |
| `reconstruct_day` | local | Sweep signals, draft the day, explain the reasoning |
| `approve_day` | local | Mark drafts approved |
| `push_to_sheet` | **shared sheet** | Append approved entries to their tab |

`project` can be omitted on most tools if you pass `cwd` — the project is resolved from the
directory through the registry, so a session in `~/Projects/NorthAI` needs no explicit key.

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
- "How many hours does the North10AI tab have for me?" → `sheet_summary`
- "Approve today and show me what would go to the sheet" → `approve_day`, then
  `push_to_sheet` with `confirm: false`
