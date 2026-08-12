// ---------------------------------------------------------------------------
// CLI commands.
//
// Every command that changes shared state (`push`) prints exactly what it will
// do and requires either a TTY confirmation or an explicit --yes. Every command
// that only touches the local store acts immediately — the local store is
// yours, and friction there is what makes people stop logging hours.
// ---------------------------------------------------------------------------

import { createInterface } from 'node:readline/promises';
import { loadConfig, requirePushConfig } from '@hours/config';
import {
  formatMinutesShort,
  localDayKey,
  projectByKey,
  resolveActivity,
  toSheetRow,
  validateEntries,
  type Activity,
  type Entry,
  type ProjectDef,
} from '@hours/core';
import {
  approveEntries,
  createEntries,
  currentTimer,
  cancelTimer,
  deleteEntry,
  getEntry,
  listEntries,
  loadSignals,
  logPush,
  markPushed,
  pushedHours,
  startTimer,
  stopTimer,
  unapproveEntries,
  updateEntry,
  type StoredEntry,
} from '@hours/lib-db';
import { reconstruct, sweep } from '@hours/collector';
import { previewPush, pushEntries, readTab, summarize } from '@hours/connector-google-sheets';
import { flagBool, flagString, parseDayArg, parseMinutesArg, type ParsedArgs } from './args.js';
import { bold, cyan, dim, green, red, renderEntries, renderTotals, shortId, yellow } from './format.js';

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
      `"${raw}" is not a recognizable activity — it must resolve to one of the sheet's values`,
    );
  }
  return activity;
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

// --- log ------------------------------------------------------------------

export async function cmdLog(args: ParsedArgs): Promise<void> {
  const cfg = loadConfig();
  const [durationRaw, activityRaw] = args.positionals;

  const minutes = durationRaw ? parseMinutesArg(durationRaw) : null;
  if (minutes === null) {
    throw new Error('usage: hours log <duration> <activity> --project <key> [--day <day>] [--note "..."]');
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

  const { started, replaced } = await startTimer({
    projectKey: project.key,
    ...(activity ? { activity } : {}),
    ...(note ? { note } : {}),
  });

  if (replaced) {
    console.log(
      yellow(
        `stopped the previous timer first: ${replaced.projectKey} ${replaced.activity ?? '(no activity)'} — ${formatMinutesShort(replaced.minutes)} discarded`,
      ),
    );
    console.log(dim('  (that time was not saved; log it with `hours log` if it mattered)'));
  }
  console.log(
    green('started'),
    `${started.projectKey} ${started.activity ?? dim('(activity at stop time)')} at ${started.startedAt.toLocaleTimeString()}`,
  );
}

export async function cmdStop(args: ParsedArgs): Promise<void> {
  const cfg = loadConfig();
  const open = await currentTimer();
  if (!open) {
    console.log(dim('no timer running'));
    return;
  }

  const stopped = await stopTimer();
  if (!stopped) return;

  const activityRaw = flagString(args.flags, 'activity') ?? args.positionals[0] ?? stopped.activity;
  if (!activityRaw) {
    throw new Error(
      `the timer had no activity — re-run as \`hours stop <activity>\`. ${formatMinutesShort(stopped.minutes)} is preserved and will be waiting.`,
    );
  }
  const activity = requireActivity(activityRaw);
  const person = flagString(args.flags, 'person') ?? cfg.person;
  if (!person) throw new Error('HOURS_PERSON is not set and --person was not given');

  const startMin = stopped.startedAt.getHours() * 60 + stopped.startedAt.getMinutes();
  const entry: Entry = {
    day: localDayKey(stopped.startedAt),
    person,
    projectKey: stopped.projectKey,
    minutes: stopped.minutes,
    activity,
    ranges: [{ startMin, endMin: startMin + stopped.minutes }],
    status: 'draft',
    provenance: 'timer',
  };
  const note = flagString(args.flags, 'note') ?? stopped.note;
  if (note) entry.description = note;

  const [created] = await createEntries([entry]);
  console.log(green(`stopped after ${formatMinutesShort(stopped.minutes)}`));
  console.log(renderEntries(created ? [created] : []));
}

export async function cmdCancel(): Promise<void> {
  const cancelled = await cancelTimer();
  console.log(
    cancelled
      ? yellow(`cancelled the ${cancelled.projectKey} timer — nothing logged`)
      : dim('no timer running'),
  );
}

export async function cmdStatus(): Promise<void> {
  const cfg = loadConfig();
  const open = await currentTimer();
  const today = localDayKey(new Date());
  const entries = await listEntries({ day: today });

  if (open) {
    const mins = Math.round((Date.now() - open.startedAt.getTime()) / 60_000);
    console.log(
      cyan('running'),
      `${open.projectKey} ${open.activity ?? dim('(no activity yet)')} — ${formatMinutesShort(mins)} so far`,
    );
  } else {
    console.log(dim('no timer running'));
  }

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

    const issues = validateEntries(entries, {
      ...(project.contractHours !== undefined
        ? { contractHoursRemaining: project.contractHours - (await pushedHours(projectKey)) }
        : {}),
    });
    const errors = issues.filter((i) => i.severity === 'error');
    if (errors.length) {
      for (const e of errors) console.log(red(`  error: ${e.message}`));
      console.log(red('  refusing to push this project'));
      continue;
    }
    for (const w of issues) console.log(yellow(`  warn: ${w.message}`));

    let preview;
    try {
      preview = await previewPush({ spreadsheetId: sheetId, tabTitle: project.sheetTab, entries });
    } catch (err) {
      console.log(red(`  ${err instanceof Error ? err.message : String(err)}`));
      continue;
    }

    console.log(dim(`  header row ${preview.layout.headerRow}, "${preview.layout.activityHeader}" column`));
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

    const ids = entries.map((e) => e.id);
    try {
      const result = await pushEntries({
        spreadsheetId: sheetId,
        tabTitle: project.sheetTab,
        entries,
        allowDuplicates,
      });
      await markPushed(ids, result.updatedRange);
      await logPush({
        projectKey,
        sheetTab: project.sheetTab,
        entryIds: ids,
        minutes: result.minutes,
        ok: true,
      });
      console.log(green(`  appended ${result.rowCount} row(s) at ${result.updatedRange}`));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
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
