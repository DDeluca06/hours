# Running it

## Making `hours` a real command

```fish
# ~/.config/fish/config.fish
alias hours="pnpm --dir /home/mili/Projects/hours hours"
```

Or build once and link the bin:

```bash
pnpm build
pnpm --filter @hours/cli exec npm link
```

## The collector on login

A user-level systemd unit keeps it sweeping without a terminal open. Write
`~/.config/systemd/user/hours-collector.service`:

```ini
[Unit]
Description=hours signal collector
After=default.target

[Service]
Type=simple
WorkingDirectory=/home/mili/Projects/hours
ExecStart=/usr/bin/pnpm collect
Restart=on-failure
RestartSec=30
# Sweeps re-read history rather than tailing it, so a missed window costs nothing.
Environment=HOURS_COLLECT_INTERVAL_MS=600000

[Install]
WantedBy=default.target
```

```bash
systemctl --user daemon-reload
systemctl --user enable --now hours-collector
systemctl --user status hours-collector
journalctl --user -u hours-collector -f
```

`loginctl enable-linger mili` if you want it to survive logout.

Skipping the daemon entirely is a supported choice — `hours reconstruct` sweeps before it
drafts, so a single command at 3 PM gathers the same evidence.

## A 3 PM habit

```fish
# ~/.config/fish/functions/eod.fish
function eod
    hours reconstruct
    hours review
end
```

Then correct what's wrong, `hours approve --day today`, and `hours push`.

## The local store

SQLite at `./hours.db`. Browse it with `pnpm db:studio`.

Back it up like any file — it holds every signal and entry, and the `PushLog` table is the
record of what actually reached the spreadsheet and when:

```bash
sqlite3 hours.db ".backup /path/to/hours-$(date +%F).db"
```

To reset entirely: `rm hours.db && pnpm db:push`. Signals will be re-collected from git and
session history on the next sweep, so nothing except your manual `hours log` entries and the
draft/approved state is genuinely lost.

## Sharing lp-internal-ai-v1's Postgres

If you'd rather keep hours alongside the rest of the org data:

1. `provider = "postgresql"` in `packages/db/prisma/schema.prisma`.
2. Swap the adapter in `packages/db/src/client.ts` to `@prisma/adapter-pg` (that repo's
   `client.ts` is the pattern to copy).
3. Point `DATABASE_URL` at the same instance.
4. `pnpm db:push`.

The models are named to not collide with that repo's `hour_logs` table, which it populates by
reading the same spreadsheet.

## Troubleshooting

**`cannot push: HOURS_SHEET_ID, GOOGLE_SERVICE_ACCOUNT_JSON not set`** — expected without
credentials. Everything except `push` and `sheet` works fine in that state.

**403 on push** — the service account's email has not been shared into the spreadsheet as an
Editor. Read access is not enough.

**`tab "North10AI" not found`** — the error lists the actual tab titles. Run
`pnpm sheets:probe` and set the exact title in `hours.config.json`.

**A day looks too short** — likely a sparsely committed day; see
[inference.md](inference.md#what-it-deliberately-gets-wrong). Check
`hours status` for uncounted signals, and remember that work outside a watched repo is reported
as unattributed rather than assigned.

**Wrong project on a draft** — `hours edit <id> --project <key>`.

**`HOURS_DEBUG=1`** in front of any command turns the friendly error message back into a stack
trace.
