#!/usr/bin/env node
'use strict';

/*
 * DryOps LSA export bot.
 *
 *   node lsaBot.js login                 open Chrome on the bot's own profile so a person signs in once
 *   node lsaBot.js run [options]         download the Detailed Lead Report for every manager account
 *
 * Options for `run`:
 *   --days 30                 window ending today (default 30)
 *   --from 2026-01-01 --to 2026-11-12    explicit window (split into calendar months)
 *   --only "A1 Restoration"   only manager accounts whose name contains this text
 *   --headless                no window (use only once a headed run works on this machine)
 *
 * Environment:
 *   LSA_PROFILE_DIR      Chrome profile that holds the Google session   (default ./profile)
 *   LSA_OUT_DIR          where the CSVs are written                     (default ./out)
 *   LSA_CONCURRENCY      manager accounts worked at the same time       (default 4)
 *   LSA_CHROME           path to the Chrome binary (login command only; auto-detected)
 *   DRYOPS_IMPORT_URL    if set, each file is POSTed here as text/csv
 *   DRYOPS_IMPORT_KEY    bearer key for that endpoint
 *
 * The bot is read-only in Google: it opens the manager Reports page, sets the date
 * filter, and presses Download. It never types a password; `login` hands the
 * window to a person.
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { resolveWindow, monthChunks, ymd, compact } = require('./dates');

const PICKER_URL = 'https://ads.google.com/localservices/accountpicker';
const PROFILE_DIR = path.resolve(process.env.LSA_PROFILE_DIR || path.join(__dirname, 'profile'));
const OUT_DIR = path.resolve(process.env.LSA_OUT_DIR || path.join(__dirname, 'out'));
const CONCURRENCY = Math.max(1, parseInt(process.env.LSA_CONCURRENCY || '4', 10));
const STEP_TIMEOUT = 45_000;

class NeedsLogin extends Error {}

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { args._.push(a); continue; }
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) args[key] = true;
    else { args[key] = next; i++; }
  }
  return args;
}

function chromeBinary() {
  if (process.env.LSA_CHROME) return process.env.LSA_CHROME;
  const candidates = {
    darwin: ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'],
    win32: [
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    ],
    linux: ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable'],
  }[process.platform] || [];
  const found = candidates.find((p) => fs.existsSync(p));
  if (!found) throw new Error('Chrome not found. Install Google Chrome or set LSA_CHROME to its path.');
  return found;
}

/** A plain Chrome window (no automation) on the bot profile: Google refuses sign-in inside automated browsers. */
function login() {
  fs.mkdirSync(PROFILE_DIR, { recursive: true });
  const child = spawn(chromeBinary(), [
    `--user-data-dir=${PROFILE_DIR}`, '--no-first-run', '--no-default-browser-check', PICKER_URL,
  ], { detached: true, stdio: 'ignore' });
  child.unref();
  console.log('Chrome is open on the bot profile. Sign in to the Google account that sees the LSA');
  console.log('manager accounts, wait for the "Select Account" list, then quit that Chrome window.');
}

async function openBrowser(headless) {
  const { chromium } = require('playwright-core');
  if (!fs.existsSync(PROFILE_DIR)) throw new NeedsLogin('No bot profile yet. Run: node lsaBot.js login');
  return chromium.launchPersistentContext(PROFILE_DIR, {
    channel: 'chrome',
    headless,
    acceptDownloads: true,
    viewport: { width: 1500, height: 900 },
    args: ['--disable-blink-features=AutomationControlled', '--no-first-run', '--no-default-browser-check'],
  });
}

function assertSignedIn(page) {
  const host = new URL(page.url()).hostname;
  if (host === 'accounts.google.com') {
    throw new NeedsLogin('Google is asking for a sign-in. Run: node lsaBot.js login');
  }
}

