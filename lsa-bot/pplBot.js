#!/usr/bin/env node
'use strict';

/*
 * DryOps pay-per-lead export bot (Google's NEW leads dashboard).
 *
 * Google is moving Local Services accounts from the old LSA dashboard
 * (ads.google.com/localservices, read by lsaBot.js) into Google Ads. A migrated
 * profile's leads leave the old Detailed Lead Report and appear under
 * Google Ads → Goals → Leads → "Pay-per-lead leads", one list per MANAGER account.
 * This bot downloads that list as .csv for every manager account.
 *
 *   node pplBot.js run [options]
 *
 * Options:
 *   --only "Five Star"   only manager accounts whose name contains this text
 *   --headless           no window (use only once a headed run works on this machine)
 *   --submit             also POST each file to DryOps (needs DRYOPS_IMPORT_URL / _KEY)
 *
 * Same Chrome profile, output folder and sign-in as lsaBot.js (`node lsaBot.js login`).
 * Read-only in Google: it opens the Leads page and presses Download → .csv.
 *
 * What the export is (2026-11-16): two title lines ("Pay-per-lead leads report",
 * the date range), then a header row and one row per lead for the WHOLE manager:
 *   Lead details (phone), First contact date (date only: 2026Nov3), Lead status,
 *   Charge status (Charged | Not charged | In review | Credited), Lead type,
 *   Customer name, Additional notes, Service type, Search intent, Last Updated,
 *   Business category, Lead ID, Campaign name, Campaign ID.
 * There is no account ID: the campaign is the unit. Lead ID is the same number the
 * old report calls "Google Ads Lead Id". The screen shows a time of day; no export
 * format (csv, xlsx, xml) keeps it.
 */

const fs = require('fs');
const path = require('path');
const { parseArgs, openBrowser } = require('./lsaBot');

const ENV_FILE = path.join(__dirname, '.env');
if (fs.existsSync(ENV_FILE) && process.loadEnvFile) process.loadEnvFile(ENV_FILE);

const SELECT_URL = 'https://ads.google.com/nav/selectaccount';
const LEADS_PATH = '/aw/leads/local-services';
const OUT_DIR = path.resolve(process.env.LSA_OUT_DIR || path.join(__dirname, 'out'));
const STEP_TIMEOUT = 45_000;

class NeedsLogin extends Error {}

function assertSignedIn(page) {
  if (new URL(page.url()).hostname === 'accounts.google.com') {
    throw new NeedsLogin('Google is asking for a sign-in. Run: node lsaBot.js login');
  }
}

async function gotoWithRetry(page, url) {
  for (let attempt = 1; ; attempt++) {
    try { await page.goto(url, { waitUntil: 'domcontentloaded', timeout: STEP_TIMEOUT }); return; } catch (err) {
      if (attempt >= 2) throw err;
    }
  }
}

/** Manager accounts on Google Ads' own picker: [{ name, id }]. */
async function listManagers(page) {
  await gotoWithRetry(page, SELECT_URL);
  await page.waitForLoadState('networkidle').catch(() => {});
  assertSignedIn(page);
  await page.getByText('Select a Google Ads account', { exact: false }).waitFor({ timeout: STEP_TIMEOUT });
  await page.locator('[role="menuitem"]').first().waitFor({ timeout: STEP_TIMEOUT });
  const rows = await page.evaluate(() => {
    const idRe = /\b\d{3}-\d{3}-\d{4}\b/;
    return [...document.querySelectorAll('[role="menuitem"]')].map((el) => {
      const text = (el.innerText || '').trim();
      const id = (text.match(idRe) || [''])[0];
      const name = text.split('\n').map((s) => s.trim()).filter(Boolean)[0] || '';
      return { name, id, manager: /\bManager\b/.test(text) };
    }).filter((r) => r.name && r.id);
  });
  const seen = new Set();
  return rows.filter((r) => r.manager && !seen.has(r.id) && seen.add(r.id));
}

