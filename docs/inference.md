# How a day is inferred

This is the part worth understanding before you trust a draft, because two of the rules exist
specifically because the naive version was wrong against real history.

## Signals

A signal is one timestamped observation. Nothing more is claimed for it.

| Kind | Source | Weight |
|---|---|---|
| `git_commit` | `git log --all --no-merges`, **author** date | 4 |
| `manual` | you, via `hours log` | 4 |
| `calendar` | reserved, not yet collected | 4 |
| `git_branch` | `git reflog` checkouts | 2 |
| `claude_session` | user turns in `~/.claude/projects/*/*.jsonl` | 1 |
| `file_edit` | reserved, not yet collected | 1 |

Two details in the git reader matter:

- **Author date, not commit date.** A rebase rewrites commit dates, which would teleport last
  week's work onto today's timesheet.
- **All branches plus the reflog**, not just `HEAD`. Work on a branch you have since left still
  happened.

Commits are filtered to your own `user.email` by default, so a teammate's merged work never
lands on your row.

Session signals resolve their project from the transcript's `cwd` through the project
registry — the directory-slug encoding is never parsed. A session run outside a watched repo
becomes an **unattributed** signal rather than a guess.

## Signals → blocks

1. **Split into per-project streams.** Runs are cut by idle gaps *within* a stream.
   Splitting one interleaved timeline by project instead shredded a single push into one run
   per commit, because a session signal from an unwatched directory lands between every pair
   of commits.
2. **Cut runs on an idle gap** longer than `gapMin` (default 25 min).
3. **Apply the lead-in.** Most signals are *trailing edges* — a commit at 10:45 records work
   that happened before 10:45, not at it. So a block ends at its last signal and starts at its
   first minus `leadInMin` (default 20). Without this, six commits infer six zero-length
   blocks and the day reports 0 hours.
4. **Clamp to the workday** (9:00–15:00 by default). Set `HOURS_ALLOW_OUTSIDE=1` to keep
   evening work instead of discarding it.
5. **Round to the 15-minute grid** the sheet uses, and drop anything under `minBlockMin`.
6. **Classify.** Paths first, then commit subjects — `prisma/schema.prisma` is Data model,
   `docs/` is Documentation, `.github/workflows/` is Deployment, `feat:`/`fix:` is Development.
   Path rules score by *share* of files matched, so one stray docs tweak inside a big feature
   commit does not relabel the block.
7. **Merge neighbours** that share a project and activity.
8. **Apportion overlaps** — below.

## Apportionment: the over-reporting guard

The first run of this inference against real NorthAI history billed one minute of work as
**1h30m**. Six commits were pushed at 15:02; each became its own 15-minute block, and all six
claimed 14:45–15:00.

A person does one thing at a time, so a cluster of overlapping blocks describes *one* stretch
of work whose span is the union. The activities inside it share that span:

- Shares are proportional to **evidence weight** (the table above), not raw signal count. One
  commit says more about what you were doing than twenty session turns.
- Every surviving share gets at least one 15-minute granule.
- When a cluster is too short to give every activity a granule, the weakest-evidence ones are
  **dropped**, and the survivors' `reason` says which and why. Under-reporting is a review
  nudge; over-reporting is a billing problem.
- **Distinct projects** in one window do get their own granule each, and the window stretches
  backward to fit them — separate projects are strong evidence of separate work. Distinct
  *activities* within one project are not, since a single push routinely touches code, docs,
  and CI at the same instant.

## Attributed work is arbitrated first

Unattributed blocks never compete with real project work. Before this rule, a long Claude
session in an unwatched directory — hundreds of turns — outvoted a real commit and squeezed
the project's block down to a single granule; then, because unattributed blocks are discarded
rather than logged, that time vanished entirely.

So: attributed blocks are apportioned among themselves, then unattributed blocks are
**clipped** against whatever the attributed ones claimed, and only the remaining free time is
offered as unattributed suggestions.

## What it deliberately gets wrong

**It under-reports sparsely committed days.** Four commits spread across a day are four
isolated points, so the lead-in is all the evidence there is: 4 × 15m = 1 hour, whatever the
day actually felt like. Session signals fill that gap when you were working in a watched repo;
otherwise the review step is where you fix it. This is intentional — the tool will never invent
time you cannot defend.

**Confidence is a hint, not a verdict.** `hours review` prints the reason and confidence for
every draft. Anything under 0.6 came from weak evidence and deserves a look.

## Idempotency

Signals folded into an entry are marked `consumedAt`, so re-running reconstruction picks up
only what arrived since. Signals belonging to an activity that apportionment had to *drop* are
still consumed — attached to the strongest survivor — because otherwise they would be
re-inferred tomorrow and log the same window twice.

Each entry stores the sourceIds it was inferred from, so `hours drop` releases them back into
the pool and the next `hours reconstruct` re-offers that stretch of the day. Discarding a bad
draft costs you nothing but the draft.