/** Manager accounts from the picker: [{ name, id, href }]. */
async function listManagers(page) {
  await page.goto(PICKER_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle').catch(() => {});
  assertSignedIn(page);
  await page.getByText('Use Local Services Ads as', { exact: false }).waitFor({ timeout: STEP_TIMEOUT });
  const rows = await page.evaluate(() => {
    const idRe = /\b\d{3}-\d{3}-\d{4}\b/;
    return [...document.querySelectorAll('a[href]')].map((a) => {
      // Walk up to the smallest ancestor that also holds the account's ID.
      let box = a;
      for (let i = 0; i < 6 && box && !idRe.test(box.innerText || ''); i++) box = box.parentElement;
      const text = (box && box.innerText) || '';
      const id = (text.match(idRe) || [''])[0];
      return { name: a.innerText.trim(), id, manager: /\(Manager\)/i.test(text), href: a.href };
    }).filter((r) => r.name && r.id);
  });
  const seen = new Set();
  return rows.filter((r) => r.manager && !seen.has(r.id) && seen.add(r.id));
}

async function openManager(context, manager) {
  const page = await context.newPage();
  await page.goto(manager.href, { waitUntil: 'domcontentloaded' });
  assertSignedIn(page);
  if (!/\/mccreports/.test(page.url())) {
    // The picker lands on Reports for a manager; go there explicitly if it did not.
    const u = new URL(page.url());
    u.pathname = u.pathname.replace(/\/localservices\/.*$/, '/localservices/mccreports');
    await page.goto(u.toString(), { waitUntil: 'domcontentloaded' });
  }
  await dateRangeBox(page).waitFor({ timeout: STEP_TIMEOUT });
  return page;
}

const dateRangeBox = (page) => page.getByRole('textbox', { name: 'Date range' });
const usDate = ({ y, m, d }) => `${m}/${d}/${y}`;

/** Set the Reports date filter to a custom range and confirm the page took it. */
async function setRange(page, { start, end }) {
  await dateRangeBox(page).click();
  await page.getByRole('option', { name: 'Custom' }).or(page.getByText('Custom', { exact: true })).first().click();
  const startBox = page.getByRole('textbox', { name: 'Start' });
  const endBox = page.getByRole('textbox', { name: 'End' });
  await startBox.waitFor({ timeout: STEP_TIMEOUT });
  await startBox.click();
  await startBox.pressSequentially(usDate(start), { delay: 30 });
  await endBox.click();
  await endBox.pressSequentially(usDate(end), { delay: 30 });
  await page.getByRole('button', { name: 'Apply' }).click();
  await startBox.waitFor({ state: 'hidden', timeout: STEP_TIMEOUT }).catch(() => {
    throw new Error(`Google rejected the date range ${ymd(start)} to ${ymd(end)}`);
  });
  const shown = await dateRangeBox(page).inputValue();
  if (!shown.includes(String(start.y)) && !shown.includes(String(end.y))) {
    throw new Error(`Date filter did not change (shows "${shown}")`);
  }
  await page.waitForLoadState('networkidle').catch(() => {});
}

/** Reports page → download icon → Detailed Lead Report → Download. Returns the saved path. */
async function downloadDetailed(page, destDir, fallbackName) {
  const dialog = page.getByText('Report Download', { exact: true });
  // The download icon has no label; it sits in the LIVE ACCOUNTS header next to "Create Account".
  const header = page.getByText('LIVE ACCOUNTS', { exact: true }).locator('xpath=ancestor::*[.//button][1]');
  const buttons = header.getByRole('button');
  const count = await buttons.count();
  let opened = false;
  for (let i = count - 1; i >= 0 && !opened; i--) {
    const b = buttons.nth(i);
    if (/create account/i.test((await b.getAttribute('aria-label')) || '')) continue;
    await b.click();
    opened = await dialog.waitFor({ timeout: 3000 }).then(() => true, () => false);
    if (!opened) await page.keyboard.press('Escape');
  }
  if (!opened) throw new Error('Could not open the Report Download dialog (page layout changed?)');

  await page.getByText('Detailed Lead Report', { exact: true }).click();
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 120_000 }),
    page.getByRole('button', { name: 'Download', exact: true }).click(),
  ]);
  const name = download.suggestedFilename() || fallbackName;
  const dest = path.join(destDir, name);
  await download.saveAs(dest);
  return dest;
}

