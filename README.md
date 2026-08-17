# hours

Tracks what you worked on, for which project, and how long — then appends it to the shared
Hours spreadsheet's `North10AI` and `LP Internal AI` tabs.

It stands on its own (own repo, own database, no dependency on either engagement's code) but
watches `~/Projects/NorthAI` and `~/Projects/lp-internal-ai-v1` for evidence of work, and
exposes an MCP server so Claude can log time from inside either one.

## The idea

You are in the office 9–3 and by 3 PM you cannot remember what went where. So the tool
collects evidence all day, drafts your timesheet from it, and makes you review the draft
before anything reaches a spreadsheet the whole team reads.

```
git commits ──────┐
branch moves ─────┤
Claude Code ──────┤
OpenCode ─────────┤
editor saves ─────┤
heartbeats ───────┴─►  signals  ──►  blocks  ──►  draft entries  ──►  approved  ──►  sheet
                   (append-only)   (inferred)      (you review)      (you confirm)
```

Commits say *what* you did and almost nothing about *how long*. The agent harnesses fill
that in: a turn is read as a measured span — when it started, when it finished — so a
45-minute autonomous run is 45 minutes rather than a guess. WakaTime heartbeats (the
editor extension, collected from a self-hosted Wakapi server) do the same for hands-on
editing: consecutive heartbeats are a measured stretch of typing. See
[docs/harnesses.md](docs/harnesses.md).

Four properties hold that pipeline together:

- **Signals are append-only and idempotent.** Every signal has a stable id, so collecting
  twice, restarting the daemon, or re-running reconstruction never double-counts.
- **Inferred time can never exceed wall-clock time.** Overlapping evidence is apportioned,
  not summed. See [docs/inference.md](docs/inference.md).
- **The local database is the source of truth**, not the sheet. The sheet is a publication
  target, written append-only, never updated or deleted.
- **Nothing is pushed without review.** `draft → approved → pushed`, one direction only. A
  pushed entry is immutable locally, because its row already exists in a shared document.

## Requirements

| | |
|---|---|
| Node | **≥ 22** — the CLI runs through `tsx` and relies on `--env-file-if-exists` |
| pnpm | **≥ 10** — this is a pnpm workspace; npm and yarn will not resolve the `workspace:` links |
| git | needed at runtime, not just to clone: the commit and branch signal sources shell out to it |
| OS | Linux and macOS. Paths like `~/.claude/projects` are resolved from `$HOME`; Windows is untested |

Nothing else is required to log and review time. Pushing to the sheet needs Google
credentials ([Credentials](#credentials)); the Wakapi and OpenProject sources are optional and
silent when unconfigured.

## Install

```bash
git clone git@github.com:DDeluca06/hours.git
cd hours
pnpm install
pnpm db:generate            # generate the Prisma client into packages/db/generated
pnpm db:push                # create ./hours.db from the schema
```

Run `prisma` commands **from the repo root** — that is where `prisma.config.ts` lives, and
Prisma 7 reads the connection URL from there rather than from the schema's `datasource` block.

### 1. Environment

```bash
cp .env.example .env
```

`HOURS_PERSON` — your name **exactly as it appears in the sheet's `Person` column** — is the
only variable needed to start logging. Everything else is either optional or only consulted at
push time, and a blank value counts as unset rather than as off, so a copied `.env.example`
never silently disables a collector.

`HOURS_SHEET_ID` is the long id in the shared spreadsheet's URL
(`docs.google.com/spreadsheets/d/<this part>/edit`). It is deliberately not committed.

### 2. Project registry

**Do this before your first `reconstruct`.** The built-in defaults in
`packages/core/src/projects.ts` point at the original author's checkout paths, so on any other
machine every signal lands as unattributed and the day looks empty for no visible reason.
Write your own:

```bash
cp hours.config.example.json hours.config.json
```

Then set `repoPaths` to where *you* cloned the watched repos, and `person` to the same value as
`HOURS_PERSON`. The file is gitignored — it holds your machine's paths, not shared
configuration. Full schema in [Configuration](#configuration).

### 3. Verify

```bash
pnpm hours projects     # the registry, as loaded — check the paths are yours
pnpm test               # 307 tests, no credentials or network needed
pnpm hours collect      # one sweep; prints a per-source signal count
```

`hours collect` lists only the sources that produced something, so the useful signal is a
source **missing** from that list on a day you know you worked — almost always a `repoPaths`
mismatch rather than a broken harness.

### 4. Optional sources

Both are env-only, because both take a secret — see [docs/harnesses.md](docs/harnesses.md) and
[docs/tasks.md](docs/tasks.md).

- **Wakapi** (`WAKAPI_URL`, `WAKAPI_API_KEY`) — a self-hosted WakaTime-compatible server the
  editor extension reports to. Denser and genuinely measured, where save history is neither.
  A URL set without a key is a warning rather than silence, because "tracking never started"
  is the failure this source exists to catch.
- **OpenProject** (`OPENPROJECT_URL`, `OPENPROJECT_API_KEY`, plus an
  `openproject.projects` key mapping in `hours.config.json`) — read-only task attribution.

## Daily use

```bash
# during the day — whichever fits, they all feed the same store
pnpm hours start lp dev                  # timer
pnpm hours stop                          # → draft entry
pnpm hours log 90 "data model" -p lp     # time you already spent
pnpm hours status                        # timer, today's entries, uncounted signals

# at 3 PM
pnpm hours reconstruct                   # collect signals, draft the day
pnpm hours review                        # see drafts and why the tool believes them
pnpm hours approve --day today           # asks for a brief note on each entry that has none
pnpm hours edit a1b2c3 --minutes 2h --activity dev --note "what you did"
pnpm hours push --dry-run                # exactly what would be appended
pnpm hours push                          # asks before writing
```

Durations: `90` `90m` `1.5h` `1:30` — a bare number is **minutes**.
Days: `today` `yesterday` `-2` `2026-08-12` `8/12`.

The rest, in full: `cancel` (drop a running timer without banking it), `drop` (delete a draft),
`unapprove` (approved back to draft — never `pushed`, by invariant), `collect` (one sweep),
`sheet` (what the spreadsheet already holds), `task` / `tasks` (OpenProject work packages and
their hours), `activities`, `projects`.

## The passive collector

Run it and forget it:

```bash
pnpm collect      # sweeps every 10 minutes
```

It only writes signals — no inference, no sheet access. If it dies, the worst outcome is that
`hours reconstruct` sees slightly sparser evidence, because a sweep re-reads history rather
than tailing it. To run it on login, see [docs/operations.md](docs/operations.md).

## From inside Claude

The MCP server lets you say "log the last 90 minutes as data model work on LP" in any Claude
session, and lets Claude working in either repo record its own time. Registration
instructions are in [docs/mcp.md](docs/mcp.md).

Tools: `list_projects` `list_activities` `get_day` `sheet_summary` `task_hours` `log_time`
`start_timer` `stop_timer` `timer_status` `reconstruct_day` `edit_entry` `approve_day`
`push_to_sheet`.

`push_to_sheet` requires an explicit `confirm: true`. Called with `confirm: false` it prints
the exact rows and writes nothing.

The Notes column holds the clock range plus a brief what-did-you-do description. Interactive
`hours approve` asks for one on every entry that has none; in the MCP, call `edit_entry` with
a `note` after `reconstruct_day` and before `approve_day`.

## Credentials

Two ways to authenticate, one of which must be configured to push:

**OAuth (recommended, self-service).** A Desktop-app OAuth client in any Google Cloud
project with the Sheets API enabled. Put its id and secret in `.env`, then authorize once:

```bash
pnpm sheets:auth     # opens a browser for one-time consent
```

The refresh token is stored at `GOOGLE_OAUTH_TOKEN_PATH` (default
`~/.config/hours/credentials.json`, mode 0600) and refreshed silently forever after. The
consenting Google account is the push principal — it must already be an Editor of the sheet.

**Service account (fallback).** `GOOGLE_SERVICE_ACCOUNT_JSON` is base64-encoded
service-account JSON — the same value and encoding `lp-internal-ai-v1` uses, so you can reuse
that one. **The service account's email must be shared into the spreadsheet as an Editor**;
read access is not enough, and the failure shows up as a 403 at push time.

Once credentials exist, run this before your first push:

```bash
pnpm sheets:probe
```

It prints every tab, which ones parse as timesheet tabs, the column layout discovered for
each, and the totals — so you can confirm the real tab titles and column variants rather than
trusting the defaults in the registry.

## Configuration

`hours.config.json` in the repo root overrides the project registry, the workday policy, and
which sources get read. Start from the committed template:

```bash
cp hours.config.example.json hours.config.json
```

```json
{
  "person": "Demitri",
  "workday": { "startMin": 540, "endMin": 900, "gapMin": 25 },
  "projects": [
    {
      "key": "north10",
      "name": "North10AI",
      "sheetTab": "North10AI",
      "repoPaths": ["/absolute/path/to/NorthAI"],
      "contractHours": 533
    }
  ]
}
```

The file is **gitignored**, and the split is load-bearing in both directions: secrets stay in
`.env` and are never read out of the JSON even if one is pasted there, and project definitions
stay out of the environment. `HOURS_CONFIG_FILE` points the loader at one exact file instead of
the repo root — that is how the tests supply fixtures without touching your registry.

Adding a third engagement needs no code change — add it here.

Which harnesses and editors get read is configured the same way, under a `harnesses` key —
all of them by default, with environment overrides winning over the file. See
[docs/harnesses.md](docs/harnesses.md).

## Layout

| Path | What |
|---|---|
| `packages/core` | Domain logic: durations, taxonomy, inference, validation. No I/O. |
| `packages/config` | Env + `hours.config.json` loading. |
| `packages/db` | Prisma schema and repositories. SQLite by default. |
| `connectors/google-sheets` | Tab layout discovery, reads, and the guarded append. |
| `connectors/openproject` | Read-only work-package and logged-time fetches for task attribution. |
| `apps/collector` | Signal sources (git, Claude Code, OpenCode, editor history, Wakapi) and the sweep daemon. |
| `apps/cli` | The `hours` command. |
| `apps/mcp-server` | MCP tools for Claude. |

## Commands

```bash
pnpm test          # 307 tests
pnpm -r typecheck
pnpm lint
pnpm db:studio     # browse the local store
```

## Relationship to lp-internal-ai-v1

That repo already reads this spreadsheet: `connectors/google-sheets/src/sync-hours.ts` pulls
both tabs into an `hour_logs` table for reporting. This project deliberately does not
duplicate that — it owns **capture and write**, that one owns **read for analytics**. They can
share a database if you want both in one place: set `DATABASE_URL` to its Postgres and switch
the provider in `packages/db/prisma/schema.prisma`.

## Relationship to openproject-mcp

`~/Projects/OpenProject` (openproject-mcp) is a separate MCP server over the OpenProject API.
When enabled (`OPENPROJECT_HOURS_DB`; it defaults to `./hours.db`, an empty value disables
it), its `op_get_work_package` and `op_log_time` results carry `hoursLedger` — this repo's
draft/approved/pushed minutes for the task, read from the `Task` and `Entry` tables. The tap
opens the file read-only with short prepared queries, so it is safe alongside the CLI, MCP
server, and collector daemon, and it degrades to absent on any failure — it never blocks or
dedupes a write, and this repo never depends on it.

The interaction runs both ways, but neither side depends on the other:

- openproject-mcp reads this store read-only; this repo never reads openproject-mcp — it
  talks to the OpenProject API itself when `OPENPROJECT_URL`/`OPENPROJECT_API_KEY` are set.
- `task_hours` is the union view of both ledgers, and a push whose entry carries a `taskId`
  write-throughs the same minutes to the OpenProject task after the sheet append succeeds.
- The two ledgers describe the same work, so they are never summed — see
  [docs/tasks.md](docs/tasks.md) for the detection rules.

Either tool is fully functional with the other absent, disabled, or unreachable.
