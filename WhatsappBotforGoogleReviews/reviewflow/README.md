# ReviewFlow — WhatsApp Google Review Bot (Demo)

A WhatsApp chatbot that asks customers for a rating after payment, then
routes them to a Google review (happy) or a private feedback form (sad).
Built with **mock data** — no real client integration.

## ⚠️ Compliance note — read this first

The sad-path in this bot **does not** show the Google review link — by
explicit project decision, matching the original spec exactly. This is
"review gating," which Google's current review policy prohibits. It's
safe as a demo with mock data, but **do not connect this to a real
client's real WhatsApp number or Google Business Profile** without first
changing the flow so the Google link is reachable regardless of
sentiment (see `src/config/constants.js` and `src/routes/webhook.js` for
exactly where that logic lives).

## 5-minute quick start

```bash
npm install
cp .env.example .env       # works as-is for a mock-only demo
npm run verify              # sanity-checks your setup
npm start                   # http://localhost:3000
```

Open `http://localhost:3000`, unlock with the password from `.env`
(`DASHBOARD_PASSWORD`, default `demo123`) — the dashboard is pre-seeded
with 12 mock conversations.

## Full setup (with real Twilio + Hugging Face)

1. **Twilio WhatsApp Sandbox** (free): console.twilio.com → Messaging →
   Try WhatsApp → follow the "join <code>" instructions from your own
   phone → copy Account SID / Auth Token into `.env`.
2. **Hugging Face API key** (your company account): huggingface.co →
   Settings → Access Tokens → create one with read access → paste into
   `HUGGINGFACE_API_KEY` in `.env`.
3. `npm install`
4. `npm run verify` — checks Node version, env vars, and pings both
   Twilio and Hugging Face if real credentials are present.
5. `npm start`
6. Expose locally with ngrok: `ngrok http 3000`
7. In the Twilio sandbox settings, set the incoming webhook URL to
   `https://<your-ngrok-url>/webhook/whatsapp`.
   <!-- http://localhost:3000 -->

## Demo flow walkthrough

1. Open the dashboard, unlock it.
2. Use "Trigger a review request" with your own WhatsApp number (must
   be a verified sandbox test number if using Twilio's sandbox).
3. Reply on WhatsApp with a happy message ("great service!") — you'll
   get the Google review link.
4. Trigger again, reply with a sad message ("bekar tha") — you'll get
   the feedback form link instead, and the mock manager number gets an
   alert (logged to console if Twilio isn't configured).
5. Refresh the dashboard — your real conversation now appears alongside
   the 12 mock ones.

## Deploying to Render.com (bonus)

1. Push this repo to GitHub.
2. New → Web Service → connect the repo.
3. Build command: `npm install`. Start command: `npm start`.
4. Add all `.env` variables under Render's Environment tab.
5. Once deployed, use the Render URL (not ngrok) as your Twilio webhook.

## Known deviations from the original spec (for transparency)

- **AI provider:** Hugging Face instead of Gemini 2.5 Flash — per your
  explicit choice, since it's your company account and matches the main
  MERN app. `src/services/huggingface.js` replaces the spec's `gemini.js`.
- **Storage:** a JSON file (`src/services/storage.js`) instead of Google
  Sheets — per your explicit choice ("standalone demo, JSON file, no
  MongoDB"). Spec listed this file as `sheets.js`; kept the same role,
  renamed for clarity since it isn't calling the Sheets API.
- **Comments:** concise inline comments rather than full JSDoc on every
  function, to keep the build efficient as requested. Every file still
  has a header comment explaining its role.
- **Sentiment gating:** kept exactly as specified (sad → no Google link)
  per your explicit confirmation — see the compliance note above and in
  the code.

## Folder structure

```
reviewflow/
├── package.json / .env.example / .gitignore / server.js / README.md
├── data/conversations.json      # created on first run, JSON "database"
├── src/
│   ├── config/constants.js      # states, sentiments, demo business info, compliance note
│   ├── routes/
│   │   ├── webhook.js           # Twilio inbound message + state machine
│   │   ├── dashboard.js         # GET /api/dashboard/data (password-protected)
│   │   └── api.js               # POST /api/trigger-review (manual demo trigger)
│   ├── services/
│   │   ├── huggingface.js       # AI sentiment client (replaces spec's gemini.js)
│   │   ├── sentiment.js         # business-logic wrapper around huggingface.js
│   │   ├── twilio.js            # WhatsApp send + signature validation
│   │   ├── storage.js           # JSON-file store (replaces spec's sheets.js)
│   │   └── logger.js            # [INFO]/[ERROR] console logger
│   ├── middleware/
│   │   ├── rateLimiter.js, validator.js, errorHandler.js
│   ├── utils/
│   │   ├── hinglishTemplates.js # 5 variations per scenario
│   │   └── mockData.js          # 12 seeded fake conversations
│   └── public/
│       ├── index.html, dashboard.js, style.css
└── scripts/verify-setup.js
```
