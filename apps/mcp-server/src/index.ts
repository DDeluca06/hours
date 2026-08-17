// ---------------------------------------------------------------------------
// MCP server.
//
// Lets Claude log time conversationally — "log the last 90 minutes as data model
// work on LP" — from inside either project, and lets a Claude session record its
// own work as it goes.
//
// One deliberate asymmetry runs through the tool set: reading and drafting are
// free, but `push_to_sheet` requires an explicit `confirm: true` from the caller.
// There is no terminal here to prompt at, so the confirmation has to be part of
// the call, and a model that has not been told to push cannot stumble into
// writing to a spreadsheet the whole team reads.
// ---------------------------------------------------------------------------

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { loadConfig, requirePushConfig } from '@hours/config';
import {
  formatClockRanges,
  formatMinutesShort,
  localDayKey,
  projectByKey,
  projectForPath,
  resolveActivity,
  toSheetRow,
  validateEntries,
  ACTIVITIES,
  activityListText,
  activityParamHint,
  type Activity,
  type Entry,
} from '@hours/core';
import {
  approveEntries,
  claimEntriesForPush,
  createEntries,
  openTimers,
  resolveTimerTarget,
  getTask,
  listEntries,
  listOpenProjectTimeEntries,
  listTaskMinutes,
  logPush,
  markPushed,
  pushedHours,
  releasePushClaim,
  startTimer,
  stopTimer,
  updateEntry,
  upsertTasks,
  type OpenTimer,
  type StoredEntry,
} from '@hours/lib-db';
import { reconstruct, sweep } from '@hours/collector';
import { previewPush, pushEntries, readTab, summarize } from '@hours/connector-google-sheets';
import {
  createTimeEntry,
  getWorkPackage,
  listTimeEntries,
} from '@hours/connector-openproject';

const cfg = loadConfig();

const server = new McpServer({ name: 'hours', version: '0.1.0' });

function text(body: string) {
  return { content: [{ type: 'text' as const, text: body }] };
}

function fail(message: string) {
  return { content: [{ type: 'text' as const, text: message }], isError: true };
}

/** Accept only explicit YYYY-MM-DD keys that are real local dates. */
function validDay(raw: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return false;
  // new Date rolls impossible dates over (2026-02-30 becomes Mar 2), so a
  // round-trip through localDayKey rejects them.
  return localDayKey(new Date(`${raw}T00:00:00`)) === raw;
}

/** Resolve a project from an explicit key, or from the calling directory. */
function resolveProject(key?: string, cwd?: string) {
  if (key) {
    const byKey = projectByKey(key, cfg.projects);
    if (byKey) return byKey;
    throw new Error(
      `unknown project "${key}" — known projects: ${cfg.projects.map((p) => p.key).join(', ')}` +
        ' (hours project keys are short registry keys; OpenProject identifiers like "north10-ai" are not them)',
    );
  }
  if (cwd) {
    const byPath = projectForPath(cwd, cfg.projects);
    if (byPath) return byPath;
  }
  throw new Error(
    `project is required — pass one of: ${cfg.projects.map((p) => p.key).join(', ')}`,
  );
}

/**
 * Validate a taskId from the write tools against the local cache. A ref to a
 * task the cache has never seen is refused, not guessed — the write path must
 * not invent an attachment the user never confirmed. Returns the failure
 * message, or null when the id is usable.
 */
async function checkTaskId(taskId: string): Promise<string | null> {
  if (!/^\d+$/.test(taskId) || Number(taskId) <= 0) {
    return `"${taskId}" is not a task id — use a positive integer like "136"`;
  }
  if ((await getTask(taskId)) === null) {
    return `task #${taskId} is not in the local cache — call task_hours with refresh: true to cache it first, or wait for the next sweep`;
  }
  return null;
}

