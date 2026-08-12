# CLAUDE.md

Guidance for Claude Code working in this repository.

## What This Is

A standalone time-tracking tool for the North10AI and LP Internal AI engagements. It collects
passive evidence of work (git commits, branch checkouts, Claude Code session turns), infers a
draft timesheet from it, and — after explicit review and confirmation — appends rows to the two
tabs of a shared Google Sheet the team already uses.

It connects to `~/Projects/NorthAI` and `~/Projects/lp-internal-ai-v1` read-only, as watched
repos. It shares no code with them.

## Stack

| Layer | Technology |
|---|---|
| Language | TypeScript (strict, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`) |
| Store | SQLite via Prisma 7 + `@prisma/adapter-better-sqlite3` |
| Sheets | `googleapis` with a service account (`spreadsheets` scope) |
| MCP | `@modelcontextprotocol/sdk` (stdio) |
| Tests | Vitest |
| Monorepo | pnpm workspaces |

Prisma 7 specifics: the connection URL lives in `prisma.config.ts` (CLI) and in the adapter
passed to `PrismaClient` (runtime), **not** in the schema's `datasource` block. The generator is
`prisma-client` (not `prisma-client-js`), emitting ESM into `packages/db/generated/client`. Run
`prisma` from the repo root — that is where `prisma.config.ts` is.

## Commands

```bash
pnpm install
pnpm db:generate && pnpm db:push     # from the repo root
pnpm test                            # 92 tests
pnpm -r typecheck
pnpm lint

pnpm hours <command>                 # the CLI
pnpm collect                         # the sweep daemon
pnpm mcp                             # the MCP server (stdio)
pnpm sheets:probe                    # inspect the real spreadsheet (needs credentials)
```

Run a single test file: `pnpm exec vitest run packages/core/src/overlaps.test.ts`

## Architecture

```
apps/cli ──┐
apps/mcp-server ──┼──► apps/collector ──► packages/db ──► SQLite
           └──► connectors/google-sheets ──► Google Sheets
                        │
                 packages/core  (pure domain logic, no I/O)
                 packages/config
```

`packages/core` has no I/O and no dependencies on the other packages. Inference, taxonomy,
duration parsing, and validation all live there and are unit-testable in isolation. Keep it
that way — it is why the inference rules are pinned by 60+ tests.

`apps/collector` exports both `sweep` (gather signals) and `reconstruct` (signals → draft
entries) through `src/exports.ts`, because the CLI and the MCP server both need them. Neither
app should import from the other's source tree.

## Invariants

These are load-bearing. Breaking one is a correctness bug, not a style question.

1. **Inferred time never exceeds wall-clock time.** Overlapping blocks are apportioned, not
   summed. The regression tests are in `packages/core/src/overlaps.test.ts` and they exist
   because the first version billed one minute of pushing as 1h30m.
2. **Signals are append-only and idempotent** on `sourceId`. Re-collecting must be a no-op.
3. **Attributed work is arbitrated before unattributed work**, and unattributed blocks are
   clipped against what attributed blocks claimed. Otherwise a long session in an unwatched
   directory crowds out a real commit and that time disappears.
4. **Status moves one direction only**: `draft → approved → pushed`. A pushed entry is
   immutable locally.
5. **Only `Activity` values from the sheet's taxonomy are ever written.** Anything else breaks
   the pivot tables sitting to the right of the data on every tab. `validateEntries` treats
   this as an error, not a warning.
6. **Appends are bounded to the tab's data columns.** `discoverLayout` computes `dataWidth`
   precisely so `values.append` cannot treat a pivot table as part of the table to extend.
7. **The sheet is append-only.** No updates, no deletes — other people's rows live there.

## Sheet conventions

Discovered at runtime, never hard-coded, because the tabs disagree with each other:

- The header row is not always row 1; scan the first 12 rows for Date/Person/Hours/Activity.
- The fourth column is `Activity` on some tabs and `Category` on others.
- Some tabs have a `Notes` column; some don't.
- Dates appear as both `2/26` and `2/26/26`.
- People appear with inconsistent casing (`Kristian`/`kristian`).
- Hours are real durations, rendered `h:mm:ss`, and one row reads `13:14:59` where the pivot
  shows `13:15:00` — round seconds, don't truncate.

## Conventions

- Comments explain *why*, especially where a rule looks arbitrary — most of them encode a
  real defect found against real data. Don't strip them.
- No `any`. No non-null assertions in `src/` (tests may use them).
- Operational failures are messages, not stack traces; `HOURS_DEBUG=1` restores the trace.
- New signal sources go in `apps/collector/src/`, export a function returning `Signal[]` with
  stable `sourceId`s, and get a weight in `KIND_WEIGHT` in `packages/core/src/blocks.ts`.
- Adding a project needs no code change — it goes in `hours.config.json`.

## Related

`lp-internal-ai-v1/connectors/google-sheets/src/sync-hours.ts` reads these same two tabs into
an `hour_logs` table for reporting. That is the read-for-analytics path; this repo is the
capture-and-write path. Don't duplicate either in the other.
