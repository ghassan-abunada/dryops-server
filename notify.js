'use strict';
// ── Staff notifications (Telegram / Slack) ───────────────────────────────────
// Per-location channels live in public.notification_channels
// { kind: 'telegram' | 'slack', config: { bot_token, chat_id } | { webhook_url },
//   events: text[], location_id: uuid | null, active }.
// Extracted from intake.js (New Job alerts) so homeowner.js can post portal
// requests to the SAME channels. A message is { lines: (string | {b: string})[],
// buttons: [{ text, url }] } — `{b}` lines render bold.

const clean = (v, max = 200) => (v === undefined || v === null ? '' : String(v)).trim().slice(0, max);
const escHtml = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

async function sendTelegram(cfg, msg) {
  const token = clean(cfg.bot_token, 200), chat = clean(cfg.chat_id, 64);
  if (!token || !chat) return { ok: false, error: 'Telegram bot_token / chat_id missing' };
  const text = msg.lines.map((l) => (typeof l === 'string' ? escHtml(l) : `<b>${escHtml(l.b)}</b>`)).join('\n');
  const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chat, text, parse_mode: 'HTML', disable_web_page_preview: true,
      reply_markup: { inline_keyboard: msg.buttons.map((b) => [{ text: b.text, url: b.url }]) } }),
  });
  const j = await r.json().catch(() => null);
  return r.ok && j && j.ok ? { ok: true } : { ok: false, error: (j && j.description) || `Telegram ${r.status}` };
}

async function sendSlack(cfg, msg) {
  const url = clean(cfg.webhook_url, 300);
  if (!/^https:\/\/hooks\.slack\.com\//.test(url)) return { ok: false, error: 'Slack webhook_url must start with https://hooks.slack.com/' };
  const text = msg.lines.map((l) => (typeof l === 'string' ? l : `*${l.b}*`)).join('\n');
  const r = await fetch(url, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, blocks: [
      { type: 'section', text: { type: 'mrkdwn', text } },
      { type: 'actions', elements: msg.buttons.map((b) => ({ type: 'button', text: { type: 'plain_text', text: b.text }, url: b.url })) },
    ] }),
  });
  return r.ok ? { ok: true } : { ok: false, error: `Slack ${r.status} ${(await r.text()).slice(0, 120)}` };
}

async function deliver(channel, msg) {
  const cfg = channel.config || {};
  return channel.kind === 'telegram' ? sendTelegram(cfg, msg) : channel.kind === 'slack' ? sendSlack(cfg, msg) : { ok: false, error: 'Unknown channel kind' };
}

// Active channels for a location (plus company-wide ones with location_id
// null) subscribed to ANY of `events`.
async function loadChannels(sbGet, events, locationId) {
  const evs = (Array.isArray(events) ? events : [events]).filter(Boolean);
  if (!evs.length) return [];
  const evFilter = evs.length === 1 ? `events.cs.{${evs[0]}}` : `or(${evs.map((e) => `events.cs.{${e}}`).join(',')})`;
  const locFilter = locationId ? `or(location_id.is.null,location_id.eq.${encodeURIComponent(String(locationId))})` : 'location_id.is.null';
  const rows = await sbGet(`notification_channels?active=eq.true&and=(${evFilter},${locFilter})&select=id,kind,name,config,location_id`);
  return Array.isArray(rows) ? rows : [];
}

// Fan out one message; failures are logged, never thrown.
async function notifyChannels({ sbGet, events, locationId, msg, log }) {
  const warn = log || ((...a) => console.warn('[notify]', ...a));
  let channels = [];
  try { channels = await loadChannels(sbGet, events, locationId); } catch (e) { warn('channels lookup failed', e.message); return 0; }
  let sent = 0;
  for (const ch of channels) {
    const r = await deliver(ch, msg).catch((e) => ({ ok: false, error: e.message }));
    if (r.ok) sent += 1; else warn(ch.kind, ch.name, r.error);
  }
  return sent;
}

module.exports = { sendTelegram, sendSlack, deliver, loadChannels, notifyChannels, escHtml };
