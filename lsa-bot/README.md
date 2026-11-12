# LSA export bot

Downloads Google Local Services Ads' **Detailed Lead Report** for every manager
account the bot's Google login can see, one calendar month per file, and
(optionally) posts each file to DryOps.

It runs on any always-on machine with Google Chrome and Node 20+. It is not
part of the Railway service: this folder has its own `package.json`.

## Set up a machine

```bash
cd lsa-bot
npm install
node lsaBot.js login     # a plain Chrome window opens on the bot's own profile
```

Sign in to the Google account that sees the LSA manager accounts, wait for the
"Select Account" list, then quit that Chrome window. The bot never types a
password; when Google expires the session, a run ends with `needs login` (exit
code 2) and someone repeats this step.

## Run

```bash
node lsaBot.js run --days 60                        # last 60 days, every manager
node lsaBot.js run --from 2025-01-01 --to 2026-11-12  # backfill
node lsaBot.js run --only "A1 Restoration" --days 30
```

Files land in `out/<run time>/LSA_detailed_lead_<manager id>_<from>_<to>.csv`,
exactly as Google produced them. A failed account leaves `failed-<id>.png`
there showing what Google displayed. The run prints one line per account and
exits 0 only when every account exported.

| Variable | Meaning | Default |
| --- | --- | --- |
| `LSA_PROFILE_DIR` | Chrome profile holding the Google session | `./profile` |
| `LSA_OUT_DIR` | where CSVs are written | `./out` |
| `LSA_CONCURRENCY` | manager accounts worked at once | `4` |
| `DRYOPS_IMPORT_URL` | if set, each file is POSTed here as `text/csv` with `?account=&from=&to=` | unset |
| `DRYOPS_IMPORT_KEY` | bearer key for that endpoint | unset |

Put the two `DRYOPS_` values in `lsa-bot/.env` (git-ignored) and the bot picks
them up by itself:

```
DRYOPS_IMPORT_URL=https://dryops-server-production.up.railway.app/lsa/import
DRYOPS_IMPORT_KEY=<the server's LSA_IMPORT_KEY>
```

Hourly on a Mac or Linux box (cron):

```
5 * * * * cd /path/to/lsa-bot && /usr/local/bin/node lsaBot.js run --days 60 >> run.log 2>&1
```

The window is visible by default; add `--headless` only after a visible run
works on that machine. On Linux without a display, run it under `xvfb-run`.

## What was learned about Google's pages (Nov 2026)

- The manager **Reports** page (`/localservices/mccreports`) has a download icon
  → "Detailed Lead Report". One file covers every location under the manager,
  with `Account ID`, `Google Ads Lead Id`, timestamp, phone, `Lead Type`,
  `Charged` and `Dispute Status`. The per-location Leads inbox export has no
  lead ID and no time of day, so it is not used.
- A range longer than about a month does nothing when Download is pressed (no
  error shown). 30 days and a full 31-day month work, so every window is split
  into calendar months.
- The date fields are display-only; dates are picked on the calendar, which
  goes back to October 2017.
- Menus and dialogs ignore a click made while they animate open; the bot pauses
  briefly before each.
- Chrome blocks repeat "automatic" downloads when the file arrives several
  seconds after the click; the bot's profile allows them.
- Playwright's default mock keychain cannot read the cookies saved by the plain
  `login` window, which looks like being signed out; the bot launches Chrome
  with the real keychain.
- The same lead appears under more than one manager when a location is shared
  between managers; the importer must deduplicate on `Google Ads Lead Id`.