async function submit(file, manager, chunk) {
  const url = process.env.DRYOPS_IMPORT_URL;
  if (!url) return null;
  const target = new URL(url);
  target.searchParams.set('account', manager.id.replace(/-/g, ''));
  target.searchParams.set('from', ymd(chunk.start));
  target.searchParams.set('to', ymd(chunk.end));
  const send = () => fetch(target, {
    method: 'POST',
    headers: {
      'Content-Type': 'text/csv',
      Authorization: `Bearer ${process.env.DRYOPS_IMPORT_KEY || ''}`,
      'X-Filename': encodeURIComponent(path.basename(file)),
    },
    body: fs.readFileSync(file),
  });
  let res = await send();
  if (!res.ok) res = await send(); // one retry, then report
  const text = (await res.text()).trim().slice(0, 300);
  if (!res.ok) throw new Error(`DryOps rejected the file (${res.status}): ${text}`);
  return text;
}

function countRows(file) {
  // Data rows = line breaks outside quotes, minus the header.
  const text = fs.readFileSync(file, 'utf8');
  let rows = 0; let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') quoted = !quoted;
    else if (c === '\n' && !quoted) rows++;
  }
  if (text.length && !text.endsWith('\n')) rows++;
  return Math.max(0, rows - 1);
}

async function exportManager(context, manager, chunks, destDir) {
  const page = await openManager(context, manager);
  const lines = [];
  try {
    for (const chunk of chunks) {
      await setRange(page, chunk);
      const fallback = `LSA_detailed_lead_${manager.id.replace(/-/g, '')}_${compact(chunk.start)}_${compact(chunk.end)}.csv`;
      const file = await downloadDetailed(page, destDir, fallback);
      const rows = countRows(file);
      const reply = await submit(file, manager, chunk);
      lines.push(`${ymd(chunk.start)}..${ymd(chunk.end)} ${rows} rows${reply ? ` → ${reply}` : ''}`);
    }
  } finally {
    await page.close().catch(() => {});
  }
  return lines;
}

async function run(args) {
  const window = resolveWindow({ from: args.from, to: args.to, days: parseInt(args.days || '30', 10) });
  const chunks = args.from ? monthChunks(window) : [window];
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const destDir = path.join(OUT_DIR, stamp);
  fs.mkdirSync(destDir, { recursive: true });

  const context = await openBrowser(Boolean(args.headless));
  let failed = 0;
  try {
    const first = context.pages()[0] || await context.newPage();
    let managers = await listManagers(first);
    if (args.only) managers = managers.filter((m) => m.name.toLowerCase().includes(String(args.only).toLowerCase()));
    if (!managers.length) throw new Error('No manager accounts found on the account picker.');
    console.log(`${managers.length} manager accounts, ${ymd(window.start)} to ${ymd(window.end)}, ${chunks.length} range(s) each`);

    const queue = managers.slice();
    const worker = async () => {
      for (let m = queue.shift(); m; m = queue.shift()) {
        try {
          const lines = await exportManager(context, m, chunks, destDir);
          console.log(`${m.name} (${m.id}): ${lines.join('; ')}`);
        } catch (err) {
          failed++;
          console.log(`${m.name} (${m.id}): FAILED ${err.message.split('\n')[0]}`);
          if (err instanceof NeedsLogin) { queue.length = 0; }
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, managers.length) }, worker));
    console.log(failed ? `${failed} accounts failed` : 'All accounts exported');
    console.log(`Files: ${destDir}`);
  } finally {
    await context.close().catch(() => {});
  }
  return failed ? 1 : 0;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0];
  if (cmd === 'login') { login(); return 0; }
  if (cmd === 'run') return run(args);
  console.log('Usage: node lsaBot.js login | run [--days 30] [--from YYYY-MM-DD --to YYYY-MM-DD] [--only text] [--headless]');
  return 64;
}

if (require.main === module) {
  main().then((code) => process.exit(code), (err) => {
    console.error(err instanceof NeedsLogin ? `needs login: ${err.message}` : err);
    process.exit(err instanceof NeedsLogin ? 2 : 1);
  });
}

module.exports = { parseArgs, countRows };
