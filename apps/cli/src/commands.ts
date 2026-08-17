// ---------------------------------------------------------------------------
// CLI commands.
//
// Every command that changes shared state (`push`) prints exactly what it will
// do and requires either a TTY confirmation or an explicit --yes. Every command
// that only touches the local store acts immediately — the local store is
// yours, and friction there is what makes people stop logging hours.
// ---------------------------------------------------------------------------

import { createInterface } from 'node:readline/promises';
import { loadConfig, requirePushConfig, type HoursConfig } from '@hours/config';
import {
  collectNotes,
  formatClock,
  formatMinutesShort,
  localDayKey,
  projectByKey,
  resolveActivity,
  toSheetRow,
  validateEntries,
  activityListText,
  activityParamText,
  type Activity,
  type Entry,
  type ProjectDef,
} from '@hours/core';
import {
  approveEntries,
  claimEntriesForPush,
  createEntries,
  openTimers,
  resolveTimerTarget,
  cancelTimer,
  deleteEntry,
  getEntry,
  getTask,
  listEntries,
  listOpenProjectTimeEntries,
  listTaskMinutes,
  listTasks,
  loadSignals,
  logPush,
  markPushed,
  pushedHours,
  releasePushClaim,
  startTimer,
  stopTimer,
  unapproveEntries,
  updateEntry,
  upsertTasks,
  type StoredEntry,
  type TaskMinutes,
} from '@hours/lib-db';
import { reconstruct, sweep } from '@hours/collector';
import { previewPush, pushEntries, readTab, summarize } from '@hours/connector-google-sheets';
import { createTimeEntry, getWorkPackage, listTimeEntries } from '@hours/connector-openproject';
import { flagBool, flagString, parseDayArg, parseMinutesArg, type ParsedArgs } from './args.js';
import { bold, cyan, dim, green, red, renderEntries, renderTable, renderTotals, shortId, yellow } from './format.js';

function requireProject(key: string | undefined, cfg = loadConfig()): ProjectDef {
  if (!key) {
    throw new Error(
      `--project is required (one of: ${cfg.projects.map((p) => p.key).join(', ')})`,
    );
  }
  const project = projectByKey(key, cfg.projects);
  if (!project) {
    throw new Error(
      `unknown project "${key}" (known: ${cfg.projects.map((p) => p.key).join(', ')})`,
    );
  }
  return project;
}

function requireActivity(raw: string | undefined): Activity {
  if (!raw) throw new Error('an activity is required');
  const activity = resolveActivity(raw);
  if (!activity) {
    throw new Error(
      `"${raw}" is not a recognizable activity — it must resolve to one of the sheet's values:\n${activityListText()}`,
    );
  }
  return activity;
}

export async function cmdActivities(): Promise<void> {
  console.log(
    `${activityParamText()}\n\nShorthands and unique prefixes also resolve ("dev", "qa", "wire").`,
  );
}

/**
 * Read a task id from a CLI argument: a positive integer like "136", or null
 * when absent or not one. Zero and negatives are never task ids.
 */
function taskIdFrom(raw: string | undefined): string | null {
  if (!raw) return null;
  if (!/^\d+$/.test(raw) || Number(raw) <= 0) return null;
  return raw;
}

/** Resolve a short id suffix to a single entry, refusing on ambiguity. */
async function resolveEntry(idish: string): Promise<StoredEntry> {
  const exact = await getEntry(idish);
  if (exact) return exact;
  const all = await listEntries({});
  const matches = all.filter((e) => e.id.endsWith(idish));
  if (matches.length === 1) return matches[0] as StoredEntry;
  if (matches.length === 0) throw new Error(`no entry matching "${idish}"`);
  throw new Error(
    `"${idish}" matches ${matches.length} entries (${matches.map((m) => shortId(m.id)).join(', ')})`,
  );
}