/** Pick the manager on the picker, then go to its Leads page. Returns the page's state. */
async function openLeads(page, manager) {
  await gotoWithRetry(page, SELECT_URL);
  assertSignedIn(page);
  const row = page.locator('[role="menuitem"]').filter({ hasText: manager.id }).first();
  await row.waitFor({ timeout: STEP_TIMEOUT });
  await Promise.all([
    page.waitForURL(/[?&]ocid=\d+/, { timeout: STEP_TIMEOUT }),
    row.click({ delay: 120 }),
  ]);
  assertSignedIn(page);
  // Keep Google's own account parameters (ocid, authuser, …) and swap the page.
  // Only the parameters the real Leads page carries: an extra one (workspaceId) makes Google answer 404.
  const home = new URL(page.url());
  const u = new URL(LEADS_PATH, home.origin);
  for (const k of ['ocid', 'ascid', 'euid', '__u', 'uscid', '__c', 'authuser']) {
    if (home.searchParams.has(k)) u.searchParams.set(k, home.searchParams.get(k));
  }
  const homeUrl = home.toString();
  await gotoWithRetry(page, u.toString());
  assertSignedIn(page);
  await page.waitForLoadState('networkidle').catch(() => {});
  // Ready = the "Pay-per-lead leads" tab is up and the table has either rows or its empty state.
  const tab = page.getByText('Pay-per-lead leads', { exact: true }).first();
  let up = await tab.waitFor({ timeout: 30_000 }).then(() => true, () => false);
  if (!up) {
    // The address did not take: walk there the way a person does, Goals → Leads.
    await gotoWithRetry(page, homeUrl);
    await page.waitForLoadState('networkidle').catch(() => {});
    const goals = page.getByRole('link', { name: /^\s*Goals\s*$/ }).or(page.getByRole('button', { name: /^\s*Goals\s*$/ })).or(page.getByText('Goals', { exact: true })).first();
    if (await goals.waitFor({ timeout: 20_000 }).then(() => true, () => false)) {
      await goals.click({ delay: 120 }).catch(() => {});
      const leads = page.getByText('Leads', { exact: true }).first();
      if (await leads.waitFor({ timeout: 15_000 }).then(() => true, () => false)) {
        await leads.click({ delay: 120 }).catch(() => {});
        up = await tab.waitFor({ timeout: 30_000 }).then(() => true, () => false);
      }
    }
  }
  if (!up) return 'no-leads-page';
  await page.waitForFunction(() => {
    const rows = document.querySelectorAll('[role="row"]').length;
    return rows > 1 || /no leads|nothing to show|don't have any/i.test(document.body.innerText);
  }, null, { timeout: 60_000 }).catch(() => {});
  const rows = await page.locator('[role="row"]').count();
  return rows > 1 ? 'ready' : 'empty';
}

/** Leads page → Download → .csv. Returns the saved path. */
async function downloadCsv(page, dest) {
  const button = page.getByRole('button', { name: /^\s*Download\s*$/ }).first();
  const item = page.getByRole('menuitem', { name: '.csv', exact: true });
  for (let attempt = 1; ; attempt++) {
    await button.click({ delay: 120 });
    if (await item.waitFor({ timeout: 4000 }).then(() => true, () => false)) break;
    if (attempt >= 4) throw new Error('The Download menu would not open');
    await page.keyboard.press('Escape').catch(() => {});
    await page.waitForTimeout(700);
  }
  await page.waitForTimeout(400); // a click during the menu's animation is ignored
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 180_000 }),
    item.click({ delay: 120 }),
  ]);
  await download.saveAs(dest);
  return dest;
}

/** Leads in the file, and how many campaigns: the two title lines and the header are not leads. */
function summarize(file) {
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter((l) => l.trim());
  const head = lines.findIndex((l) => /^Lead details,/.test(l));
  if (head < 0) return { leads: 0, campaigns: 0, range: '', ok: false };
  const body = lines.slice(head + 1);
  const campaigns = new Set(body.map((l) => l.slice(l.lastIndexOf(',') + 1).trim()).filter((c) => /^\d+$/.test(c)));
  return { leads: body.length, campaigns: campaigns.size, range: lines[head - 1] || '', ok: true };
}

