#!/usr/bin/env node
// ---------------------------------------------------------------------------
// `hours` — the CLI entry point.
// ---------------------------------------------------------------------------

import { parseArgs } from './args.js';
import {
  cmdActivities,
  cmdApprove,
  cmdCancel,
  cmdCollect,
  cmdDrop,
  cmdEdit,
  cmdLog,
  cmdProjects,
  cmdPush,
  cmdReconstruct,
  cmdReview,
  cmdSheet,
  cmdStart,
  cmdStatus,
  cmdStop,
  cmdTask,
  cmdTasks,
  cmdUnapprove,
} from './commands.js';
import { bold, dim } from './format.js';

const HELP = `${bold('hours')} — track what you did, for which project, and push it to the shared sheet

${bold('during the day')}
  hours start <project> [activity]     start a timer  (-p/-a also work)
  hours stop [activity] [--note "..."] stop it and save a draft entry
                                       (timers run per project; -p stops that project's timer)
  hours cancel [-p <project>]          throw a running timer away
  hours log <duration> <activity> -p <project> [-d <day>] [--note "..."] [--task <id>]
                                       log time you already spent
  hours status                         timers, today's entries, uncounted signals

${bold('at 3 PM')}
  hours collect [--days 3]             sweep git, agent harnesses, editor saves
  hours reconstruct [day] [--dry-run]  turn today's signals into draft entries
  hours review [--day <day>] [--all]   see drafts with the reasoning behind them
  hours edit <id> [--minutes 90] [--activity dev] [--note "..."] [--day today]
  hours drop <id>                      delete a draft
  hours approve <id...> | --day <day> | --all
                       [--no-prompt]   approve without asking for missing notes
  hours unapprove <id...>              send approved entries back to draft
  hours push [--project <k>] [--day <d>] [--dry-run] [--yes]

${bold('looking around')}
  hours task <id> [--refresh]          what a task has on it, both ledgers
  hours tasks [--project <key>]        cached tasks with hours attached
  hours activities                     the fixed activity taxonomy and shorthands
  hours projects                       registry, watched repos, pushed totals
  hours sheet <project>                what the tab already says

${bold('durations')}  90  90m  1.5h  1:30
${bold('days')}       today  yesterday  -2  2026-08-12  8/12

${dim('Nothing reaches the spreadsheet until you approve it and confirm the push.')}
`;

type Handler = (args: ReturnType<typeof parseArgs>) => Promise<void>;

const COMMANDS: Record<string, Handler> = {
  start: cmdStart,
  stop: cmdStop,
  cancel: cmdCancel,
  log: cmdLog,
  status: cmdStatus,
  collect: cmdCollect,
  reconstruct: cmdReconstruct,
  review: cmdReview,
  edit: cmdEdit,
  drop: cmdDrop,
  approve: cmdApprove,
  unapprove: cmdUnapprove,
  push: cmdPush,
  sheet: cmdSheet,
  task: cmdTask,
  tasks: cmdTasks,
  activities: async () => cmdActivities(),
  projects: async () => cmdProjects(),
};

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.command === 'help' || args.command === '--help' || args.command === '-h') {
    console.log(HELP);
    return;
  }

  const handler = COMMANDS[args.command];
  if (!handler) {
    console.error(`unknown command "${args.command}"\n`);
    console.log(HELP);
    process.exit(1);
  }

  await handler(args);
}

main()
  .then(() => process.exit(0))
  .catch((err: unknown) => {
    // Operational failures are messages, not stack traces — a missing --project
    // should read like advice. HOURS_DEBUG=1 restores the trace.
    if (process.env['HOURS_DEBUG'] === '1') console.error(err);
    else console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
