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
  type Entry,
} from '@hours/core';
import {
  approveEntries,
  createEntries,
  currentTimer,
  listEntries,
  logPush,
  markPushed,
  pushedHours,
  startTimer,
  stopTimer,
  type StoredEntry,
} from '@hours/lib-db';
import { reconstruct, sweep } from '@hours/collector';
import { previewPush, pushEntries, readTab, summarize } from '@hours/connector-google-sheets';

const cfg = loadConfig();

const server = new McpServer({ name: 'hours', version: '0.1.0' });

function text(body: string) {
  return { content: [{ type: 'text' as const, text: body }] };
}

function fail(message: string) {
  return { content: [{ type: 'text' as const, text: message }], isError: true };
}

/** Resolve a project from an explicit key, or from the calling directory. */
function resolveProject(key?: string, cwd?: string) {
  if (key) {
    const byKey = projectByKey(key, cfg.projects);
    if (byKey) return byKey;
    throw new Error(
      `unknown project "${key}" — known projects: ${cfg.projects.map((p) => p.key).join(', ')}`,
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

function describeEntries(entries: readonly StoredEntry[]): string {
  if (entries.length === 0) return '(none)';
  return entries
    .map(
      (e) =>
        `${e.id.slice(-6)}  ${e.status.padEnd(8)} ${e.day}  ${e.projectKey.padEnd(8)} ` +
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
    lines.push('', `Activities: ${ACTIVITIES.join(', ')}`);
    return text(lines.join('\n'));
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
    const target = day ?? localDayKey(new Date());
    const entries = await listEntries({ day: target });
    const total = entries.reduce((s, e) => s + e.minutes, 0);
    const issues = validateEntries(entries);
    const timer = await currentTimer();

    return text(
      [
        `${target} — ${formatMinutesShort(total)} across ${entries.length} entr${entries.length === 1 ? 'y' : 'ies'}`,
        describeEntries(entries),
        issues.length
          ? `\nvalidation:\n${issues.map((i) => `  ${i.severity}: ${i.message}`).join('\n')}`
          : '',
        timer
          ? `\ntimer running: ${timer.projectKey} ${timer.activity ?? '(no activity)'} since ${timer.startedAt.toISOString()}`
          : '',
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

// --- drafting -------------------------------------------------------------

server.registerTool(
  'log_time',
  {
    title: 'Log time',
    description:
      'Record time already spent as a draft entry. Nothing reaches the spreadsheet until it is approved and pushed.',
    inputSchema: {
      minutes: z.number().int().positive().describe('Duration in minutes. Multiples of 15 match the sheet.'),
      activity: z
        .string()
        .describe(`One of: ${ACTIVITIES.join(', ')}. Shorthands like "dev" or "qa" also resolve.`),
      project: z.string().optional().describe('Project key. Inferred from cwd if omitted.'),
      cwd: z.string().optional().describe('Working directory, used to infer the project.'),
      day: z.string().optional().describe('YYYY-MM-DD. Defaults to today.'),
      note: z.string().optional().describe('Short description for the Notes column.'),
      startClock: z
        .string()
        .optional()
        .describe('Wall-clock start like "9:00" or "1:30 PM", so Notes can show a real range.'),
    },
  },
  async ({ minutes, activity, project, cwd, day, note, startClock }) => {
    try {
      const p = resolveProject(project, cwd);
      const resolved = resolveActivity(activity);
      if (!resolved) {
        return fail(
          `"${activity}" is not a recognizable activity. Use one of: ${ACTIVITIES.join(', ')}`,
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
      'Begin timing work on a project. Starting a timer while one is running stops the old one and discards its time, so check timer_status first.',
    inputSchema: {
      project: z.string().optional().describe('Project key. Inferred from cwd if omitted.'),
      cwd: z.string().optional(),
      activity: z.string().optional().describe('Can also be supplied when stopping.'),
      note: z.string().optional(),
    },
  },
  async ({ project, cwd, activity, note }) => {
    try {
      const p = resolveProject(project, cwd);
      const resolved = activity ? resolveActivity(activity) : null;
      if (activity && !resolved) return fail(`"${activity}" is not a recognizable activity`);

      const { started, replaced } = await startTimer({
        projectKey: p.key,
        ...(resolved ? { activity: resolved } : {}),
        ...(note ? { note } : {}),
      });
      return text(
        [
          `started ${started.projectKey} ${started.activity ?? '(activity at stop time)'} at ${started.startedAt.toISOString()}`,
          replaced
            ? `NOTE: stopped and discarded a running ${replaced.projectKey} timer worth ${formatMinutesShort(replaced.minutes)} — log it manually if it mattered`
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
    description: 'Stop the running timer and turn its elapsed time into a draft entry.',
    inputSchema: {
      activity: z.string().optional().describe('Required unless the timer was started with one.'),
      note: z.string().optional(),
    },
  },
  async ({ activity, note }) => {
    const open = await currentTimer();
    if (!open) return text('no timer running');

    const stopped = await stopTimer();
    if (!stopped) return text('no timer running');

    const activityRaw = activity ?? stopped.activity;
    if (!activityRaw) {
      return fail(
        `the timer had no activity, so nothing was logged. Its ${formatMinutesShort(stopped.minutes)} is not saved — call log_time with an activity to record it.`,
      );
    }
    const resolved = resolveActivity(activityRaw);
    if (!resolved) return fail(`"${activityRaw}" is not a recognizable activity`);
    if (!cfg.person) return fail('HOURS_PERSON is not set');

    const startMin = stopped.startedAt.getHours() * 60 + stopped.startedAt.getMinutes();
    const entry: Entry = {
      day: localDayKey(stopped.startedAt),
      person: cfg.person,
      projectKey: stopped.projectKey,
      minutes: stopped.minutes,
      activity: resolved,
      ranges: [{ startMin, endMin: startMin + stopped.minutes }],
      status: 'draft',
      provenance: 'timer via MCP',
    };
    const description = note ?? stopped.note;
    if (description) entry.description = description;

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
    description: 'Whether a timer is running, on what, and for how long.',
    inputSchema: {},
  },
  async () => {
    const open = await currentTimer();
    if (!open) return text('no timer running');
    const mins = Math.round((Date.now() - open.startedAt.getTime()) / 60_000);
    return text(
      `${open.projectKey} ${open.activity ?? '(no activity yet)'} — ${formatMinutesShort(mins)} so far, since ${open.startedAt.toISOString()}`,
    );
  },
);

// --- reconstruction -------------------------------------------------------

server.registerTool(
  'reconstruct_day',
  {
    title: 'Reconstruct a day from activity',
    description:
      'Sweep git commits and Claude Code sessions, infer blocks of work, and write them as draft entries with the reasoning attached. Safe to re-run — signals already folded in are not counted twice.',
    inputSchema: {
      day: z.string().optional().describe('YYYY-MM-DD. Defaults to today.'),
      dryRun: z.boolean().optional().describe('Report what would be drafted without writing.'),
      collect: z.boolean().optional().describe('Sweep for new signals first. Defaults to true.'),
    },
  },
  async ({ day, dryRun, collect }) => {
    try {
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
    let ids = entryIds;
    if (!ids || ids.length === 0) {
      const target = day ?? localDayKey(new Date());
      const drafts = await listEntries({ day: target, status: 'draft' });
      if (drafts.length === 0) return text(`no drafts to approve on ${target}`);
      ids = drafts.map((d) => d.id);
    } else {
      // Accept the short ids shown in other tools' output.
      const all = await listEntries({});
      ids = ids.map((wanted) => all.find((e) => e.id === wanted || e.id.endsWith(wanted))?.id ?? wanted);
    }

    const count = await approveEntries(ids);
    return text(`approved ${count} entr${count === 1 ? 'y' : 'ies'}`);
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

        const issues = validateEntries(entries, {
          ...(p.contractHours !== undefined
            ? { contractHoursRemaining: p.contractHours - (await pushedHours(projectKey)) }
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

        const ids = entries.map((e) => e.id);
        try {
          const result = await pushEntries({
            spreadsheetId: sheetId,
            tabTitle: p.sheetTab,
            entries,
            ...(allowDuplicates ? { allowDuplicates: true } : {}),
          });
          await markPushed(ids, result.updatedRange);
          await logPush({
            projectKey,
            sheetTab: p.sheetTab,
            entryIds: ids,
            minutes: result.minutes,
            ok: true,
          });
          lines.push(`  appended ${result.rowCount} row(s) at ${result.updatedRange}`);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
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