async function submit(file, manager) {
  const url = process.env.DRYOPS_IMPORT_URL;
  if (!url) return null;
  const target = new URL(url);
  target.searchParams.set('account', manager.id.replace(/-/g, ''));
  target.searchParams.set('format', 'ppl');
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
  if (!res.ok) res = await send();
  const text = (await res.text()).trim().slice(0, 300);
  if (!res.ok) throw new Error(`DryOps rejected the file (${res.status}): ${text}`);
  return text;
}

async function exportManager(context, manager, destDir, doSubmit) {
  const page = await context.newPage();
  try {
    const state = await openLeads(page, manager);
    if (state !== 'ready' && process.env.PPL_DEBUG) {
      await page.screenshot({ path: path.join(destDir, `state-${state}-${manager.id}.png`) }).catch(() => {});
      console.log(`  [debug] ${state} at ${page.url()}`);
    }
    if (state === 'no-leads-page') return 'no Leads page (not on the new dashboard)';
    if (state === 'empty') return 'Leads page is empty';
    const file = await downloadCsv(page, path.join(destDir, `PPL_leads_${manager.id.replace(/-/g, '')}.csv`));
    const s = summarize(file);
    if (!s.ok) throw new Error('The downloaded file is not a pay-per-lead leads report');
    const reply = doSubmit ? await submit(file, manager) : null;
    return `${s.leads} leads, ${s.campaigns} campaigns (${s.range})${reply ? ` → ${reply}` : ''}`;
  } catch (err) {
    await page.screenshot({ path: path.join(destDir, `failed-ppl-${manager.id}.png`) }).catch(() => {});
    throw err;
  } finally {
    await page.close().catch(() => {});
  }
}

async function run(args) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const destDir = path.join(OUT_DIR, `ppl-${stamp}`);
  fs.mkdirSync(destDir, { recursive: true });
  let context;
  try { context = await openBrowser(Boolean(args.headless)); } catch (err) {
    if (/No bot profile/.test(err.message)) throw new NeedsLogin(err.message);
    throw err;
  }
  let failed = 0;
  try {
    const first = context.pages()[0] || await context.newPage();
    let managers = await listManagers(first);
    if (args.only) managers = managers.filter((m) => m.name.toLowerCase().includes(String(args.only).toLowerCase()));
    if (!managers.length) throw new Error('No manager accounts found on the Google Ads account picker.');
    console.log(`${managers.length} manager accounts`);
    // One at a time: the picker and the leads table are heavy pages, and there are only ~17 managers.
    for (const m of managers) {
      try {
        const line = await exportManager(context, m, destDir, Boolean(args.submit))
          .catch((err) => { if (err instanceof NeedsLogin) throw err; return exportManager(context, m, destDir, Boolean(args.submit)); });
        console.log(`${m.name} (${m.id}): ${line}`);
      } catch (err) {
        failed++;
        console.log(`${m.name} (${m.id}): FAILED ${err.message.split('\n')[0]}`);
        if (err instanceof NeedsLogin) break;
      }
    }
    console.log(failed ? `${failed} accounts failed` : 'All accounts done');
    console.log(`Files: ${destDir}`);
  } finally {
    await context.close().catch(() => {});
  }
  return failed ? 1 : 0;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args._[0] === 'run') return run(args);
  console.log('Usage: node pplBot.js run [--only text] [--headless] [--submit]');
  return 64;
}

if (require.main === module) {
  main().then((code) => process.exit(code), (err) => {
    console.error(err instanceof NeedsLogin ? `needs login: ${err.message}` : err);
    process.exit(err instanceof NeedsLogin ? 2 : 1);
  });
}

module.exports = { listManagers, openLeads, downloadCsv, summarize };
