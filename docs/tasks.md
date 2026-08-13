# Tasks and hour attachment (design)

Tasks are OpenProject work packages. This doc pins what "a task has hours attached to it"
means, how an agent detects it, and the four slices that implement it. Slices 1–2 are the
detection loop; 3–4 make it retroactive and surface it in the CLI.

## The problem

The pipeline today attaches hours to *projects*: `Entry.projectKey`. The sheet, the drafts,
and the inference all stop there. But the work itself is delegated per *task* — "task #136"
is how a task is handed to an agent — and the question an agent actually needs answered is:

> Does task #136 already have hours on it, and how many?

That answer is what prevents double-counting when the agent logs its own time against the
task.

## The rule

**A task has hours attached iff time is recorded against it.** Two ledgers record time, and
neither sees the other:

| Ledger | Where | Written by | Read by |
|---|---|---|---|
| OpenProject time entries | `spentTime` on the work package | `op_log_time` (always the API key's user) | anyone with the API |
| The sheet | rows in `North10AI` / `LP Internal AI` tabs | this repo, after review | the whole team, the LP connector |

**The sheet is the ledger of record for this engagement.** Billed hours are logged there, so
that is where "hours attached" is likeliest to show up — the local side of the cache
(`hours.db` entries with a `taskId`) is the primary detection signal in practice.

**OpenProject is where the work is delegated.** Its task gets the hours *where relevant*:
when an entry carries a `taskId`, the push path also logs the same minutes to the OpenProject
task (best-effort, after the sheet append succeeds — see slice 2). OpenProject's own
`spentTime` is cached and reported, but it is a secondary signal: time shows up there only
when something wrote it, and two things do — this tool's push write-through, and agents
calling `op_log_time` directly through the openproject-mcp server (whose `op_get_work_package`
and `op_log_time` results now carry the local sheet side as `hoursLedger`, reported
separately, so the union stays visible from either side).

The cache is the reconciliation point: it stores OpenProject's side and sums the local side.

### The invariant: never sum across ledgers

A sheet row and an OpenProject time entry can describe the same work, and nothing links them
— no shared id, no matching window. The naive "total = spentTime + local minutes"
double-counts the moment a task is logged in both places. So `task_hours` reports each ledger
separately and the agent treats the *union* as "already covered".

## Detection from an agent standpoint

Two moments, two mechanisms — both deterministic queries, never inference from prose.

**At assignment time** the agent asks. Either path:

- The hours MCP tool `task_hours {taskId, refresh?}` — one call, reads the cache, refreshes
  from OpenProject on demand. Answer shape:

  ```
  task #136 "Rebuild packages/grants …" (north10, Closed)
  attached: yes
    OpenProject: 2h00m (1 entry)
    local pushed: 1h15m (3 entries)
    local drafts: 0h45m (1 entry, not pushed)
  ```

- The OpenProject MCP tools directly: `op_get_work_package` → `spentTime`, or
  `op_list_time_entries {workPackage}`. Fine today; note the deployed server is older than
  `~/Projects/OpenProject/server.mjs` and needs a redeploy before `spentTime` can be trusted
  from it.

**Retroactively** the collector detects it without the agent lifting a finger: task refs are
parsed from branch names, commit subjects, and session subjects; blocks whose signals agree
on a task carry the `taskId` into the draft; `get_day` shows the ref. See slice 3.

## Data model

```prisma
model Task {
  id            String   @id        // OpenProject work package id, e.g. "136"
  projectKey    String
  subject       String
  status        String?
  // OpenProject's spentTime, cached. Null until the first sync.
  spentMinutes  Int?
  // estimatedTime cached for display only — budgets are out of scope.
  estimatedMinutes Int?
  syncedAt      DateTime?
}

model Entry {
  // …
  taskId String?   // nullable: not every entry belongs to a task
}

model Signal {
  // …
  taskId String?   // set by ref attribution, before inference consumes it
}
```

## Slices

### 1. Cache, connector, `task_hours`

- `Task` model; `Entry.taskId`; `Signal.taskId`.
- `connectors/openproject/` — read-only REST client: work packages + time entries per
  package. New env: `OPENPROJECT_URL`, `OPENPROJECT_API_KEY`. **Graceful offline**: a failed
  sync leaves the cache untouched; the tool chain never depends on OpenProject being up.
- The sweep calls `syncTasks()` (upsert work packages + spent time) alongside signal
  collection.
- MCP tool `task_hours {taskId, refresh?}` with the ledger-split answer above. Validation:
  `taskId` must be a positive integer.

Acceptance: `task_hours 136` reports both ledgers from a cold cache after one sync; with
OpenProject unreachable it still answers from the cache and says so.

### 2. `taskId` on the write path

- `log_time` / `start_timer` / `edit_entry` accept `taskId`; validated against the cache —
  a ref to a task the cache has never seen is refused, not guessed.
- **The task mention is part of the notes process, not a rendering afterthought.** The review
  and edit prompts show the task ref next to the entry, the reviewer's note describes the
  work *on that task*, and `toSheetRow` prefixes the Notes column with `[#136] ` so the
  mention is guaranteed on every pushed row (the sheet has no task column; Notes is the only
  slot, same as clock ranges).
- `get_day` shows the ref in `describeEntries`.
- **OpenProject write-through.** When an entry has a `taskId` and the sheet append succeeds,
  the push path also creates an OpenProject time entry for the same task, day, and minutes —
  best-effort: a failure is reported but never blocks or fails the sheet push. Idempotent:
  `PushLog` records the created time-entry ids, so a retried push skips what already landed.

Acceptance: logging 45m against #136 makes `task_hours 136` show `local drafts: 0h45m`;
after `push_to_sheet`, the pushed row's Notes starts with `[#136]` *and* OpenProject shows a
45m time entry on #136; re-pushing the same entries creates no second OpenProject entry.

### 3. Retroactive attribution

- Pure parsing in `packages/core/src/taskrefs.ts` (testable, no I/O), deterministic
  patterns only: branch `136-matcher` / `feature/136-…`; subjects `#136`, `closes 136`,
  `refs 136`.
- Attribution happens at *reconstruct* time, not collect time: a signal's ref is provisional
  until a block's signals **agree** on a task. Disagreement → no task, matching the existing
  "unattributed rather than guessed" rule. A ref to a task missing from the cache stays
  unattributed until a sync has seen it — the sweep refreshes every 10 minutes, so it
  resolves on the next run.
- `entryFromBlock` carries the taskId into the entry; `provenance` mentions the refs.

Acceptance: a day with `git checkout 136-matcher`, a commit `fix #136`, and a session on the
same branch produces one draft with `taskId 136` and a provenance line naming the refs.

### 4. CLI

- `hours task 136` — same answer as `task_hours`.
- `hours tasks [--project north10]` — all cached tasks with attached hours, both ledgers.
- `hours log … --task 136`.

Acceptance: CLI parity with the MCP tools; `hours tasks` is the end-of-week "what had hours
on it" report.

## Open questions

- **Budgets** (`estimatedTime`) are cached for display but not part of detection. If a task
  ever needs "delegated hours" semantics, the rule extends to *either* ledger non-empty.

## Flags

- The deployed OpenProject MCP server (as of 2026-08-13) is older than the repo:
  `op_get_work_package` on it does not reliably surface `spentTime`, and `op_create_work_package`
  predates the `notify` param. Redeploy before agents lean on the direct detection path.
- `op_log_time` always attributes to the API key's own user — OpenProject time entries can
  never be logged on someone else's behalf.
- Ref parsing is only as good as naming discipline; that is why slice 3 requires agreement
  across a block's signals and refuses unknown tasks rather than guessing.
