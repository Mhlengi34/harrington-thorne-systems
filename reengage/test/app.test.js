import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHmac } from 'node:crypto';
import { openDatabase } from '../lib/db.js';
import { createApp } from '../lib/app.js';
import { normalizePhone } from '../lib/phone.js';
import { parseCsv } from '../lib/csv.js';
import { validateTwilioSignature } from '../lib/twilio.js';

const PASSWORD = 'test-pass';
const AUTH = 'Basic ' + Buffer.from(`admin:${PASSWORD}`).toString('base64');
const AUTH_TOKEN = 'secret-token';
const PUBLIC_URL = 'https://example.test';
const sent = [];

let server, base;

before(async () => {
  const twilio = {
    live: true,
    async sendWhatsApp(msg) {
      sent.push(msg);
      if (msg.to === '+27820000000') throw new Error('Twilio 63016: outside window');
      return { sid: 'SM' + sent.length, status: 'queued' };
    },
  };
  const config = { adminPassword: PASSWORD, publicUrl: PUBLIC_URL, twilioAuthToken: AUTH_TOKEN, defaultCountryCode: '27', sendDelayMs: 0 };
  const handler = createApp({ db: openDatabase(':memory:'), twilio, config, publicDir: new URL('../public', import.meta.url).pathname });
  server = createServer(handler);
  await new Promise(r => server.listen(0, r));
  base = `http://localhost:${server.address().port}`;
});

after(() => server.close());

async function api(path, { method = 'GET', body, auth = AUTH } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: auth } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, data: await res.json().catch(() => null) };
}

function signedWebhook(path, params, token = AUTH_TOKEN) {
  const data = Object.keys(params).sort().reduce((acc, k) => acc + k + params[k], PUBLIC_URL + path);
  const signature = createHmac('sha1', token).update(data).digest('base64');
  return fetch(base + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Twilio-Signature': signature },
    body: new URLSearchParams(params),
  });
}

async function waitForCampaign(id) {
  for (let i = 0; i < 50; i++) {
    const { data } = await api(`/api/campaigns/${id}`);
    if (!data.sending && data.messages.every(m => m.status !== 'queued' || m.twilio_sid)) return data;
    await new Promise(r => setTimeout(r, 20));
  }
  throw new Error('Campaign did not finish');
}

test('normalizes South African numbers', () => {
  assert.equal(normalizePhone('082 123 4567'), '+27821234567');
  assert.equal(normalizePhone('+27 82-123-4567'), '+27821234567');
  assert.equal(normalizePhone('0027821234567'), '+27821234567');
  assert.equal(normalizePhone('whatsapp:+27821234567'), '+27821234567');
  assert.equal(normalizePhone('12'), null);
  assert.equal(normalizePhone('not a number'), null);
});

test('parses quoted CSV fields', () => {
  assert.deepEqual(parseCsv('a,b\r\n"x, y","he said ""hi"""\n'), [['a', 'b'], ['x, y', 'he said "hi"']]);
});

test('rejects requests without the dashboard password', async () => {
  assert.equal((await api('/api/contacts', { auth: null })).status, 401);
  const wrong = 'Basic ' + Buffer.from('admin:nope').toString('base64');
  assert.equal((await api('/api/contacts', { auth: wrong })).status, 401);
});

test('validates Twilio signatures', () => {
  const params = { Body: 'STOP', From: 'whatsapp:+27821234567' };
  const data = PUBLIC_URL + '/x' + 'BodySTOPFromwhatsapp:+27821234567';
  const sig = createHmac('sha1', AUTH_TOKEN).update(data).digest('base64');
  assert.ok(validateTwilioSignature(AUTH_TOKEN, sig, PUBLIC_URL + '/x', params));
  assert.ok(!validateTwilioSignature(AUTH_TOKEN, sig, PUBLIC_URL + '/y', params));
});