function describeEntries(entries: readonly StoredEntry[]): string {
  if (entries.length === 0) return '(none)';
  return entries
    .map(
      (e) =>
        `${e.id.slice(-6)}  ${e.taskId ? `[#${e.taskId}] `.padEnd(7) : ''}${e.status.padEnd(8)} ${e.day}  ${e.projectKey.padEnd(8)} ` +
        `${e.activity.padEnd(16)} ${formatMinutesShort(e.minutes).padEnd(7)} ` +
        `${e.ranges.length ? formatClockRanges(e.ranges) : '—'}` +
        (e.description ? `  ${e.description}` : ''),
    )
    .join('\n');
}

// --- reading --------------------------------------------------------------

server.registerTool(
  'list_projects',
  {
    title: 'List tracked projects',
    description:
      'The project registry: keys to use in other tools, the spreadsheet tab each maps to, the repos watched for signals, and hours pushed so far.',
    inputSchema: {},
  },
  async () => {
    const lines: string[] = [];
    for (const p of cfg.projects) {
      const pushed = await pushedHours(p.key);
      lines.push(
        `${p.key}  "${p.name}"  → tab "${p.sheetTab}"  ${pushed.toFixed(2)}h pushed` +
          (p.contractHours !== undefined ? `  (contract ${p.contractHours}h)` : ''),
      );
      for (const repo of p.repoPaths) lines.push(`    watches ${repo}`);
    }
    lines.push(
      '',
      `Activities: ${ACTIVITIES.join(', ')} — call list_activities for what each one is for and the accepted shorthands`,
    );
    return text(lines.join('\n'));
  },
);

server.registerTool(
  'list_activities',
  {
    title: 'List the sheet activities',
    description:
      'The fixed activity taxonomy for the activity parameter: every acceptable value, what each one is for, and the accepted shorthands. Call this whenever an activity does not seem to fit instead of inventing a new label — unknown labels are refused, not guessed, because the sheet pivots on these exact values.',
    inputSchema: {},
  },
  async () => {
    return text(
      [
        'The activity parameter takes one of these fixed values (the sheet\'s Activity/Category column — some tabs call it "Activity", others "Category").',
        'Free-form description of what you did goes in the note parameter, not here.',
        'OpenProject\'s own activity names (Management, Specification, …) are a different vocabulary and are not accepted.',
        '',
        activityListText(),
        '',
        'Shorthands and unique prefixes also resolve ("dev", "qa", "wire"). Anything else is refused with an error naming the full list.',
      ].join('\n'),
    );
  },
);

server.registerTool(
  'get_day',
  {
    title: 'Show a day',
    description:
      "Entries logged for one day, with totals and any validation warnings. Use before logging to avoid double-counting time that's already recorded.",
    inputSchema: {
      day: z.string().optional().describe('YYYY-MM-DD. Defaults to today.'),
    },
  },
  async ({ day }) => {
    if (day !== undefined && !validDay(day)) return fail(`${day} is not a YYYY-MM-DD day`);
    const target = day ?? localDayKey(new Date());
    const entries = await listEntries({ day: target });
    const total = entries.reduce((s, e) => s + e.minutes, 0);
    const issues = validateEntries(entries);
    const timers = await openTimers();

    return text(
      [
        `${target} — ${formatMinutesShort(total)} across ${entries.length} entr${entries.length === 1 ? 'y' : 'ies'}`,
        describeEntries(entries),
        issues.length
          ? `\nvalidation:\n${issues.map((i) => `  ${i.severity}: ${i.message}`).join('\n')}`
          : '',
        ...timers.map(
          (t) => `\ntimer running: ${t.projectKey} ${t.activity ?? '(no activity)'} since ${t.startedAt.toISOString()}`,
        ),
      ]
        .filter(Boolean)
        .join('\n'),
    );
  },
);

server.registerTool(
  'sheet_summary',
  {
    title: 'Read the spreadsheet tab',
    description:
      "What the shared sheet already says for a project's tab: total hours, per-person and per-activity breakdown, and contract usage. Read-only.",
    inputSchema: {
      project: z.string().optional().describe('Project key. Inferred from cwd if omitted.'),
      cwd: z.string().optional().describe('Working directory, used to infer the project.'),
    },
  },
  async ({ project, cwd }) => {
    try {
      const { sheetId } = requirePushConfig(cfg);
      const p = resolveProject(project, cwd);
      const { rows } = await readTab(sheetId, p.sheetTab);
      const totals = summarize(rows);

      const lines = [
        `${p.sheetTab}: ${rows.length} rows, ${formatMinutesShort(totals.totalMinutes)} total`,
        '',
        'by person:',
        ...[...totals.byPerson.entries()]
          .sort((a, b) => b[1] - a[1])
          .map(([k, v]) => `  ${k}  ${formatMinutesShort(v)}`),
        '',
        'by activity:',
        ...[...totals.byActivity.entries()]
          .sort((a, b) => b[1] - a[1])
          .map(([k, v]) => `  ${k || '(blank)'}  ${formatMinutesShort(v)}`),
      ];
      if (p.contractHours !== undefined) {
        const used = totals.totalMinutes / 60;
        lines.push(
          '',
          `contract: ${used.toFixed(2)}h of ${p.contractHours}h (${(p.contractHours - used).toFixed(2)}h left)`,
        );
      }
      if (totals.unparsedRows.length) {
        lines.push('', `unparsable Hours in rows: ${totals.unparsedRows.join(', ')}`);
      }
      return text(lines.join('\n'));
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  },
);

// --- task hours ------------------------------------------------------------

server.registerTool(
  'task_hours',
  {
    title: 'Task hours',
    description:
      'Whether a task (OpenProject work package) has hours attached: what OpenProject itself reports, what is already in the sheet locally, and what is still a draft. Reports the two ledgers separately — they can describe the same work, so they are never summed.',
    inputSchema: {
      taskId: z.string().describe('OpenProject work package id, e.g. "136".'),
      refresh: z
        .boolean()
        .optional()
        .describe('Re-fetch from OpenProject instead of answering from the cache.'),
    },
  },
  async ({ taskId, refresh }) => {
    try {
      if (!/^\d+$/.test(taskId) || Number(taskId) <= 0) {
        return fail(`"${taskId}" is not a task id — use a positive integer like "136"`);
      }

      let task = await getTask(taskId);
      const op = cfg.openproject;
      let note = '';
      let refreshed = false;
      let opMinutes: number | null = null;
      let opEntryCount = 0;

      if (op.url === undefined || op.apiKey === undefined) {
        if (task === null) {
          return fail(
            `task #${taskId} has no hours attached locally, and OpenProject is not configured ` +
              '(OPENPROJECT_URL/OPENPROJECT_API_KEY) — nothing to report',
          );
        }
        note = 'OpenProject not configured (OPENPROJECT_URL/OPENPROJECT_API_KEY) — cached only';
      } else if (refresh === true || task === null) {
        try {
          const [wp, timeEntries] = await Promise.all([
            getWorkPackage({ url: op.url, apiKey: op.apiKey, id: taskId }),
            listTimeEntries({ url: op.url, apiKey: op.apiKey, workPackage: taskId }),
          ]);

          let projectKey = task?.projectKey ?? taskId;
          let projectWarning: string | null = null;
          if (task === null) {
            // The registry maps hours keys → OpenProject identifiers, and that
            // direction cannot be inverted from the work package alone. One
            // mapped project is unambiguous; more than one would be a guess, so
            // the task is cached under its raw id instead (slice 3 attribution
            // refines this).
            const mapped = Object.entries(op.projects ?? {});
            if (mapped.length === 1) {
              projectKey = mapped[0]?.[0] ?? taskId;
            } else if (mapped.length > 1) {
              projectWarning = 'project unknown — cached under the raw id';
            }
          }

          task =
            (
              await upsertTasks([
                {
                  id: taskId,
                  projectKey,
                  subject: wp.subject,
                  ...(wp.status !== null ? { status: wp.status } : {}),
                  ...(wp.spentMinutes !== null ? { spentMinutes: wp.spentMinutes } : {}),
                  ...(wp.estimatedMinutes !== null
                    ? { estimatedMinutes: wp.estimatedMinutes }
                    : {}),
                },
              ])
            )[0] ?? null;
          refreshed = true;
          opMinutes = timeEntries.totalMinutes;
          opEntryCount = timeEntries.entries.length;
          if (projectWarning !== null) note = projectWarning;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          if (task === null) return fail(message);
          note = `OpenProject unreachable: ${message}`;
        }
      } else {
        note = '(cached — pass refresh=true to re-check OpenProject)';
      }

      const local = (await listTaskMinutes()).find((m) => m.taskId === taskId);
      const pushed = (local?.pushedMinutes ?? 0) + (local?.approvedMinutes ?? 0);
      const drafts = local?.draftMinutes ?? 0;
      // The union rule from the design doc: either ledger having hours makes
      // the task "covered", but the two are never summed in one number.
      const opSide = refreshed ? opMinutes ?? 0 : task?.spentMinutes ?? 0;
      const attached = opSide > 0 || pushed + drafts > 0;

      const lines: string[] = [
        `task #${taskId} "${task?.subject ?? ''}" (${task?.projectKey ?? taskId}${
          task?.status ? `, ${task.status}` : ''
        })`,
        `attached: ${attached ? 'yes' : 'no'}`,
      ];

      if (refreshed) {
        lines.push(
          `  OpenProject: ${formatMinutesShort(opMinutes ?? 0)} (${opEntryCount} time entr${
            opEntryCount === 1 ? 'y' : 'ies'
          })`,
        );
      } else if (task?.spentMinutes !== null && task?.spentMinutes !== undefined) {
        lines.push(`  OpenProject: ${formatMinutesShort(task.spentMinutes)}`);
      }

      const localParts: string[] = [];
      if (pushed > 0) {
        // Approved is sheet-bound but not yet appended, so it folds into the
        // pushed bucket — the count and the mention keep it visible.
        const count = (local?.pushedEntries ?? 0) + (local?.approvedEntries ?? 0);
        localParts.push(
          `${formatMinutesShort(pushed)} pushed (${count} entr${count === 1 ? 'y' : 'ies'}${
            local && local.approvedEntries > 0 ? `, incl. ${local.approvedEntries} approved` : ''
          })`,
        );
      }
      if (drafts > 0) {
        localParts.push(
          `${formatMinutesShort(drafts)} drafts (${local?.draftEntries ?? 0} entr${
            (local?.draftEntries ?? 0) === 1 ? 'y' : 'ies'
          })`,
        );
      }
      if (localParts.length) lines.push(`  local sheet: ${localParts.join(' + ')}`);
      if (note) lines.push('', note);

      return text(lines.join('\n'));
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  },
);

// --- drafting -------------------------------------------------------------

server.registerTool(
  'log_time',
  {
    title: 'Log time',
    description:
      'Record time already spent as a draft entry. Nothing reaches the spreadsheet until it is approved and pushed.',
    inputSchema: {
      minutes: z.number().int().positive().describe('Duration in minutes. Multiples of 15 match the sheet.'),
      activity: z.string().describe(activityParamHint()),
      project: z.string().optional().describe('Project key. Inferred from cwd if omitted.'),
      cwd: z.string().optional().describe('Working directory, used to infer the project.'),
      day: z.string().optional().describe('YYYY-MM-DD. Defaults to today.'),
      note: z.string().optional().describe('Short description for the Notes column.'),
      startClock: z
        .string()
        .optional()
        .describe('Wall-clock start like "9:00" or "1:30 PM", so Notes can show a real range.'),
      taskId: z
        .string()
        .optional()
        .describe('OpenProject work package id to attach these minutes to, e.g. "136".'),
    },
  },
  async ({ minutes, activity, project, cwd, day, note, startClock, taskId }) => {
    try {
      if (day !== undefined && !validDay(day)) return fail(`${day} is not a YYYY-MM-DD day`);
      const p = resolveProject(project, cwd);
      if (taskId !== undefined) {
        const problem = await checkTaskId(taskId);
        if (problem !== null) return fail(problem);
      }
      const resolved = resolveActivity(activity);
      if (!resolved) {
        return fail(
          `"${activity}" is not a recognizable activity. The activity parameter takes one of the sheet's fixed values (shorthands like "dev" also resolve; a description of the work goes in note):\n${activityListText()}`,
        );
      }
      if (!cfg.person) return fail('HOURS_PERSON is not set, so there is no name for the Person column');

      const entry: Entry = {
        day: day ?? localDayKey(new Date()),
        person: cfg.person,
        projectKey: p.key,
        minutes,
        activity: resolved,
        ranges: [],
        status: 'draft',
        provenance: 'logged via MCP',
      };
      if (note) entry.description = note;
      if (taskId !== undefined) entry.taskId = taskId;
      if (startClock) {
        const { parseClockToken } = await import('@hours/core');
        const startMin = parseClockToken(startClock);
        if (startMin === null) return fail(`cannot read "${startClock}" as a clock time`);
        entry.ranges = [{ startMin, endMin: startMin + minutes }];
      }

      const [created] = await createEntries([entry]);
      return text(
        `logged as a draft:\n${describeEntries(created ? [created] : [])}\n\nApprove it with approve_day, then push_to_sheet.`,
      );
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  },
);

server.registerTool(
  'start_timer',
  {
    title: 'Start a timer',
    description:
      'Begin timing work on a project. Timers run per project — starting on a project that already has one running stops the old one and discards its time, while timers on other projects keep running. Check timer_status first.',
    inputSchema: {
      project: z.string().optional().describe('Project key. Inferred from cwd if omitted.'),
      cwd: z.string().optional(),
      activity: z
        .string()
        .optional()
        .describe(`Can also be supplied when stopping. ${activityParamHint()}`),
      note: z.string().optional(),
      taskId: z
        .string()
        .optional()
        .describe('OpenProject work package id to attach the resulting entry to, e.g. "136".'),
    },
  },
  async ({ project, cwd, activity, note, taskId }) => {
    try {
      const p = resolveProject(project, cwd);
      const resolved = activity ? resolveActivity(activity) : null;
      if (activity && !resolved) {
        return fail(
          `"${activity}" is not a recognizable activity:\n${activityListText()}`,
        );
      }
      if (taskId !== undefined) {
        const problem = await checkTaskId(taskId);
        if (problem !== null) return fail(problem);
      }

      const { started, replaced, concurrent } = await startTimer({
        projectKey: p.key,
        ...(resolved ? { activity: resolved } : {}),
        ...(note ? { note } : {}),
        ...(taskId ? { taskId } : {}),
      });
      return text(
        [
          `started ${started.projectKey} ${started.activity ?? '(activity at stop time)'} at ${started.startedAt.toISOString()}`,
          replaced
            ? `NOTE: stopped and discarded a running ${replaced.projectKey} timer worth ${formatMinutesShort(replaced.minutes)} — log it manually if it mattered`
            : '',
          // Told to the agent at start time on purpose: from now on both timers
          // accumulate the same minutes and each will log all of them to its own
          // contract. Nothing downstream blocks that.
          concurrent.length
            ? `WARNING: ${concurrent.map((t) => t.projectKey).join(', ')} timer(s) are also running, so the same wall-clock minutes are accruing on more than one project. Stop one unless the overlap is intended.`
            : '',
        ]
          .filter(Boolean)
          .join('\n'),
      );
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  },
);

server.registerTool(
  'stop_timer',
  {
    title: 'Stop the timer',
    description:
      'Stop a running timer and turn its elapsed time into a draft entry. Defaults to the most recently started timer; pass project to stop that project\u2019s instead. Timers on other projects keep running.',
    inputSchema: {
      project: z
        .string()
        .optional()
        .describe('Project key of the timer to stop. Defaults to the most recently started.'),
      activity: z
        .string()
        .optional()
        .describe(`Required unless the timer was started with one. ${activityParamHint()}`),
      note: z.string().optional(),
    },
  },
  async ({ project, activity, note }) => {
    let projectKey: string | undefined;
    if (project) {
      try {
        projectKey = resolveProject(project).key;
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
      }
    }
    const all = await openTimers();
    // Refuses rather than guessing when several are running — stopping the
    // newest would bank one contract's afternoon against the other. Resolved
    // here so the refusal is a tool error, not a thrown stack.
    let target: OpenTimer | null;
    try {
      target = resolveTimerTarget(all, projectKey);
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
    if (!target) {
      return text(projectKey ? `no timer running on ${projectKey}` : 'no timer running');
    }

    const stopped = await stopTimer({ projectKey: target.projectKey });
    if (!stopped) return text('no timer running');

    const activityRaw = activity ?? stopped.activity;
    if (!activityRaw) {
      return fail(
        `the ${stopped.projectKey} timer had no activity, so nothing was logged. Its ${formatMinutesShort(stopped.minutes)} is not saved — call log_time with an activity to record it.`,
      );
    }
    const resolved = resolveActivity(activityRaw);
    if (!resolved) {
      return fail(
        `"${activityRaw}" is not a recognizable activity. Call list_activities or retry with one of:\n${activityListText()}`,
      );
    }
    if (!cfg.person) return fail('HOURS_PERSON is not set');

    const startMin = stopped.startedAt.getHours() * 60 + stopped.startedAt.getMinutes();
    const entry: Entry = {
      day: localDayKey(stopped.startedAt),
      person: cfg.person,
      projectKey: stopped.projectKey,
      minutes: stopped.minutes,
      activity: resolved,
      // Not clamped at midnight: formatClock wraps, so a 23:00→00:30 timer
      // reads "23:00 - 0:30", which is what happened. Clamping to 1440
      // rendered it "23:00 - 0:00" — a range shorter than the minutes logged.
      ranges: [{ startMin, endMin: startMin + stopped.minutes }],
      status: 'draft',
      provenance: 'timer via MCP',
    };
    const description = note ?? stopped.note;
    if (description) entry.description = description;
    // The timer carries its taskId forward when the entry is created — a task
    // attachment belongs to the work, not to the stop.
    if (stopped.taskId) entry.taskId = stopped.taskId;

    const [created] = await createEntries([entry]);
    return text(
      `stopped after ${formatMinutesShort(stopped.minutes)}:\n${describeEntries(created ? [created] : [])}`,
    );
  },
);

server.registerTool(
  'timer_status',
  {
    title: 'Timer status',
    description: 'Which timers are running, on what, and for how long.',
    inputSchema: {},
  },
  async () => {
    const all = await openTimers();
    if (all.length === 0) return text('no timer running');
    return text(
      all
        .map((open) => {
          const mins = Math.round((Date.now() - open.startedAt.getTime()) / 60_000);
          return `${open.projectKey} ${open.activity ?? '(no activity yet)'} — ${formatMinutesShort(mins)} so far, since ${open.startedAt.toISOString()}`;
        })
        .join('\n'),
    );
  },
);

// --- reconstruction -------------------------------------------------------

server.registerTool(
  'reconstruct_day',
  {
    title: 'Reconstruct a day from activity',
    description:
      'Sweep every evidence source — git commits, Claude Code and OpenCode turns, editor saves — infer blocks of work, and write them as draft entries with the reasoning attached. Agent turns carry their measured duration; other signals get a conservative lead-in. Safe to re-run — signals already folded in are not counted twice.',
    inputSchema: {
      day: z.string().optional().describe('YYYY-MM-DD. Defaults to today.'),
      dryRun: z.boolean().optional().describe('Report what would be drafted without writing.'),
      collect: z.boolean().optional().describe('Sweep for new signals first. Defaults to true.'),
    },
  },
  async ({ day, dryRun, collect }) => {
    try {
      if (day !== undefined && !validDay(day)) return fail(`${day} is not a YYYY-MM-DD day`);
      const target = day ?? localDayKey(new Date());
      const lines: string[] = [];

      if (collect !== false) {
        const swept = await sweep({ since: new Date(`${target}T00:00:00`) });
        lines.push(`collected ${swept.recorded} new signal(s) from ${swept.scanned} scanned`);
        for (const w of swept.warnings) lines.push(`  warning: ${w}`);
      }

      const out = await reconstruct({ day: target, ...(dryRun ? { dryRun: true } : {}) });
      lines.push(`\n${target} — read ${out.signalsRead} signal(s)`);
      lines.push(dryRun ? '(dry run — nothing written)' : describeEntries(out.created));

      if (out.created.length) {
        lines.push('\nreasoning:');
        for (const e of out.created) {
          if (e.provenance) lines.push(`  ${e.id.slice(-6)}  ${e.provenance}`);
        }
      }

      if (out.unattributed.length) {
        lines.push(
          `\n${out.unattributed.length} block(s) could not be attributed to a watched project:`,
        );
        for (const b of out.unattributed) {
          lines.push(
            `  ${formatMinutesShort(b.minutes)} ${b.activity} — ${b.subjects[0] ?? 'no subject'}`,
          );
        }
        lines.push('  Use log_time to record any of these against a project.');
      }

      return text(lines.join('\n'));
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  },
);

// --- approval and push ----------------------------------------------------

server.registerTool(
  'approve_day',
  {
    title: 'Approve entries',
    description:
      "Mark a day's draft entries as approved, making them eligible for push_to_sheet. Approval alone changes nothing in the spreadsheet.",
    inputSchema: {
      day: z.string().optional().describe('YYYY-MM-DD. Defaults to today.'),
      entryIds: z.array(z.string()).optional().describe('Specific entry ids instead of a whole day.'),
    },
  },
  async ({ day, entryIds }) => {
    if (day !== undefined && !validDay(day)) return fail(`${day} is not a YYYY-MM-DD day`);
    let ids = entryIds;
    if (!ids || ids.length === 0) {
      const target = day ?? localDayKey(new Date());
      const drafts = await listEntries({ day: target, status: 'draft' });
      if (drafts.length === 0) return text(`no drafts to approve on ${target}`);
      ids = drafts.map((d) => d.id);
    } else {
      // Accept the short ids shown in other tools' output, but never silently
      // pick the first suffix match — an ambiguous id must be refused like
      // edit_entry does.
      const all = await listEntries({});
      ids = ids.map((wanted) => {
        const exact = all.find((e) => e.id === wanted);
        if (exact) return exact.id;
        const matches = all.filter((e) => e.id.endsWith(wanted));
        if (matches.length === 1) return (matches[0] as StoredEntry).id;
        if (matches.length === 0) throw new Error(`no entry matching "${wanted}"`);
        throw new Error(
          `"${wanted}" matches ${matches.length} entries (${matches.map((m) => m.id.slice(-6)).join(', ')})`,
        );
      });
    }

    const count = await approveEntries(ids);
    return text(`approved ${count} entr${count === 1 ? 'y' : 'ies'}`);
  },
);

server.registerTool(
  'edit_entry',
  {
    title: 'Edit an entry before it is pushed',
    description:
      "Set or fix a draft or approved entry's note (a brief what-did-you-do, one or two sentences), activity, or minutes. Use after reconstruct_day to write the note an entry is missing, or to correct what inference produced. Refuses pushed entries — those rows already exist in the sheet.",
    inputSchema: {
      id: z.string().describe('Entry id — full or the last 6 characters, as shown by get_day.'),
      note: z
        .string()
        .optional()
        .describe('Brief description for the Notes column. Empty string clears it.'),
      activity: z.string().optional().describe(activityParamHint()),
      minutes: z.number().int().positive().optional().describe('Duration in minutes.'),
      day: z.string().optional().describe('YYYY-MM-DD.'),
      taskId: z
        .string()
        .optional()
        .describe('OpenProject work package id, or an empty string to detach the entry.'),
    },
  },
  async ({ id, note, activity, minutes, day, taskId }) => {
    try {
      if (day !== undefined && !validDay(day)) return fail(`${day} is not a YYYY-MM-DD day`);

      const all = await listEntries({});
      const exact = all.find((e) => e.id === id);
      let found = exact;
      if (!found) {
        // A short id must resolve unambiguously — grabbing the first suffix
        // match would silently edit the wrong entry.
        const matches = all.filter((e) => e.id.endsWith(id));
        if (matches.length > 1) {
          return fail(
            `"${id}" matches ${matches.length} entries (${matches.map((m) => m.id.slice(-6)).join(', ')})`,
          );
        }
        found = matches[0];
      }
      if (!found) return fail(`no entry matching "${id}"`);

      const patch: Parameters<typeof updateEntry>[1] = {};
      if (note !== undefined) patch.description = note;
      if (activity !== undefined) {
        if (!ACTIVITIES.includes(activity as Activity)) {
          return fail(
            `"${activity}" is not a sheet activity — choose one of:\n${activityListText()}`,
          );
        }
        patch.activity = activity as Activity;
      }
      if (minutes !== undefined) {
        patch.minutes = minutes;
        // Keep the clock range consistent with the new length, anchored at the
        // original start — otherwise Notes would contradict the Hours column.
        const first = found.ranges[0];
        if (first) patch.ranges = [{ startMin: first.startMin, endMin: first.startMin + minutes }];
      }
      if (day !== undefined) patch.day = day;
      if (taskId !== undefined) {
        if (taskId === '') {
          // Empty string detaches — not every entry belongs to a task.
          patch.taskId = null;
        } else {
          const problem = await checkTaskId(taskId);
          if (problem !== null) return fail(problem);
          patch.taskId = taskId;
        }
      }
      const updated = await updateEntry(found.id, patch);
      return text(`updated ${found.id.slice(-6)}:\n${describeEntries([updated])}`);
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  },
);

server.registerTool(
  'push_to_sheet',
  {
    title: 'Append approved entries to the spreadsheet',
    description:
      'Append approved entries to their project tab in the shared Hours spreadsheet. This writes to a document the whole team reads. Call with confirm=false first to see exactly what would be written, then confirm=true to do it.',
    inputSchema: {
      confirm: z
        .boolean()
        .describe('Must be true to write. false previews the exact rows without touching the sheet.'),
      project: z.string().optional().describe('Limit to one project key.'),
      day: z.string().optional().describe('Limit to one day, YYYY-MM-DD.'),
      allowDuplicates: z
        .boolean()
        .optional()
        .describe('Append even when a matching row already exists in the tab.'),
    },
  },
  async ({ confirm, project, day, allowDuplicates }) => {
    try {
      if (day !== undefined && !validDay(day)) return fail(`${day} is not a YYYY-MM-DD day`);
      const { sheetId } = requirePushConfig(cfg);
      const approved = await listEntries({
        status: 'approved',
        ...(project ? { projectKey: resolveProject(project).key } : {}),
        ...(day ? { day } : {}),
      });
      if (approved.length === 0) return text('nothing approved to push');

      const byProject = new Map<string, StoredEntry[]>();
      for (const e of approved) {
        const list = byProject.get(e.projectKey);
        if (list) list.push(e);
        else byProject.set(e.projectKey, [e]);
      }

      const lines: string[] = [];
      for (const [projectKey, entries] of byProject) {
        const p = resolveProject(projectKey);
        lines.push(`\n${p.name} → tab "${p.sheetTab}"`);

        // The ceiling must count every hour already in the tab, not just what
        // this machine pushed — the LP connector and other machines add rows too.
        const { rows } = await readTab(sheetId, p.sheetTab);
        const issues = validateEntries(entries, {
          ...(p.contractHours !== undefined
            ? { contractHoursRemaining: p.contractHours - summarize(rows).totalMinutes / 60 }
            : {}),
        });
        const errors = issues.filter((i) => i.severity === 'error');
        for (const i of issues) lines.push(`  ${i.severity}: ${i.message}`);
        if (errors.length) {
          lines.push('  refusing to push this project');
          continue;
        }

        const preview = await previewPush({
          spreadsheetId: sheetId,
          tabTitle: p.sheetTab,
          entries,
        });
        for (const e of entries) {
          const row = toSheetRow(e);
          lines.push(`  ${row.date} | ${row.person} | ${row.hours} | ${row.activity} | ${row.notes}`);
        }
        for (const d of preview.duplicates) lines.push(`  possible duplicate: ${d.message}`);

        if (!confirm) {
          lines.push('  (preview only — call again with confirm=true to write)');
          continue;
        }

        // Claim before the append, after every read. Two agents — and there are
        // now at least two clients able to call this — must not both append the
        // same approved batch to a sheet nobody here can delete from.
        const claim = await claimEntriesForPush(entries.map((e) => e.id));
        if (claim.claimed.length === 0) {
          lines.push(`  another push already holds these ${entries.length} entr(ies) — skipped`);
          continue;
        }
        if (claim.contended.length > 0) {
          lines.push(
            `  ${claim.contended.length} of ${entries.length} entr(ies) are held by another push — appending the other ${claim.claimed.length}`,
          );
        }

        const pushing = claim.claimed;
        const ids = pushing.map((e) => e.id);
        try {
          const result = await pushEntries({
            spreadsheetId: sheetId,
            tabTitle: p.sheetTab,
            entries: pushing,
            ...(allowDuplicates ? { allowDuplicates: true } : {}),
          });
          await markPushed(ids, result.updatedRange);

          // OpenProject write-through. The sheet is the ledger of record, so
          // its append always comes first; the time entries are best-effort —
          // a failure is reported but never fails the push, and PushLog
          // records what landed so a retried push skips only what exists.
          const opLines: string[] = [];
          const openProjectTimeEntries: { entryId: string; timeEntryId: string }[] = [];
          const withTasks = pushing.filter((e) => e.taskId !== undefined);
          if (withTasks.length > 0) {
            const op = cfg.openproject;
            if (op.url === undefined || op.apiKey === undefined) {
              opLines.push(
                '  (OpenProject not configured — sheet rows appended, no OpenProject time entries)',
              );
            } else {
              try {
                // Retry idempotency: entries whose time entries PushLog
                // already records were written by an earlier push, so they are
                // skipped — creating them again would double-log the minutes.
                const prior = await listOpenProjectTimeEntries(ids);
                const todo = withTasks.filter((e) => !prior.has(e.id));
                const skipped = withTasks.length - todo.length;
                for (const e of todo) {
                  if (e.taskId === undefined) continue;
                  try {
                    const te = await createTimeEntry({
                      url: op.url,
                      apiKey: op.apiKey,
                      workPackage: e.taskId,
                      minutes: e.minutes,
                      spentOn: e.day,
                      ...(e.description ? { comment: e.description } : {}),
                    });
                    openProjectTimeEntries.push({ entryId: e.id, timeEntryId: te.id });
                  } catch (err) {
                    // Only prior.has(e.id) skips — a failure means nothing was
                    // written, so the retry must re-attempt the entry.
                    const message = err instanceof Error ? err.message : String(err);
                    opLines.push(
                      `  OpenProject time entry for entry ${e.id.slice(-6)} failed: ${message} — sheet row appended; the retry will re-attempt it`,
                    );
                  }
                }
                opLines.push(
                  todo.length === 0
                    ? '  OpenProject: wrote 0 time entries'
                    : `  OpenProject: wrote ${openProjectTimeEntries.length} time entr${
                        openProjectTimeEntries.length === 1 ? 'y' : 'ies'
                      }` + (skipped > 0 ? `, skipped ${skipped} (already written)` : ''),
                );
              } catch (err) {
                // Defensive: nothing in the write-through may undo a sheet
                // append that already succeeded.
                const message = err instanceof Error ? err.message : String(err);
                opLines.push(
                  `  OpenProject write-through failed: ${message} — sheet rows appended`,
                );
              }
            }
          }

          await logPush({
            projectKey,
            sheetTab: p.sheetTab,
            entryIds: ids,
            minutes: result.minutes,
            ok: true,
            openProjectTimeEntries,
          });
          lines.push(`  appended ${result.rowCount} row(s) at ${result.updatedRange}`);
          lines.push(...opLines);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          // Release first: the entries stay approved, so the next attempt —
          // possibly from the other client — has to be able to claim them.
          await releasePushClaim(claim.owner);
          await logPush({
            projectKey,
            sheetTab: p.sheetTab,
            entryIds: ids,
            minutes: 0,
            ok: false,
            error: message,
          });
          lines.push(`  push failed: ${message}`);
          lines.push('  entries remain approved; the push can be retried');
        }
      }

      return text(lines.join('\n').trim());
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
