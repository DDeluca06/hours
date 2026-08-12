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
git commits ─┐
branch moves ─┤
Claude sessions ─┴─►  signals  ──►  blocks  ──►  draft entries  ──►  approved  ──►  sheet
              (append-only)   (inferred)      (you review)      (you confirm)
```

Four properties hold that pipeline together:

- **Signals are append-only and idempotent.** Every signal has a stable id, so collecting
  twice, restarting the daemon, or re-running reconstruction never double-counts.
- **Inferred time can never exceed wall-clock time.** Overlapping evidence is apportioned,
  not summed. See [docs/inference.md](docs/inference.md).
- **The local database is the source of truth**, not the sheet. The sheet is a publication
  target, written append-only, never updated or deleted.
- **Nothing is pushed without review.** `draft → approved → pushed`, one direction only. A
  pushed entry is immutable locally, because its row already exists in a shared document.

## Setup

```bash
pnpm install
pnpm db:generate            # generate the Prisma client
pnpm db:push                # create ./hours.db
cp .env.example .env        # then fill in HOURS_PERSON at minimum
```

`HOURS_PERSON` is the only thing needed to start logging. Pushing additionally needs
`HOURS_SHEET_ID` and `GOOGLE_SERVICE_ACCOUNT_JSON` — see [Credentials](#credentials).

Confirm the registry looks right:

```bash
pnpm hours projects
```

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
pnpm hours edit a1b2c3 --minutes 2h --activity dev
pnpm hours approve --day today
pnpm hours push --dry-run                # exactly what would be appended
pnpm hours push                          # asks before writing
```

Durations: `90` `90m` `1.5h` `1:30` — a bare number is **minutes**.
Days: `today` `yesterday` `-2` `2026-08-12` `8/12`.

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

Tools: `list_projects` `get_day` `sheet_summary` `log_time` `start_timer` `stop_timer`
`timer_status` `reconstruct_day` `approve_day` `push_to_sheet`.

`push_to_sheet` requires an explicit `confirm: true`. Called with `confirm: false` it prints
the exact rows and writes nothing.

## Credentials

`GOOGLE_SERVICE_ACCOUNT_JSON` is base64-encoded service-account JSON — the same value and
encoding `lp-internal-ai-v1` already uses, so you can reuse that one. **The service account's
email must be shared into the spreadsheet as an Editor**; read access is not enough, and the
failure shows up as a 403 at push time.

Once credentials exist, run this before your first push:

```bash
pnpm sheets:probe
```

It prints every tab, which ones parse as timesheet tabs, the column layout discovered for
each, and the totals — so you can confirm the real tab titles and column variants rather than
trusting the defaults in the registry.

## Configuration

`hours.config.json` in the repo root overrides the project registry and workday policy.
Secrets stay in `.env`; project definitions stay out of it.

```json
{
  "person": "Demitri",
  "workday": { "startMin": 540, "endMin": 900, "gapMin": 25 },
  "projects": [
    {
      "key": "north10",
      "name": "North10AI",
      "sheetTab": "North10AI",
      "repoPaths": ["/home/mili/Projects/NorthAI"],
      "contractHours": 533
    }
  ]
}
```

Adding a third engagement needs no code change — add it here.

## Layout

| Path | What |
|---|---|
| `packages/core` | Domain logic: durations, taxonomy, inference, validation. No I/O. |
| `packages/config` | Env + `hours.config.json` loading. |
| `packages/db` | Prisma schema and repositories. SQLite by default. |
| `connectors/google-sheets` | Tab layout discovery, reads, and the guarded append. |
| `apps/collector` | Signal sources (git, Claude sessions) and the sweep daemon. |
| `apps/cli` | The `hours` command. |
| `apps/mcp-server` | MCP tools for Claude. |

## Commands

```bash
pnpm test          # 92 tests
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
