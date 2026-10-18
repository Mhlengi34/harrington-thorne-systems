# Re-engage

A small dashboard for re-engaging past clients on WhatsApp. Store contacts, write a
message, and send it to everyone (or a selection) through Twilio's WhatsApp API.
Delivery and read receipts show up live, and anyone who replies **STOP** is
automatically opted out.

No npm packages are needed — it runs on Node.js 22.13+ alone.

## Quick start (dry run)

```bash
cd reengage
cp .env.example .env      # then set ADMIN_PASSWORD
npm start
```

Open http://localhost:3000 and log in as `admin` with your password. Without Twilio
keys the app runs in **dry-run mode**: everything works, but messages are only
simulated.

## Going live with WhatsApp

1. **Create a Twilio account** at twilio.com and note your Account SID and Auth Token.
2. **Get a WhatsApp sender.**
   - To test: Twilio Console → Messaging → Try it out → *Send a WhatsApp message*
     (the sandbox). Sender is `+14155238886`; each test phone must first send the
     join code to it.
   - For real use: register your business number under Messaging → Senders →
     WhatsApp senders (requires a Meta Business account).
3. **Create a message template.** WhatsApp only allows businesses to start a
   conversation with a Meta-approved template. In Messaging → Content Template
   Builder, create one with category *Marketing* or *Utility*, for example:

   > Hi {{1}}, it's been a while since we last worked together at Harrington Thorne
   > Systems. We'd love to catch up — reply to this message to book a call.
   > Reply STOP to opt out.

   `{{1}}` is filled with each contact's first name. Once approved, copy its
   **Content SID** (starts with `HX`) into the campaign form.
4. **Deploy the app** somewhere with a public HTTPS address (Render, Railway, a VPS,
   or `ngrok http 3000` while testing) and fill in `.env`:
   `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_WHATSAPP_FROM`, `PUBLIC_URL`.
5. **Set the incoming-message webhook.** On your WhatsApp sender (or sandbox
   settings), set *When a message comes in* to `PUBLIC_URL/webhooks/inbound`
   (HTTP POST). This is what makes STOP/START work. Delivery statuses use
   `PUBLIC_URL/webhooks/status`, which the app sets automatically on each message.

The "Free text" option only reaches people who messaged you in the last 24 hours (or
sandbox testers); for re-engagement, use a template.

## Importing contacts

Upload a CSV with a header row. Recognised columns:

| Column    | Notes                                                             |
|-----------|-------------------------------------------------------------------|
| `name`    | Required (or `first name` + `last name`)                          |
| `phone`   | Required. `082 123 4567`, `+27 82 123 4567` and `0027…` all work  |
| `notes`   | Optional                                                          |
| `consent` | `yes` / `true` / `1` if the person agreed to WhatsApp messages    |

Re-importing a number updates the existing contact but never clears an opt-out.

## POPIA compliance

The app is built to help you stay within the Protection of Personal Information Act:

- Only contacts marked as having **consented** can be messaged.
- **STOP** (and similar words) opts people out instantly; they are skipped even
  mid-campaign. **START** opts them back in.
- A contact never receives the same campaign twice.
- Include your business name and an opt-out line ("Reply STOP to opt out") in every
  template.

Only mark consent for people who actually agreed to receive messages from you —
for example, existing clients who gave you their number for that purpose.

## Development

```bash
npm test
```

Data is stored in a SQLite file (`data/reengage.db` by default). Back it up if you
deploy to a server.
