require('dotenv').config();

const SID = process.env.TWILIO_ACCOUNT_SID;
const TOKEN = process.env.TWILIO_AUTH_TOKEN;

const templates = [
  {
    name: 'reviewflow_review_options',
    body: "That's great to hear! What did you enjoy most?",
    button: 'Choose an option',
    items: [
      { item: 'Staff / Service', id: 'staff-service',        description: 'Tell us what you loved' },
      { item: 'Food / Product',  id: 'food-product',         description: 'Tell us what you loved' },
      { item: 'Ambience / Location', id: 'ambience-location', description: 'Tell us what you loved' },
      { item: 'Everything was great', id: 'everything',       description: 'No complaints at all' },
    ],
  },
  {
    name: 'reviewflow_feedback_sad',
    body: 'Sorry to hear that. What went wrong?',
    button: 'Choose an option',
    items: [
      { item: 'Staff behavior',      id: 'staff',   description: 'How was the staff?' },
      { item: 'Food / Product quality', id: 'food', description: 'How was the food?' },
      { item: 'Waiting time',        id: 'waiting', description: 'How long did you wait?' },
      { item: 'Something else',      id: 'other',   description: 'Anything else' },
    ],
  },
  {
    name: 'reviewflow_feedback_neutral',
    body: 'Thanks for letting us know. What could be better?',
    button: 'Choose an option',
    items: [
      { item: 'Staff / Service',     id: 'staff-service', description: 'How was the staff?' },
      { item: 'Food / Product',      id: 'food-product',  description: 'How was the food?' },
      { item: 'Ambience',            id: 'ambience',      description: 'How was the place?' },
      { item: 'Something else',      id: 'other',         description: 'Anything else' },
    ],
  },
];

async function createTemplate(t) {
  const payload = {
    friendly_name: t.name,
    language: 'en',
    variables: {},
    types: {
      'twilio/list-picker': {
        body: t.body,
        button: t.button,
        items: t.items,
      },
    },
  };
  const res = await fetch('https://content.twilio.com/v1/Content', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Basic ' + Buffer.from(`${SID}:${TOKEN}`).toString('base64'),
    },
    body: JSON.stringify(payload),
  });
  const json = await res.json();
  return { status: res.status, sid: json.sid, friendlyName: json.friendly_name, error: Array.isArray(json.message) ? json.message.map(m => m.message).join('; ') : json.message };
}

(async () => {
  if (!SID || !TOKEN) { console.log('No Twilio creds'); return; }
  for (const t of templates) {
    const r = await createTemplate(t);
    if (r.sid) console.log(`OK   ${t.name} -> ${r.sid}`);
    else console.log(`FAIL ${t.name} (HTTP ${r.status}): ${r.error}`);
  }
})().catch((e) => console.log('ERR', e.message));