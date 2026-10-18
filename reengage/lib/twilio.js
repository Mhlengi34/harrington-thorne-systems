import { createHmac, timingSafeEqual } from 'node:crypto';

export function createTwilioClient({ accountSid, authToken, from, statusCallback }) {
  const live = Boolean(accountSid && authToken && from);

  async function sendWhatsApp({ to, contentSid, contentVariables, body }) {
    if (!live) {
      return { sid: 'SIMULATED' + Math.random().toString(36).slice(2, 12), status: 'simulated' };
    }
    const params = new URLSearchParams({ From: `whatsapp:${from}`, To: `whatsapp:${to}` });
    if (contentSid) {
      params.set('ContentSid', contentSid);
      if (contentVariables) params.set('ContentVariables', JSON.stringify(contentVariables));
    } else {
      params.set('Body', body);
    }
    if (statusCallback) params.set('StatusCallback', statusCallback);

    const res = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`,
      {
        method: 'POST',
        headers: {
          Authorization: 'Basic ' + Buffer.from(`${accountSid}:${authToken}`).toString('base64'),
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: params,
      },
    );
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data.message ? `Twilio ${data.code ?? res.status}: ${data.message}` : `Twilio HTTP ${res.status}`);
    }
    return { sid: data.sid, status: data.status };
  }

  return { live, sendWhatsApp };
}

// Verifies the X-Twilio-Signature header on an incoming webhook.
// https://www.twilio.com/docs/usage/security#validating-requests
export function validateTwilioSignature(authToken, signature, url, params) {
  if (!authToken || !signature) return false;
  const data = Object.keys(params).sort().reduce((acc, key) => acc + key + params[key], url);
  const expected = createHmac('sha1', authToken).update(data).digest('base64');
  const a = Buffer.from(expected);
  const b = Buffer.from(String(signature));
  return a.length === b.length && timingSafeEqual(a, b);
}
