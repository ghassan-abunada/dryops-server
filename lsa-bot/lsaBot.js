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
 *   --from 2026-01-01 --to 2026-11-12    explicit window
 *                             (either way the window is requested one calendar month at a time)
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
const DOWNLOAD_ICON = 'img[jsname="hRZeKc"], img[src*="get_app"]';

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

/**
 * Chrome counts a file that arrives more than a few seconds after the click as an
 * "automatic download" and silently blocks the second one from the same site. The
 * report is built server-side and can take longer than that, so allow them up front.
 */
function allowAutomaticDownloads() {
  const file = path.join(PROFILE_DIR, 'Default', 'Preferences');
  if (!fs.existsSync(file)) return;
  const prefs = JSON.parse(fs.readFileSync(file, 'utf8'));
  const values = ((prefs.profile ||= {}).default_content_setting_values ||= {});
  if (values.automatic_downloads === 1) return;
  values.automatic_downloads = 1;
  fs.writeFileSync(file, JSON.stringify(prefs));
}

async function openBrowser(headless) {
  const { chromium } = require('playwright-core');
  if (!fs.existsSync(PROFILE_DIR)) throw new NeedsLogin('No bot profile yet. Run: node lsaBot.js login');
  allowAutomaticDownloads();
  return chromium.launchPersistentContext(PROFILE_DIR, {
    channel: 'chrome',
    headless,
    acceptDownloads: true,
    viewport: { width: 1500, height: 900 },
    // Playwright's defaults swap in a mock keychain, which cannot decrypt the cookies
    // the plain `login` window saved: the session would look signed out.
    ignoreDefaultArgs: ['--use-mock-keychain', '--password-store=basic'],
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

async function gotoWithRetry(page, url) {
  // Google's redirect chain occasionally stalls; one retry clears it.
  for (let attempt = 1; ; attempt++) {
    try { await page.goto(url, { waitUntil: 'domcontentloaded', timeout: STEP_TIMEOUT }); return; } catch (err) {
      if (attempt >= 2) throw err;
    }
  }
}

/** Reports page is ready once the date filter shows a range and the accounts table has rows. */
async function waitForReports(page) {
  await page.waitForFunction(() => {
    const box = document.querySelector('input[aria-label="Date range"]');
    return box && box.value.trim();
  }, null, { timeout: 90_000 });
  // The accounts table follows; a manager with no live accounts never gets rows, so do not insist on them.
  await page.waitForFunction(() => document.querySelectorAll('tr').length > 1, null, { timeout: 15_000 }).catch(() => {});
}

async function openManager(context, manager) {
  const page = await context.newPage();
  await gotoWithRetry(page, manager.href);
  assertSignedIn(page);
  if (!/\/mccreports/.test(page.url())) {
    // The picker lands on Reports for a manager; go there explicitly if it did not.
    const u = new URL(page.url());
    u.pathname = u.pathname.replace(/\/localservices.*$/, '/localservices/mccreports');
    await gotoWithRetry(page, u.toString());
  }
  await waitForReports(page);
  return page;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const shownRange = (page) => page.locator('input[aria-label="Date range"]').inputValue().then((v) => v.trim());
const rangeLabel = ({ start, end }) => [start, end]
  .map(({ y, m, d }) => `${MONTHS[m - 1].slice(0, 3)} ${d}, ${y}`).join(' - ');

/** Page the calendar to a month and click a day. The Start/End boxes are display-only. */
async function pickDay(page, { y, m, d }) {
  const label = page.locator('[jsname="xv3kgd"]');
  const want = `${MONTHS[m - 1]} ${y}`;
  for (let i = 0; i < 240; i++) {
    const text = (await label.innerText()).trim();
    if (text === want) break;
    const [name, year] = text.split(' ');
    const diff = (y - Number(year)) * 12 + (m - 1 - MONTHS.indexOf(name));
    if (!Number.isFinite(diff)) throw new Error(`Unreadable calendar month "${text}"`);
    await page.locator(`[aria-label="${diff < 0 ? 'previous' : 'next'} month"]`).click();
    await page.waitForFunction((prev) => document.querySelector('[jsname="xv3kgd"]').textContent.trim() !== prev, text, { timeout: 5000 });
  }
  if ((await label.innerText()).trim() !== want) throw new Error(`Calendar would not go to ${want}`);
  const cell = page.locator(`[role="gridcell"][data-day-of-month="${d}"]`);
  if ((await cell.getAttribute('aria-disabled')) === 'true') throw new Error(`Google does not allow ${ymd({ y, m, d })} in this report`);
  await cell.click();
}

/** Set the Reports date filter to a custom range and confirm the page took it. */
async function setRange(page, range) {
  const want = rangeLabel(range);
  if ((await shownRange(page)) === want) return;
  // The labelled menu button has no height; the visible target is the arrow at the right of
  // the field. A click that lands while a dialog or menu is still animating is ignored, so retry.
  const field = page.locator('[jsname="pRFXed"]').first();
  const custom = page.getByRole('menuitem').filter({ hasText: /^\s*Custom\s*$/ });
  for (let attempt = 1; ; attempt++) {
    const box = await field.boundingBox();
    await field.click({ position: { x: box.width - 12, y: box.height / 2 }, force: true });
    if (await custom.waitFor({ timeout: 4000 }).then(() => true, () => false)) break;
    if (attempt >= 5) throw new Error('The date range menu would not open');
    await page.waitForTimeout(700);
  }
  await page.waitForTimeout(600);
  await custom.click({ delay: 120 });
  await page.locator('[aria-label="Apply"]').waitFor({ timeout: STEP_TIMEOUT });
  await pickDay(page, range.start);
  await pickDay(page, range.end);
  await page.locator('[aria-label="Apply"]').click();
  await page.waitForFunction((w) => document.querySelector('input[aria-label="Date range"]').value.trim() === w, want, { timeout: STEP_TIMEOUT })
    .catch(async () => { throw new Error(`Date filter shows "${await shownRange(page)}", wanted "${want}"`); });
  await waitForReports(page);
  await page.waitForLoadState('networkidle').catch(() => {});
}

/** Reports page → download icon → Detailed Lead Report → Download. Returns the saved path. */
async function downloadDetailed(page, destDir, fallbackName) {
  const dialog = page.getByText('Report Download', { exact: true });
  await page.locator(DOWNLOAD_ICON).first().click();
  await dialog.waitFor({ timeout: STEP_TIMEOUT });
  await page.waitForTimeout(600); // same animation rule as the date menu
  await page.getByText('Detailed Lead Report', { exact: true }).click({ delay: 120 });
  await page.locator('[role="radio"][data-value="Detailed Lead Report"][aria-checked="true"]').waitFor({ timeout: STEP_TIMEOUT });
  await page.waitForTimeout(500);
  const go = page.locator('[role="button"]:visible, button:visible').filter({ hasText: /^\s*download\s*$/i }).last();
  const rpc = page.waitForResponse((r) => /rpcids=S9DRMe/.test(r.url()), { timeout: 120_000 }).catch(() => null);
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 120_000 }).catch(async () => {
      const r = await Promise.race([rpc, new Promise((ok) => setTimeout(() => ok(null), 1000))]);
      const body = r ? await r.text().catch(() => '') : '';
      throw new Error(r
        ? `Google answered the report request with HTTP ${r.status()} and sent no file (${body.length} bytes: ${body.replace(/\s+/g, ' ').slice(0, 160)})`
        : 'No file arrived after pressing Download');
    }),
    go.click({ delay: 120 }),
  ]);
  const dest = path.join(destDir, fallbackName);
  await download.saveAs(dest);
  await dialog.waitFor({ state: 'hidden', timeout: STEP_TIMEOUT });
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
      const fallback = `LSA_detailed_lead_${manager.id.replace(/-/g, '')}_${compact(chunk.start)}_${compact(chunk.end)}.csv`;
      let file;
      for (let attempt = 1; !file; attempt++) {
        try {
          await setRange(page, chunk);
          file = await downloadDetailed(page, destDir, fallback);
        } catch (err) {
          if (attempt >= 3 || err instanceof NeedsLogin) throw err;
          // Start the month again from a clean page.
          await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
          assertSignedIn(page);
          await waitForReports(page);
        }
      }
      const rows = countRows(file);
      const reply = await submit(file, manager, chunk);
      lines.push(`${ymd(chunk.start)}..${ymd(chunk.end)} ${rows} rows${reply ? ` → ${reply}` : ''}`);
    }
  } catch (err) {
    // Keep a picture of what Google showed: it is the fastest way to see a layout change.
    await page.screenshot({ path: path.join(destDir, `failed-${manager.id}.png`) }).catch(() => {});
    throw err;
  } finally {
    await page.close().catch(() => {});
  }
  return lines;
}

async function run(args) {
  const window = resolveWindow({ from: args.from, to: args.to, days: parseInt(args.days || '30', 10) });
  // Google silently refuses a Detailed Lead Report longer than about a month (a 60-day
  // range does nothing; 30 days and a full 31-day month work), so every window is
  // requested one calendar month at a time.
  const chunks = monthChunks(window);
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
          // One more go for the whole account: Google's pages sometimes stall on load.
          const lines = await exportManager(context, m, chunks, destDir)
            .catch((err) => { if (err instanceof NeedsLogin) throw err; return exportManager(context, m, chunks, destDir); });
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

module.exports = { parseArgs, countRows, openBrowser, listManagers, openManager, setRange, downloadDetailed };
