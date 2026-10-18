import { readFile } from 'node:fs/promises';
import { join, extname, normalize } from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import { normalizePhone, firstName } from './phone.js';
import { csvToRecords, isTruthy } from './csv.js';
import { validateTwilioSignature } from './twilio.js';

const OPT_OUT_WORDS = new Set(['STOP', 'STOPALL', 'UNSUBSCRIBE', 'CANCEL', 'END', 'QUIT', 'OPT OUT', 'OPTOUT']);
const OPT_IN_WORDS = new Set(['START', 'UNSTOP', 'SUBSCRIBE', 'OPT IN', 'OPTIN']);

// Twilio callbacks can arrive out of order; never move a message backwards.
const STATUS_RANK = { queued: 0, accepted: 0, sending: 1, sent: 2, delivered: 3, read: 4, failed: 5, undelivered: 5 };

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png' };
const MAX_BODY_BYTES = 5 * 1024 * 1024;

export function createApp({ db, twilio, config, publicDir }) {
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  const q = {
    listContacts: db.prepare(`SELECT * FROM contacts ORDER BY name COLLATE NOCASE`),
    getContact: db.prepare(`SELECT * FROM contacts WHERE id = ?`),
    getContactByPhone: db.prepare(`SELECT * FROM contacts WHERE phone = ?`),
    insertContact: db.prepare(`INSERT INTO contacts (name, phone, notes, consent) VALUES (?, ?, ?, ?)`),
    updateContact: db.prepare(`UPDATE contacts SET name = ?, phone = ?, notes = ?, consent = ?, opted_out = ? WHERE id = ?`),
    deleteContact: db.prepare(`DELETE FROM contacts WHERE id = ?`),
    setOptOut: db.prepare(`UPDATE contacts SET opted_out = ? WHERE phone = ?`),
    touchContact: db.prepare(`UPDATE contacts SET last_contacted_at = datetime('now') WHERE id = ?`),
    listCampaigns: db.prepare(`
      SELECT c.*,
        COUNT(m.id) AS total,
        SUM(m.status IN ('sent','delivered','read','simulated')) AS sent,
        SUM(m.status IN ('delivered','read')) AS delivered,
        SUM(m.status = 'read') AS read,
        SUM(m.status IN ('failed','undelivered')) AS failed,
        SUM(m.status IN ('queued','sending','accepted')) AS pending
      FROM campaigns c LEFT JOIN messages m ON m.campaign_id = c.id
      GROUP BY c.id ORDER BY c.id DESC`),
    getCampaign: db.prepare(`SELECT * FROM campaigns WHERE id = ?`),
    insertCampaign: db.prepare(`INSERT INTO campaigns (name, content_sid, body) VALUES (?, ?, ?)`),
    campaignMessages: db.prepare(`
      SELECT m.*, ct.name, ct.phone FROM messages m JOIN contacts ct ON ct.id = m.contact_id
      WHERE m.campaign_id = ? ORDER BY m.id`),
    insertMessage: db.prepare(`INSERT OR IGNORE INTO messages (campaign_id, contact_id) VALUES (?, ?)`),
    pendingMessages: db.prepare(`
      SELECT m.id, ct.id AS contact_id, ct.name, ct.phone, ct.consent, ct.opted_out
      FROM messages m JOIN contacts ct ON ct.id = m.contact_id
      WHERE m.campaign_id = ? AND m.status = 'queued' AND m.twilio_sid IS NULL ORDER BY m.id`),
    markMessage: db.prepare(`UPDATE messages SET twilio_sid = ?, status = ?, error = ?, updated_at = datetime('now') WHERE id = ?`),
    getMessageBySid: db.prepare(`SELECT * FROM messages WHERE twilio_sid = ?`),
    updateMessageStatus: db.prepare(`UPDATE messages SET status = ?, error = ?, updated_at = datetime('now') WHERE id = ?`),
  };

  function eligible(contact) {
    return contact.consent === 1 && contact.opted_out === 0;
  }

  function renderBody(template, contact) {
    return template
      .replaceAll('{first_name}', firstName(contact.name))
      .replaceAll('{name}', contact.name);
  }

  function contactInput(body, existing = {}) {
    const name = String(body.name ?? existing.name ?? '').trim();
    const phone = normalizePhone(body.phone ?? existing.phone, config.defaultCountryCode);
    if (!name) throw httpError(400, 'Name is required');
    if (!phone) throw httpError(400, 'Phone number is not valid');
    return {
      name,
      phone,
      notes: String(body.notes ?? existing.notes ?? '').trim(),
      consent: body.consent === undefined ? (existing.consent ?? 0) : (body.consent ? 1 : 0),
      opted_out: body.opted_out === undefined ? (existing.opted_out ?? 0) : (body.opted_out ? 1 : 0),
    };
  }

  // Sends a campaign's queued messages one at a time. Runs in the background.
  const running = new Set();
  async function runCampaign(campaignId) {
    if (running.has(campaignId)) return;
    running.add(campaignId);
    try {
      const campaign = q.getCampaign.get(campaignId);
      for (const msg of q.pendingMessages.all(campaignId)) {
        // Re-check at send time: someone may have opted out since the campaign was created.
        if (!eligible(msg)) {
          q.markMessage.run(null, 'skipped', msg.opted_out ? 'Contact opted out' : 'No consent recorded', msg.id);
          continue;
        }
        try {
          const result = await twilio.sendWhatsApp({
            to: msg.phone,
            contentSid: campaign.content_sid || undefined,
            contentVariables: campaign.content_sid ? { 1: firstName(msg.name) } : undefined,
            body: campaign.content_sid ? undefined : renderBody(campaign.body, msg),
          });
          q.markMessage.run(result.sid, result.status || 'queued', null, msg.id);
          q.touchContact.run(msg.contact_id);
        } catch (err) {
          q.markMessage.run(null, 'failed', err.message, msg.id);
        }
        if (config.sendDelayMs > 0) await sleep(config.sendDelayMs);
      }
    } finally {
      running.delete(campaignId);
    }
  }

  const routes = [
    ['GET', /^\/api\/status$/, () => ({
      mode: twilio.live ? 'live' : 'dry-run',
      from: config.twilioFrom || null,
      webhooks: config.publicUrl ? {
        status: `${config.publicUrl}/webhooks/status`,
        inbound: `${config.publicUrl}/webhooks/inbound`,
      } : null,
    })],

    ['GET', /^\/api\/contacts$/, () => q.listContacts.all()],

    ['POST', /^\/api\/contacts$/, async (req) => {
      const c = contactInput(await readJson(req));
      if (q.getContactByPhone.get(c.phone)) throw httpError(409, 'A contact with this number already exists');
      const { lastInsertRowid } = q.insertContact.run(c.name, c.phone, c.notes, c.consent);
      return q.getContact.get(lastInsertRowid);
    }],

    ['PUT', /^\/api\/contacts\/(\d+)$/, async (req, [id]) => {
      const existing = q.getContact.get(id);
      if (!existing) throw httpError(404, 'Contact not found');
      const c = contactInput(await readJson(req), existing);
      const clash = q.getContactByPhone.get(c.phone);
      if (clash && clash.id !== existing.id) throw httpError(409, 'Another contact already uses this number');
      q.updateContact.run(c.name, c.phone, c.notes, c.consent, c.opted_out, id);
      return q.getContact.get(id);
    }],

    ['DELETE', /^\/api\/contacts\/(\d+)$/, (req, [id]) => {
      q.deleteContact.run(id);
      return { ok: true };
    }],

    ['POST', /^\/api\/contacts\/import$/, async (req) => {
      const { csv } = await readJson(req);
      const result = { added: 0, updated: 0, errors: [] };
      for (const { line, record } of csvToRecords(csv ?? '')) {
        try {
          const c = contactInput({
            name: record.name ?? [record['first name'], record['last name']].filter(Boolean).join(' '),
            phone: record.phone ?? record.number ?? record.mobile,
            notes: record.notes ?? '',
            consent: isTruthy(record.consent ?? record['opted in']),
          });
          const existing = q.getContactByPhone.get(c.phone);
          if (existing) {
            // Never clear an opt-out via import.
            q.updateContact.run(c.name, c.phone, c.notes || existing.notes, c.consent || existing.consent, existing.opted_out, existing.id);
            result.updated++;
          } else {
            q.insertContact.run(c.name, c.phone, c.notes, c.consent);
            result.added++;
          }
        } catch (err) {
          result.errors.push({ line, error: err.message });
        }
      }
      return result;
    }],

    ['GET', /^\/api\/campaigns$/, () => q.listCampaigns.all()],

    ['GET', /^\/api\/campaigns\/(\d+)$/, (req, [id]) => {
      const campaign = q.getCampaign.get(id);
      if (!campaign) throw httpError(404, 'Campaign not found');
      return { ...campaign, sending: running.has(Number(id)), messages: q.campaignMessages.all(id) };
    }],

    ['POST', /^\/api\/campaigns$/, async (req) => {
      const body = await readJson(req);
      const name = String(body.name ?? '').trim();
      const contentSid = String(body.contentSid ?? '').trim();
      const text = String(body.body ?? '').trim();
      if (!name) throw httpError(400, 'Campaign name is required');
      if (!contentSid && !text) throw httpError(400, 'Provide an approved template (Content SID) or a message');
      if (contentSid && !/^HX[0-9a-f]{32}$/i.test(contentSid)) throw httpError(400, 'Content SID should look like HX followed by 32 characters');

      const ids = Array.isArray(body.contactIds) && body.contactIds.length
        ? body.contactIds.map(Number)
        : q.listContacts.all().map(c => c.id);
      const recipients = ids.map(id => q.getContact.get(id)).filter(c => c && eligible(c));
      if (!recipients.length) throw httpError(400, 'No eligible contacts (they need consent and must not have opted out)');

      let campaignId;
      db.exec('BEGIN');
      try {
        campaignId = Number(q.insertCampaign.run(name, contentSid, text).lastInsertRowid);
        for (const c of recipients) q.insertMessage.run(campaignId, c.id);
        db.exec('COMMIT');
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
      runCampaign(campaignId).catch(err => console.error(`Campaign ${campaignId} failed:`, err));
      return { id: campaignId, recipients: recipients.length };
    }],

    ['POST', /^\/webhooks\/status$/, async (req) => {
      const params = await readTwilioForm(req, '/webhooks/status');
      const msg = q.getMessageBySid.get(params.MessageSid ?? '');
      const status = params.MessageStatus;
      if (msg && status in STATUS_RANK && (STATUS_RANK[status] >= (STATUS_RANK[msg.status] ?? -1))) {
        const error = params.ErrorCode ? `Error ${params.ErrorCode}${params.ErrorMessage ? ': ' + params.ErrorMessage : ''}` : null;
        q.updateMessageStatus.run(status, error, msg.id);
      }
      return { text: '' };
    }],

    ['POST', /^\/webhooks\/inbound$/, async (req) => {
      const params = await readTwilioForm(req, '/webhooks/inbound');
      const phone = normalizePhone(params.From, config.defaultCountryCode);
      const word = String(params.Body ?? '').trim().toUpperCase().replace(/[.!]+$/, '');
      if (phone && OPT_OUT_WORDS.has(word)) {
        q.setOptOut.run(1, phone);
        return twiml("You've been unsubscribed and won't receive further messages. Reply START to opt back in.");
      }
      if (phone && OPT_IN_WORDS.has(word)) {
        q.setOptOut.run(0, phone);
        return twiml("You're subscribed again. Reply STOP at any time to opt out.");
      }
      return twiml('');
    }],
  ];

  async function readTwilioForm(req, path) {
    const raw = await readBody(req);
    const params = Object.fromEntries(new URLSearchParams(raw));
    if (twilio.live) {
      const url = `${config.publicUrl}${path}`;
      if (!validateTwilioSignature(config.twilioAuthToken, req.headers['x-twilio-signature'], url, params)) {
        throw httpError(403, 'Invalid Twilio signature');
      }
    }
    return params;
  }

  function authorized(req) {
    const header = req.headers.authorization ?? '';
    if (!header.startsWith('Basic ')) return false;
    const [user, ...rest] = Buffer.from(header.slice(6), 'base64').toString().split(':');
    const given = Buffer.from(rest.join(':'));
    const expected = Buffer.from(config.adminPassword);
    return user === 'admin' && given.length === expected.length && timingSafeEqual(given, expected);
  }

  async function serveStatic(res, pathname) {
    const rel = normalize(pathname === '/' ? '/index.html' : pathname).replace(/^(\.\.[/\\])+/, '');
    const type = MIME[extname(rel)];
    if (!type) return false;
    try {
      const data = await readFile(join(publicDir, rel));
      res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache' });
      res.end(data);
      return true;
    } catch {
      return false;
    }
  }

  return async function handle(req, res) {
    const { pathname } = new URL(req.url, 'http://localhost');
    try {
      if (!pathname.startsWith('/webhooks/') && !authorized(req)) {
        res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Re-engage", charset="UTF-8"', 'Content-Type': 'text/plain' });
        return res.end('Authentication required');
      }

      for (const [method, pattern, handler] of routes) {
        const match = pathname.match(pattern);
        if (!match) continue;
        if (req.method !== method) continue;
        const result = await handler(req, match.slice(1));
        if (result && typeof result.text === 'string') {
          res.writeHead(200, { 'Content-Type': result.type ?? 'text/plain' });
          return res.end(result.text);
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify(result));
      }

      if (req.method === 'GET' && await serveStatic(res, pathname)) return;
      throw httpError(404, 'Not found');
    } catch (err) {
      const status = err.status ?? 500;
      if (status === 500) console.error(err);
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: status === 500 ? 'Internal error' : err.message }));
    }
  };
}

function twiml(message) {
  const escaped = message.replace(/[<>&]/g, ch => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' })[ch]);
  const inner = message ? `<Message>${escaped}</Message>` : '';
  return { type: 'text/xml', text: `<?xml version="1.0" encoding="UTF-8"?><Response>${inner}</Response>` };
}

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw httpError(413, 'Request too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function readJson(req) {
  try {
    return JSON.parse((await readBody(req)) || '{}');
  } catch (err) {
    if (err.status) throw err;
    throw httpError(400, 'Invalid JSON');
  }
}
