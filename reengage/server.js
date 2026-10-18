import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { openDatabase } from './lib/db.js';
import { createTwilioClient } from './lib/twilio.js';
import { createApp } from './lib/app.js';

const here = dirname(fileURLToPath(import.meta.url));
if (existsSync(join(here, '.env'))) process.loadEnvFile(join(here, '.env'));

const env = process.env;
if (!env.ADMIN_PASSWORD) {
  console.error('ADMIN_PASSWORD is not set. Copy .env.example to .env and set a password.');
  process.exit(1);
}

const config = {
  adminPassword: env.ADMIN_PASSWORD,
  publicUrl: (env.PUBLIC_URL ?? '').replace(/\/+$/, ''),
  twilioAuthToken: env.TWILIO_AUTH_TOKEN,
  twilioFrom: env.TWILIO_WHATSAPP_FROM,
  defaultCountryCode: env.DEFAULT_COUNTRY_CODE || '27',
  sendDelayMs: Number(env.SEND_DELAY_MS ?? 1000),
};

const twilio = createTwilioClient({
  accountSid: env.TWILIO_ACCOUNT_SID,
  authToken: env.TWILIO_AUTH_TOKEN,
  from: env.TWILIO_WHATSAPP_FROM,
  statusCallback: config.publicUrl ? `${config.publicUrl}/webhooks/status` : undefined,
});

if (twilio.live && !config.publicUrl) {
  console.warn('PUBLIC_URL is not set: delivery statuses and STOP replies will not be received.');
}

const db = openDatabase(resolve(here, env.DATABASE_PATH || './data/reengage.db'));
const handler = createApp({ db, twilio, config, publicDir: join(here, 'public') });
const port = Number(env.PORT || 3000);

createServer(handler).listen(port, () => {
  console.log(`Re-engage dashboard running at http://localhost:${port} (${twilio.live ? 'LIVE' : 'dry-run'} mode)`);
});
