# ReviewFlow — Demo Script

Use this as your exact walkthrough when presenting to the Zuigo team.

## 1. Set the scene (30 seconds)

"This is ReviewFlow — a WhatsApp bot that asks every customer for a
rating right after payment, and routes them differently based on how
they answer. Everything you're about to see is running on mock data —
no real client is connected."

## 2. Show the dashboard (1 minute)

- Open `http://localhost:3000`, unlock with the password.
- Point out: total messages, happy/neutral/sad split (pie chart), and
  the 12 pre-seeded mock conversations in the table.

## 3. Trigger a live conversation (2 minutes)

- In "Trigger a review request," enter your own WhatsApp number.
- Click send — show the WhatsApp message arriving on your phone.
- Reply with a happy message ("Great service, loved it!").
- Show the bot's reply with the Google review link.

## 4. Show the sad path (2 minutes)

- Trigger again.
- Reply with something negative ("Bekar experience, bahut slow tha").
- Show the bot's reply — feedback form link, no Google link.
- Mention (openly, to the room): "This is a deliberate choice for this
  demo — worth knowing that Google's current policy calls this
  pattern 'review gating' and restricts it. We built it this way on
  purpose for now; flagging it so it's a conscious decision if this
  ever goes to a real client."

## 5. Refresh the dashboard (30 seconds)

- Show both new conversations now appear in the recent table and the
  pie chart updated.

## 6. Close (30 seconds)

"This whole flow — WhatsApp in, AI sentiment classification, branching
reply, dashboard logging — runs on Twilio's free sandbox and a Hugging
Face API key, so the marginal cost of running this demo is zero."

---

**Total time: ~7 minutes.** Keep your phone charged and WhatsApp open
before starting — that's the only real dependency for a smooth demo.