async function confirm(question: string, assumeYes: boolean): Promise<boolean> {
  if (assumeYes) return true;
  if (!process.stdin.isTTY) {
    throw new Error('not a terminal — re-run with --yes to confirm non-interactively');
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(`${question} [y/N] `);
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

/**
 * The 3 PM habit: before approving, offer to write the brief "what did you
 * do?" note on every entry that has none. Only runs on a real terminal —
 * scripts and pipelines approve silently, and the MCP server goes through
 * edit_entry instead. Enter skips, so a day of heavy work approves quickly.
 */
async function askMissingNotes(entries: readonly StoredEntry[]): Promise<void> {
  if (!process.stdin.isTTY) return;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const patches = await collectNotes(entries, async (e) => {
      const answer = await rl.question(
        `  note for ${shortId(e.id)} (${e.activity}, ${formatMinutesShort(e.minutes)})? [Enter to skip] `,
      );
      return answer;
    });
    for (const p of patches) {
      await updateEntry(p.id, { description: p.description });
    }
    if (patches.length > 0) console.log(dim(`wrote ${patches.length} note${patches.length === 1 ? '' : 's'}`));
  } finally {
    rl.close();
  }
}

// --- log ------------------------------------------------------------------

export async function cmdLog(args: ParsedArgs): Promise<void> {
  const cfg = loadConfig();
  const [durationRaw, activityRaw] = args.positionals;

  const minutes = durationRaw ? parseMinutesArg(durationRaw) : null;
  if (minutes === null) {
    throw new Error('usage: hours log <duration> <activity> --project <key> [--day <day>] [--note "..."] [--task <id>]');
  }
  if (minutes <= 0) throw new Error('duration must be positive');

  const activity = requireActivity(activityRaw ?? flagString(args.flags, 'activity'));
  const project = requireProject(flagString(args.flags, 'project'), cfg);
  const day = parseDayArg(flagString(args.flags, 'day'));
  const person = flagString(args.flags, 'person') ?? cfg.person;
  if (!person) throw new Error('HOURS_PERSON is not set and --person was not given');

  const entry: Entry = {
    day,
    person,
    projectKey: project.key,
    minutes,
    activity,
    // A manual log has no clock range unless you give one — the sheet's Notes
    // column tolerates a bare description, and inventing a range would be a lie.
    ranges: [],
    status: 'draft',
  };
  const note = flagString(args.flags, 'note');
  if (note) entry.description = note;

  const taskRaw = flagString(args.flags, 'task');
  if (taskRaw !== undefined) {
    const taskId = taskIdFrom(taskRaw);
    if (taskId === null) {
      throw new Error(`"${taskRaw}" is not a task id — use a positive integer like "136"`);
    }
    // A ref to a task the cache has never seen is refused, not guessed — the
    // attachment must not be invented for a task nothing ever synced.
    if ((await getTask(taskId)) === null) {
      throw new Error(
        `task #${taskId} is not in the local cache — run \`hours task ${taskId} --refresh\` to cache it first, or wait for the next sweep`,
      );
    }
    entry.taskId = taskId;
  }

  const [created] = await createEntries([entry]);
  console.log(green('logged'), renderEntries(created ? [created] : []));
}

// --- timers ---------------------------------------------------------------

export async function cmdStart(args: ParsedArgs): Promise<void> {
  const cfg = loadConfig();
  const project = requireProject(flagString(args.flags, 'project') ?? args.positionals[0], cfg);
  const activityRaw = flagString(args.flags, 'activity') ?? args.positionals[1];
  const activity = activityRaw ? requireActivity(activityRaw) : undefined;
  const note = flagString(args.flags, 'note');

  const { started, replaced, concurrent } = await startTimer({
    projectKey: project.key,
    ...(activity ? { activity } : {}),
    ...(note ? { note } : {}),
  });

  if (replaced) {
    console.log(
      yellow(
        `stopped the previous ${replaced.projectKey} timer first: ${replaced.activity ?? '(no activity)'} — ${formatMinutesShort(replaced.minutes)} discarded`,
      ),
    );
    console.log(dim('  (that time was not saved; log it with `hours log` if it mattered)'));
  }
  console.log(
    green('started'),
    `${started.projectKey} ${started.activity ?? dim('(activity at stop time)')} at ${formatClock(started.startedAt.getHours() * 60 + started.startedAt.getMinutes())}`,
  );

  // Said at the start, not at the push: from here on both timers accumulate the
  // same wall-clock minutes, and each will log all of them to its own contract.
  for (const other of concurrent) {
    const mins = Math.round((Date.now() - other.startedAt.getTime()) / 60_000);
    console.log(
      yellow(
        `also running: ${other.projectKey} ${other.activity ?? '(no activity yet)'} — ${formatMinutesShort(mins)} so far`,
      ),
    );
  }
  if (concurrent.length) {
    console.log(
      dim(
        '  (both timers now cover the same minutes — stop one, or expect to trim the overlap at review)',
      ),
    );
  }
}

export async function cmdStop(args: ParsedArgs): Promise<void> {
  const cfg = loadConfig();
  const all = await openTimers();

  // With timers running on several projects the target must be named — see
  // resolveTimerTarget. Resolved here rather than inside stopTimer so the
  // activity check below still happens before anything is finalized.
  const projectRaw = flagString(args.flags, 'project');
  const target = resolveTimerTarget(
    all,
    projectRaw ? requireProject(projectRaw, cfg).key : undefined,
  );
  if (!target) {
    console.log(
      projectRaw
        ? yellow(`no timer running on ${requireProject(projectRaw, cfg).key}`)
        : dim('no timer running'),
    );
    return;
  }

  // Decide whether an activity exists BEFORE stopping: stopTimer finalizes the
  // timer, and an error thrown after that would leave the time unrecoverable.
  const activityRaw = flagString(args.flags, 'activity') ?? args.positionals[0] ?? target.activity;
  if (!activityRaw) {
    throw new Error(
      `the ${target.projectKey} timer has no activity — re-run as \`hours stop <activity>\`. The timer is still running and that will log it.`,
    );
  }
  const activity = requireActivity(activityRaw);

  const stopped = await stopTimer({ projectKey: target.projectKey });
  if (!stopped) return;

  const person = flagString(args.flags, 'person') ?? cfg.person;
  if (!person) throw new Error('HOURS_PERSON is not set and --person was not given');

  const startMin = stopped.startedAt.getHours() * 60 + stopped.startedAt.getMinutes();
  const entry: Entry = {
    day: localDayKey(stopped.startedAt),
    person,
    projectKey: stopped.projectKey,
    minutes: stopped.minutes,
    activity,
    // Not clamped at midnight: formatClock wraps, so a 23:00 timer stopped
    // after 90 minutes reads "11:00 PM - 12:30 AM", which is what happened.
    // Clamping to 1440 rendered it as "11:00 PM - 12:00 AM" — a range whose
    // length contradicts the Hours column.
    ranges: [{ startMin, endMin: startMin + stopped.minutes }],
    status: 'draft',
    provenance: 'timer',
  };
  const note = flagString(args.flags, 'note') ?? stopped.note;
  if (note) entry.description = note;
  // The timer carries its taskId forward, the same as the MCP stop — a task
  // attachment belongs to the work, not to the surface the timer stopped from.
  if (stopped.taskId) entry.taskId = stopped.taskId;

  const [created] = await createEntries([entry]);
  console.log(green(`stopped after ${formatMinutesShort(stopped.minutes)}`));
  console.log(renderEntries(created ? [created] : []));
}

export async function cmdCancel(args: ParsedArgs): Promise<void> {
  const projectRaw = flagString(args.flags, 'project');
  const projectKey = projectRaw ? requireProject(projectRaw, loadConfig()).key : undefined;
  const cancelled = await cancelTimer(projectKey ? { projectKey } : {});
  console.log(
    cancelled
      ? yellow(`cancelled the ${cancelled.projectKey} timer — nothing logged`)
      : dim(projectKey ? `no timer running on ${projectKey}` : 'no timer running'),
  );
}

export async function cmdStatus(): Promise<void> {
  const cfg = loadConfig();
  const all = await openTimers();
  const today = localDayKey(new Date());
  const entries = await listEntries({ day: today });

  for (const open of all) {
    const mins = Math.round((Date.now() - open.startedAt.getTime()) / 60_000);
    console.log(
      cyan('running'),
      `${open.projectKey} ${open.activity ?? dim('(no activity yet)')} — ${formatMinutesShort(mins)} so far`,
    );
  }
  if (all.length === 0) console.log(dim('no timer running'));

  console.log(`\n${bold(today)}`);
  console.log(renderEntries(entries));
  if (entries.length) console.log(`\n${renderTotals(entries)}`);

  const pending = await loadSignals({ day: today, unconsumedOnly: true });
  if (pending.length) {
    console.log(
      dim(`\n${pending.length} uncounted signal(s) for today — run \`hours reconstruct\` to draft them`),
    );
  }
  if (!cfg.person) console.log(yellow('\nHOURS_PERSON is not set; set it before pushing'));
}

// --- collect / reconstruct ------------------------------------------------

export async function cmdCollect(args: ParsedArgs): Promise<void> {
  const days = Number(flagString(args.flags, 'days') ?? 3);
  const result = await sweep({ since: new Date(Date.now() - days * 86_400_000) });
  console.log(
    `scanned ${result.scanned} signal(s) over ${days} day(s), ${green(`${result.recorded} new`)}`,
  );
  for (const [source, n] of Object.entries(result.bySource)) {
    if (n > 0) console.log(dim(`  ${source}: ${n}`));
  }
  // Also apart from the counts: these are signals seen on an earlier sweep whose
  // turn was still running, now measured longer. Nothing new was observed.
  if (result.spansAdvanced > 0) {
    console.log(dim(`  measured spans extended: ${result.spansAdvanced}`));
  }
  // Reported apart from the signal counts above — cached tasks are not evidence
  // of work, they are the registry the evidence gets attributed against.
  if (result.tasksSynced > 0) console.log(dim(`  openproject tasks cached: ${result.tasksSynced}`));
  for (const w of result.warnings) console.log(yellow(`  warning: ${w}`));
}

export async function cmdReconstruct(args: ParsedArgs): Promise<void> {
  const day = parseDayArg(flagString(args.flags, 'day') ?? args.positionals[0]);
  const dryRun = flagBool(args.flags, 'dry-run');

  if (!flagBool(args.flags, 'no-collect')) {
    const result = await sweep({ since: new Date(`${day}T00:00:00`) });
    if (result.recorded) console.log(dim(`collected ${result.recorded} new signal(s) first`));
  }

  const out = await reconstruct({ day, dryRun });
  console.log(`${bold(day)} — read ${out.signalsRead} signal(s)`);

  if (dryRun) {
    console.log(yellow('dry run — nothing was written'));
  } else if (out.created.length === 0) {
    console.log(dim('  no new blocks to draft'));
  } else {
    console.log(renderEntries(out.created, { showProvenance: true }));
    console.log(`\n${renderTotals(out.created)}`);
  }

  if (out.unattributed.length) {
    console.log(
      yellow(`\n${out.unattributed.length} block(s) could not be attributed to a project:`),
    );
    for (const b of out.unattributed) {
      console.log(
        `  ${formatMinutesShort(b.minutes)} ${b.activity} — ${b.subjects[0] ?? dim('no subject')}`,
      );
    }
    console.log(
      dim('  these came from work outside a watched repo; log them with `hours log` if they count'),
    );
  }

  console.log(dim('\nreview with `hours review`, then `hours approve <id>` and `hours push`'));
}

// --- review ---------------------------------------------------------------

export async function cmdReview(args: ParsedArgs): Promise<void> {
  const day = flagString(args.flags, 'day');
  const project = flagString(args.flags, 'project');
  const all = flagBool(args.flags, 'all');

  const entries = await listEntries({
    ...(day ? { day: parseDayArg(day) } : {}),
    ...(project ? { projectKey: requireProject(project).key } : {}),
    ...(all ? {} : { status: ['draft', 'approved'] as const }),
  });

  if (entries.length === 0) {
    console.log(dim('nothing to review'));
    return;
  }

  console.log(renderEntries(entries, { showProvenance: true }));
  console.log(`\n${renderTotals(entries)}`);

  const issues = validateEntries(entries);
  if (issues.length) {
    console.log('');
    for (const i of issues) {
      console.log(i.severity === 'error' ? red(`error: ${i.message}`) : yellow(`warn:  ${i.message}`));
    }
  }
}

export async function cmdEdit(args: ParsedArgs): Promise<void> {
  const [idish] = args.positionals;
  if (!idish) throw new Error('usage: hours edit <id> [--minutes 90] [--activity dev] [--note "..."] [--day today] [--project lp]');

  const entry = await resolveEntry(idish);
  const patch: Parameters<typeof updateEntry>[1] = {};

  const minutesRaw = flagString(args.flags, 'minutes') ?? flagString(args.flags, 'duration');
  if (minutesRaw) {
    const m = parseMinutesArg(minutesRaw);
    if (m === null || m <= 0) throw new Error(`cannot read "${minutesRaw}" as a positive duration`);
    patch.minutes = m;
    // Keep the clock range consistent with the new length, anchored at the
    // original start — otherwise Notes would contradict the Hours column.
    const first = entry.ranges[0];
    if (first) patch.ranges = [{ startMin: first.startMin, endMin: first.startMin + m }];
  }

  const activityRaw = flagString(args.flags, 'activity');
  if (activityRaw) patch.activity = requireActivity(activityRaw);

  const note = flagString(args.flags, 'note');
  if (note !== undefined) patch.description = note;

  const dayRaw = flagString(args.flags, 'day');
  if (dayRaw) patch.day = parseDayArg(dayRaw);

  const projectRaw = flagString(args.flags, 'project');
  if (projectRaw) patch.projectKey = requireProject(projectRaw).key;

  if (Object.keys(patch).length === 0) throw new Error('nothing to change');

  const updated = await updateEntry(entry.id, patch);
  console.log(green('updated'));
  console.log(renderEntries([updated]));
}

export async function cmdApprove(args: ParsedArgs): Promise<void> {
  const targets = await targetsFor(args);
  if (!flagBool(args.flags, 'no-prompt')) {
    await askMissingNotes(targets);
  }
  const count = await approveEntries(targets.map((t) => t.id));
  console.log(green(`approved ${count} entr${count === 1 ? 'y' : 'ies'}`));
  if (count < targets.length) {
    console.log(dim(`  (${targets.length - count} were already approved or pushed)`));
  }
}

export async function cmdUnapprove(args: ParsedArgs): Promise<void> {
  const targets = await targetsFor(args);
  const count = await unapproveEntries(targets.map((t) => t.id));
  console.log(green(`returned ${count} entr${count === 1 ? 'y' : 'ies'} to draft`));
}

export async function cmdDrop(args: ParsedArgs): Promise<void> {
  const [idish] = args.positionals;
  if (!idish) throw new Error('usage: hours drop <id>');
  const entry = await resolveEntry(idish);
  const deleted = await deleteEntry(entry.id);
  console.log(yellow(`dropped ${shortId(deleted.id)} — ${formatMinutesShort(deleted.minutes)} ${deleted.activity}`));
}

/** Entries an approve/unapprove applies to: explicit ids, or a whole day. */
async function targetsFor(args: ParsedArgs): Promise<StoredEntry[]> {
  if (args.positionals.length > 0) {
    return Promise.all(args.positionals.map((p) => resolveEntry(p)));
  }
  const dayRaw = flagString(args.flags, 'day');
  if (!dayRaw && !flagBool(args.flags, 'all')) {
    throw new Error('give one or more ids, or --day <day>, or --all');
  }
  return listEntries({
    ...(dayRaw ? { day: parseDayArg(dayRaw) } : {}),
    status: ['draft', 'approved'] as const,
  });
}

// --- push -----------------------------------------------------------------

/**
 * Best-effort OpenProject write-through for one project batch, run only after
 * the sheet append succeeded. Mirrors every task-ref'd entry as an OpenProject
 * time entry for the same task, day, and minutes. Never throws — a per-entry
 * failure is reported and the sheet push stands; the PushLog carries the
 * created time-entry ids so a retried push skips what already landed.
 */
async function writeOpenProjectTimeEntries(
  cfg: HoursConfig,
  entries: readonly StoredEntry[],
): Promise<{ entryId: string; timeEntryId: string }[]> {
  const op = cfg.openproject;
  if (!op.url || !op.apiKey) {
    console.log(dim('  (OpenProject not configured — sheet rows appended, no OpenProject time entries)'));
    return [];
  }

  const withTask = entries.filter((e): e is StoredEntry & { taskId: string } => e.taskId !== undefined);

  // Reading the prior time entries is the one step here that can throw for a
  // reason unrelated to OpenProject — a malformed openProjectTimeEntries blob
  // in any earlier PushLog row, or a store error. It runs after the sheet
  // append has already succeeded, so letting it escape would make cmdPush log
  // a real push as failed. Degrade instead: without the prior set we cannot
  // prove what already landed, so write nothing rather than risk double-logging.
  let prior: ReadonlyMap<string, string>;
  try {
    prior = await listOpenProjectTimeEntries(entries.map((e) => e.id));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.log(
      yellow(
        `  OpenProject write-through skipped: could not read prior time entries (${message}) — sheet rows appended`,
      ),
    );
    return [];
  }

  const todo = withTask.filter((e) => !prior.has(e.id));
  const skipped = withTask.length - todo.length;

  const written: { entryId: string; timeEntryId: string }[] = [];
  for (const e of todo) {
    try {
      const te = await createTimeEntry({
        url: op.url,
        apiKey: op.apiKey,
        workPackage: e.taskId,
        minutes: e.minutes,
        spentOn: e.day,
        ...(e.description ? { comment: e.description } : {}),
      });
      written.push({ entryId: e.id, timeEntryId: te.id });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.log(
        yellow(
          `  OpenProject time entry for ${shortId(e.id)} failed: ${message} — sheet row appended; a retry will re-attempt it`,
        ),
      );
    }
  }

  const parts = [`wrote ${written.length} time entr${written.length === 1 ? 'y' : 'ies'}`];
  if (skipped > 0) parts.push(`skipped ${skipped} (already written)`);
  console.log(dim(`  OpenProject: ${parts.join(', ')}`));

  return written;
}

export async function cmdPush(args: ParsedArgs): Promise<void> {
  const cfg = loadConfig();
  const { sheetId } = requirePushConfig(cfg);
  const dryRun = flagBool(args.flags, 'dry-run');
  const assumeYes = flagBool(args.flags, 'yes');
  const allowDuplicates = flagBool(args.flags, 'allow-duplicates');

  const projectFilter = flagString(args.flags, 'project');
  const dayFilter = flagString(args.flags, 'day');

  const approved = await listEntries({
    status: 'approved',
    ...(projectFilter ? { projectKey: requireProject(projectFilter, cfg).key } : {}),
    ...(dayFilter ? { day: parseDayArg(dayFilter) } : {}),
  });

  if (approved.length === 0) {
    console.log(dim('nothing approved to push — run `hours approve` first'));
    return;
  }

  // One append per tab. Grouping matters: a push must never interleave two
  // projects' rows into one tab.
  const byProject = new Map<string, StoredEntry[]>();
  for (const e of approved) {
    const list = byProject.get(e.projectKey);
    if (list) list.push(e);
    else byProject.set(e.projectKey, [e]);
  }

  for (const [projectKey, entries] of byProject) {
    const project = requireProject(projectKey, cfg);
    console.log(`\n${bold(project.name)} → tab ${cyan(project.sheetTab)}`);

    // One try around every sheet read for this project. A tab with an
    // unreadable header, a 403, or a dropped connection must cost this project
    // and no other — before, the ceiling read sat outside and took the whole
    // push down with it.
    let preview;
    try {
      const tab = await readTab(sheetId, project.sheetTab);
      const used = summarize(tab.rows).totalMinutes / 60;
      const issues = validateEntries(entries, {
        ...(project.contractHours !== undefined
          ? { contractHoursRemaining: project.contractHours - used }
          : {}),
      });
      const errors = issues.filter((i) => i.severity === 'error');
      if (errors.length) {
        for (const e of errors) console.log(red(`  error: ${e.message}`));
        console.log(red('  refusing to push this project'));
        continue;
      }
      for (const w of issues) console.log(yellow(`  warn: ${w.message}`));

      // The tab just read is handed to the preview so the ceiling check does
      // not cost an extra round trip; the append re-reads it for itself.
      preview = await previewPush({ spreadsheetId: sheetId, tabTitle: project.sheetTab, entries, tab });
    } catch (err) {
      console.log(red(`  ${err instanceof Error ? err.message : String(err)}`));
      continue;
    }

    console.log(dim(`  header row ${preview.layout.headerRow}, "${preview.layout.activityHeader}" column`));
    console.log(dim(`  appends at row ${preview.lastRealRow + 1}, below the last logged row`));
    for (const e of entries) {
      const row = toSheetRow(e);
      console.log(`  ${row.date}  ${row.person}  ${row.hours}  ${row.activity}  ${dim(row.notes)}`);
    }
    for (const [date, mins] of preview.existingByDay) {
      if (mins > 0) {
        console.log(dim(`  (the tab already has ${formatMinutesShort(mins)} for you on ${date})`));
      }
    }
    for (const d of preview.duplicates) console.log(yellow(`  possible duplicate: ${d.message}`));

    if (dryRun) {
      console.log(yellow('  dry run — nothing written'));
      continue;
    }

    const ok = await confirm(
      `  append ${entries.length} row(s) (${formatMinutesShort(preview.minutes)}) to "${project.sheetTab}"?`,
      assumeYes,
    );
    if (!ok) {
      console.log(dim('  skipped'));
      continue;
    }

    // Claim the entries between the confirmation and the append. Everything
    // above this line is a read; from here on the rows are ours alone, so a
    // second agent pushing the same batch cannot append it twice.
    const claim = await claimEntriesForPush(entries.map((e) => e.id));
    if (claim.claimed.length === 0) {
      console.log(yellow(`  another push already has these ${entries.length} entr(ies) — skipped`));
      continue;
    }
    if (claim.contended.length > 0) {
      console.log(
        yellow(
          `  ${claim.contended.length} of ${entries.length} entr(ies) are held by another push — appending the other ${claim.claimed.length}`,
        ),
      );
    }

    const pushing = claim.claimed;
    const ids = pushing.map((e) => e.id);
    try {
      const result = await pushEntries({
        spreadsheetId: sheetId,
        tabTitle: project.sheetTab,
        entries: pushing,
        allowDuplicates,
      });
      await markPushed(ids, result.updatedRange);
      console.log(green(`  appended ${result.rowCount} row(s) at ${result.updatedRange}`));
      const written = await writeOpenProjectTimeEntries(cfg, pushing);
      await logPush({
        projectKey,
        sheetTab: project.sheetTab,
        entryIds: ids,
        minutes: result.minutes,
        ok: true,
        openProjectTimeEntries: written,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Hand the claim back before reporting: the entries stay approved, so a
      // re-run — from here or from another agent — must be able to take them.
      await releasePushClaim(claim.owner);
      await logPush({
        projectKey,
        sheetTab: project.sheetTab,
        entryIds: ids,
        minutes: 0,
        ok: false,
        error: message,
      });
      // Entries stay approved, so a fixed credential or a shared sheet means a
      // plain re-run picks up exactly where this left off.
      console.log(red(`  push failed: ${message}`));
      console.log(dim('  entries remain approved; re-run `hours push` once the cause is fixed'));
    }
  }
}

// --- sheet-side views -----------------------------------------------------

export async function cmdSheet(args: ParsedArgs): Promise<void> {
  const cfg = loadConfig();
  const { sheetId } = requirePushConfig(cfg);
  const project = requireProject(flagString(args.flags, 'project') ?? args.positionals[0], cfg);

  const { layout, rows } = await readTab(sheetId, project.sheetTab);
  const totals = summarize(rows);

  console.log(`${bold(project.sheetTab)} — ${rows.length} rows, header on row ${layout.headerRow}`);
  console.log(`${bold('total')} ${formatMinutesShort(totals.totalMinutes)}`);

  if (project.contractHours !== undefined) {
    const used = totals.totalMinutes / 60;
    const left = project.contractHours - used;
    console.log(
      `${bold('contract')} ${used.toFixed(2)}h of ${project.contractHours}h — ` +
        (left < 0 ? red(`${Math.abs(left).toFixed(2)}h over`) : `${left.toFixed(2)}h left`),
    );
  }

  const person = flagString(args.flags, 'person') ?? cfg.person;
  if (person) {
    const mine = [...totals.byPerson.entries()].find(
      ([k]) => k.toLowerCase() === person.toLowerCase(),
    );
    console.log(`${bold(person)} ${formatMinutesShort(mine?.[1] ?? 0)}`);
  }

  console.log(`\n${dim('by activity')}`);
  for (const [activity, mins] of [...totals.byActivity.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${activity || dim('(blank)')}  ${formatMinutesShort(mins)}`);
  }

  if (totals.unparsedRows.length) {
    console.log(yellow(`\nunparsable Hours in rows: ${totals.unparsedRows.join(', ')}`));
  }
}

export async function cmdProjects(): Promise<void> {
  const cfg = loadConfig();
  for (const p of cfg.projects) {
    const logged = await pushedHours(p.key);
    console.log(
      `${bold(p.key)}  ${p.name}  → tab ${cyan(p.sheetTab)}  ` +
        `${logged.toFixed(2)}h pushed from here` +
        (p.contractHours !== undefined ? dim(`  (contract ${p.contractHours}h)`) : ''),
    );
    for (const repo of p.repoPaths) console.log(dim(`    watching ${repo}`));
  }
}

// --- task hours -----------------------------------------------------------

export async function cmdTask(args: ParsedArgs): Promise<void> {
  const raw = args.positionals[0];
  if (raw === undefined) throw new Error('usage: hours task <id> [--refresh]');
  const id = taskIdFrom(raw);
  if (id === null) {
    throw new Error(`"${raw}" is not a task id — use a positive integer like "136"`);
  }

  const cfg = loadConfig();
  const refresh = flagBool(args.flags, 'refresh');

  let task = await getTask(id);
  const op = cfg.openproject;
  let note = '';
  let warnNote = false;
  let refreshed = false;
  let opMinutes: number | null = null;
  let opEntryCount = 0;

  if (op.url === undefined || op.apiKey === undefined) {
    if (task === null) {
      throw new Error(
        `task #${id} has no hours attached locally, and OpenProject is not configured ` +
          '(OPENPROJECT_URL/OPENPROJECT_API_KEY) — nothing to report',
      );
    }
    note = 'OpenProject not configured (OPENPROJECT_URL/OPENPROJECT_API_KEY) — cached only';
  } else if (refresh || task === null) {
    try {
      const [wp, timeEntries] = await Promise.all([
        getWorkPackage({ url: op.url, apiKey: op.apiKey, id }),
        listTimeEntries({ url: op.url, apiKey: op.apiKey, workPackage: id }),
      ]);

      let projectKey = task?.projectKey ?? id;
      if (task === null) {
        // The registry maps hours keys → OpenProject identifiers, and that
        // direction cannot be inverted from the work package alone. One
        // mapped project is unambiguous; more than one would be a guess, so
        // the task is cached under its raw id instead (slice 3 attribution
        // refines this).
        const mapped = Object.entries(op.projects ?? {});
        if (mapped.length === 1) projectKey = mapped[0]?.[0] ?? id;
        else if (mapped.length > 1) note = 'project unknown — cached under the raw id';
      }

      task =
        (
          await upsertTasks([
            {
              id,
              projectKey,
              subject: wp.subject,
              ...(wp.status !== null ? { status: wp.status } : {}),
              ...(wp.spentMinutes !== null ? { spentMinutes: wp.spentMinutes } : {}),
              ...(wp.estimatedMinutes !== null ? { estimatedMinutes: wp.estimatedMinutes } : {}),
            },
          ])
        )[0] ?? null;
      refreshed = true;
      opMinutes = timeEntries.totalMinutes;
      opEntryCount = timeEntries.entries.length;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // A failed refresh still answers from the cache — but only when there
      // is a cache to answer from.
      if (task === null) throw new Error(message, { cause: err });
      warnNote = true;
      note = `OpenProject unreachable: ${message}`;
    }
  } else {
    note = '(cached — pass --refresh to re-check OpenProject)';
  }

  if (task === null) {
    throw new Error(`task #${id} is not in the local cache and could not be fetched`);
  }

  const local = (await listTaskMinutes()).find((m) => m.taskId === id);
  // Approved is sheet-bound but not yet appended, so it folds into the pushed
  // bucket — the count and the mention keep it visible.
  const pushed = (local?.pushedMinutes ?? 0) + (local?.approvedMinutes ?? 0);
  const drafts = local?.draftMinutes ?? 0;
  // The union rule from the design doc: either ledger having hours makes the
  // task "covered", but the two are never summed in one number.
  const opSide = refreshed ? opMinutes ?? 0 : task.spentMinutes ?? 0;
  const attached = opSide > 0 || pushed + drafts > 0;

  console.log(
    `task #${id} "${task.subject}" (${task.projectKey}${task.status ? `, ${task.status}` : ''})`,
  );
  console.log(`attached: ${attached ? green('yes') : dim('no')}`);

  if (refreshed) {
    // Fresh totals win: the cache may be stale, the time-entry list is not.
    console.log(
      `  OpenProject: ${formatMinutesShort(opMinutes ?? 0)} (${opEntryCount} time entr${
        opEntryCount === 1 ? 'y' : 'ies'
      })`,
    );
  } else if (task.spentMinutes !== null) {
    // Cached without a refresh — the cache holds no entry count, only the sum.
    console.log(`  OpenProject: ${formatMinutesShort(task.spentMinutes)}`);
  }

  const localParts: string[] = [];
  if (pushed > 0) {
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
  if (localParts.length) console.log(`  local sheet: ${localParts.join(' + ')}`);
  if (note) console.log(`\n${warnNote ? yellow(note) : dim(note)}`);
}

export async function cmdTasks(args: ParsedArgs): Promise<void> {
  const cfg = loadConfig();
  const projectRaw = flagString(args.flags, 'project');
  const project = projectRaw ? requireProject(projectRaw, cfg) : null;

  const [tasks, minutes] = await Promise.all([
    listTasks(project ? { projectKey: project.key } : {}),
    listTaskMinutes(),
  ]);
  const byTask = new Map<string, TaskMinutes>();
  for (const m of minutes) byTask.set(m.taskId, m);

  const rows: string[][] = [];
  for (const t of tasks) {
    const local = byTask.get(t.id);
    const pushed = (local?.pushedMinutes ?? 0) + (local?.approvedMinutes ?? 0);
    const drafts = local?.draftMinutes ?? 0;
    // The report is tasks with hours attached — on either ledger.
    const opSide = t.spentMinutes ?? 0;
    if (opSide === 0 && pushed + drafts === 0) continue;

    const sheetSide = [
      pushed > 0 ? `${formatMinutesShort(pushed)} pushed` : '',
      drafts > 0 ? `${formatMinutesShort(drafts)} drafts` : '',
    ]
      .filter(Boolean)
      .join(' + ');

    // Subjects run long; the full one is one `hours task <id>` away.
    const subject = t.subject.replace(/\s+/g, ' ').trim();
    const clipped = subject.length > 60 ? `${subject.slice(0, 59)}…` : subject;

    rows.push([
      `#${t.id}`,
      t.projectKey,
      t.status ?? dim('—'),
      clipped,
      opSide > 0 ? formatMinutesShort(opSide) : dim('—'),
      sheetSide || dim('—'),
    ]);
  }

  if (rows.length === 0) {
    console.log(
      dim(
        `no cached tasks with hours attached${project ? ` for ${project.key}` : ''} — run \`hours task <id>\` to cache one`,
      ),
    );
    return;
  }

  console.log(renderTable(['TASK', 'PROJECT', 'STATUS', 'SUBJECT', 'OPENPROJECT', 'SHEET'], rows));
}