test('full flow: import, send campaign, status updates and opt-out', async () => {
  const csv = [
    'name,phone,notes,consent',
    'Thandi Mokoena,082 111 2222,VIP,yes',
    'Sipho Dlamini,+27 83 333 4444,,no',
    '"Naidoo, Priya",0841115555,,yes',
    'Broken,123,,yes',
    'Window Fail,0820000000,,yes',
  ].join('\n');
  const imported = await api('/api/contacts/import', { method: 'POST', body: { csv } });
  assert.equal(imported.data.added, 4);
  assert.equal(imported.data.errors.length, 1);
  assert.equal(imported.data.errors[0].line, 5);

  const dup = await api('/api/contacts', { method: 'POST', body: { name: 'Dup', phone: '0821112222' } });
  assert.equal(dup.status, 409);

  const { data: contacts } = await api('/api/contacts');
  const allIds = contacts.map(c => c.id);

  const bad = await api('/api/campaigns', { method: 'POST', body: { name: 'x', contentSid: 'nope' } });
  assert.equal(bad.status, 400);

  const created = await api('/api/campaigns', {
    method: 'POST',
    body: { name: 'October', body: 'Hi {first_name}, we miss you!', contactIds: allIds },
  });
  assert.equal(created.status, 200);
  assert.equal(created.data.recipients, 3, 'contact without consent is excluded');

  const campaign = await waitForCampaign(created.data.id);
  const thandi = sent.find(m => m.to === '+27821112222');
  assert.equal(thandi.body, 'Hi Thandi, we miss you!');
  assert.ok(!sent.some(m => m.to === '+27833334444'), 'no message to non-consenting contact');
  const failed = campaign.messages.find(m => m.phone === '+27820000000');
  assert.equal(failed.status, 'failed');
  assert.match(failed.error, /63016/);

  // Template campaign passes the first name as variable 1.
  const tpl = await api('/api/campaigns', {
    method: 'POST',
    body: { name: 'Template', contentSid: 'HX' + 'a'.repeat(32), contactIds: [contacts.find(c => c.phone === '+27841115555').id] },
  });
  await waitForCampaign(tpl.data.id);
  const priyaMsg = sent.at(-1);
  assert.equal(priyaMsg.contentSid, 'HX' + 'a'.repeat(32));
  assert.deepEqual(priyaMsg.contentVariables, { 1: 'Naidoo' });

  // Status callbacks update the message, and never move it backwards.
  const sid = campaign.messages.find(m => m.phone === '+27821112222').twilio_sid;
  assert.equal((await signedWebhook('/webhooks/status', { MessageSid: sid, MessageStatus: 'delivered' })).status, 200);
  await signedWebhook('/webhooks/status', { MessageSid: sid, MessageStatus: 'sent' });
  let detail = (await api(`/api/campaigns/${created.data.id}`)).data;
  assert.equal(detail.messages.find(m => m.twilio_sid === sid).status, 'delivered');

  // Unsigned or wrongly signed webhooks are rejected.
  assert.equal((await signedWebhook('/webhooks/status', { MessageSid: sid, MessageStatus: 'read' }, 'wrong')).status, 403);

  // STOP opts the contact out, and they are excluded from later campaigns.
  const stop = await signedWebhook('/webhooks/inbound', { From: 'whatsapp:+27821112222', Body: ' stop ' });
  assert.match(await stop.text(), /unsubscribed/);
  const thandiContact = (await api('/api/contacts')).data.find(c => c.phone === '+27821112222');
  assert.equal(thandiContact.opted_out, 1);

  const again = await api('/api/campaigns', { method: 'POST', body: { name: 'Again', body: 'Hi', contactIds: [thandiContact.id] } });
  assert.equal(again.status, 400);

  // Re-importing doesn't clear an opt-out.
  await api('/api/contacts/import', { method: 'POST', body: { csv: 'name,phone,consent\nThandi Mokoena,0821112222,yes' } });
  assert.equal((await api('/api/contacts')).data.find(c => c.phone === '+27821112222').opted_out, 1);

  // START opts them back in.
  await signedWebhook('/webhooks/inbound', { From: 'whatsapp:+27821112222', Body: 'START' });
  assert.equal((await api('/api/contacts')).data.find(c => c.phone === '+27821112222').opted_out, 0);
});

test('serves the dashboard', async () => {
  const res = await fetch(base + '/', { headers: { Authorization: AUTH } });
  assert.equal(res.status, 200);
  assert.match(await res.text(), /Re-engage/);
  const traversal = await fetch(base + '/../server.js', { headers: { Authorization: AUTH } });
  assert.notEqual(traversal.status, 200);
});
