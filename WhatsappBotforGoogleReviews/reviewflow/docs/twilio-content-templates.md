# Twilio Interactive "List Picker" Content Templates

The bot can send the category menus as clickable WhatsApp list pickers instead of
plain numbered text. A list picker is a real interactive message: the customer
taps an option instead of typing a number. When they tap, WhatsApp replies with
the tapped item's title as normal text, so **no changes to reply parsing were
needed**.

## How it works

- Each menu is a `twilio/list-picker` **Content Template** stored in Twilio.
- Each template gets a **Content SID** (starts with `HX...`).
- The bot sends the menu via the Content API (`contentSid`) instead of a plain
  `body` string.
- If a Content SID is missing (template not created yet) the bot gracefully
  falls back to the original plain-text numbered menu, so nothing breaks.

## Templates used by the bot

| Menu | Sent when | Content SID env var |
|---|---|---|
| Review options (Staff/Service, Food/Product, Ambience/Location, Everything was great) | Happy customer | `TWILIO_CONTENT_SID_REVIEW_OPTIONS` |
| Feedback options – sad (Staff behavior, Food/Product quality, Waiting time, Something else) | Sad customer | `TWILIO_CONTENT_SID_FEEDBACK_SAD` |
| Feedback options – neutral (Staff/Service, Food/Product, Ambience, Something else) | Neutral customer | `TWILIO_CONTENT_SID_FEEDBACK_NEUTRAL` |

## Manual steps (Twilio Console)

1. Log in at [console.twilio.com](https://console.twilio.com).
2. Go to **Messaging → Content Editor → Create new content**.
3. Pick the **WhatsApp** channel and the **List picker** type.
4. Enter the body text and list items shown below for each template.
5. Click **Save** (no Meta approval needed for in-session use; submit to WhatsApp
   only if you also need it as a first message).
6. Copy the **Content SID** shown for the template (`HX...`).
7. Add it to your `.env` (see the table above for the variable names).
8. Restart the bot (`node server.js`).

### Template 1 — Review options (happy)

**Body:** `That's great to hear! What did you enjoy most?`

**Button text:** `Choose an option`

| Item title |
|---|
| Staff / Service |
| Food / Product |
| Ambience / Location |
| Everything was great |

### Template 2 — Feedback options (sad)

**Body:** `Sorry to hear that. What went wrong?`

**Button text:** `Choose an option`

| Item title |
|---|
| Staff behavior |
| Food / Product quality |
| Waiting time |
| Something else |

### Template 3 — Feedback options (neutral)

**Body:** `Thanks for letting us know. What could be better?`

**Button text:** `Choose an option`

| Item title |
|---|
| Staff / Service |
| Food / Product |
| Ambience |
| Something else |

> Item titles must match the existing option labels so the incoming reply is
> still parsed correctly (e.g. tapping "Staff / Service" is caught by the same
> keyword matching as before).

## Creating the templates via API (optional)

If you prefer to create them programmatically, use the Twilio Content API. Each
template is a `twilio/list-picker` content type:

```json
{
  "type": "twilio/list-picker",
  "body": "That's great to hear! What did you enjoy most?",
  "actions": {
    "button": "Choose an option",
    "sections": [
      {
        "title": "Options",
        "items": [
          { "id": "1", "title": "Staff / Service" },
          { "id": "2", "title": "Food / Product" },
          { "id": "3", "title": "Ambience / Location" },
          { "id": "4", "title": "Everything was great" }
        ]
      }
    ]
  }
}
```

Example with curl:

```bash
curl -X POST https://content.twilio.com/v1/Content \
  -u "ACCOUNT_SID:AUTH_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"friendly_name":"review_options","variables":{},"types":{"twilio/list-picker":{ ... }}}'
```

The response contains the `sid` (Content SID) to put in `.env`.

## Notes / limitations

- WhatsApp list pickers support up to 10 items per section — plenty for these 4-option menus.
- List picker items can have a max title length of 24 characters.
- Templates are matched by `contentSid`; the `bodyText` passed to
  `sendInteractiveList` is only used as the plain-text fallback.
- The **escalation** and **draft** (Yes/No) menus still use plain text — only the
  two category menus were converted.
