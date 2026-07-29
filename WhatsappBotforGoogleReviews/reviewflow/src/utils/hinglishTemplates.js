/**
 * These are ONLY the fallback lines used if the AI call fails or the
 * daily AI budget is exhausted (see aiBudget.js) — the real, natural
 * conversation is generated live by huggingface.js. Kept in plain
 * English per the current design.
 */
const { DEMO_BUSINESS } = require("../config/constants");

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

const WELCOME = [
  (name, item) => `Hi! Thank you for visiting ${name}${item ? ` for ${item}` : ""} 😊 How was your experience?`,
  (name, item) => `Hello! Payment received${item ? ` for ${item}` : ""} at ${name} ✅ How did it go?`,
  (name, item) => `Thanks for choosing ${name}${item ? ` — how was the ${item}?` : "!"}`,
  (name, item) => `Hey! How was your visit to ${name}${item ? ` for ${item}` : ""}?`,
  (name, item) => `Thank you for visiting ${name}${item ? ` (${item})` : ""}! We'd love to know how it went.`,
];

const GOOD_FOLLOWUP = [
  () => "That's wonderful to hear! What did you enjoy the most?",
  () => "Glad you had a good experience! What stood out to you?",
  () => "That's great! Anything in particular you liked?",
];

const BAD_FOLLOWUP = [
  () => "I'm sorry to hear that. Could you tell me what went wrong so we can fix it?",
  () => "Sorry your experience wasn't great. What happened? We'd like to make it right.",
  () => "That's not what we want for you. Please share what went wrong.",
];

const GOOD_CLOSING = [
  () => "Thank you so much for sharing that! If you have a moment, we'd really appreciate a Google review:",
  () => "That means a lot to us! Would you mind leaving a quick Google review?",
  () => "Really glad to hear it! If you have a minute, a Google review would help us a lot:",
];

const BAD_CLOSING = [
  () => "Thank you for letting us know — we've noted this and our manager will look into it.",
  () => "We appreciate your honesty. This has been shared with our manager for follow-up.",
  () => "Thanks for telling us. We're taking this seriously and will work on it.",
];

const FOLLOWUP_REMINDER = [
  (name) => `Hi again! Just checking in — how was your visit to ${name}?`,
  (name) => `Hey! No pressure, just curious how things went at ${name}.`,
  (name) => `Following up — would love to hear how your experience at ${name} was.`,
];

const REVIEW_OPTIONS_TEXT = `That's great to hear! What did you enjoy most? Reply with a number:
1️⃣ Staff / Service
2️⃣ Food / Product
3️⃣ Ambience / Location
4️⃣ Everything was great

Or just tell me in your own words!`;

const FEEDBACK_OPTIONS_SAD = `Sorry to hear that. What went wrong? Reply with a number:
1️⃣ Staff behavior
2️⃣ Food / Product quality
3️⃣ Waiting time
4️⃣ Something else

Or just tell me in your own words!`;

const FEEDBACK_OPTIONS_NEUTRAL = `Thanks for letting us know. What could be better? Reply with a number:
1️⃣ Staff / Service
2️⃣ Food / Product
3️⃣ Ambience
4️⃣ Something else

Or just tell me in your own words!`;

const ESCALATION_OPTIONS = `Would you like us to follow up on this? Reply with a number:
1️⃣ Yes, please have someone contact me
2️⃣ No, just noting my feedback`;

const DRAFT_OPTION = `Would you like me to write a quick Google review draft based on what you shared?
1️⃣ Yes, write a draft for me
2️⃣ No, just give me the link`;

const FOLLOWUP_REENGAGEMENT = `Hi again! 👋 It's been a while — we'd love to hear about your recent experience.`;

const REVIEW_OPTION_LABELS = { 1: "Staff/Service", 2: "Food/Product", 3: "Ambience/Location", 4: "Everything" };
const FEEDBACK_OPTION_LABELS = { 1: "Staff behavior", 2: "Food/Product quality", 3: "Waiting time", 4: "Something else" };
const ESCALATION_OPTION_LABELS = { 1: "Contact me", 2: "Just noting" };
const DRAFT_OPTION_LABELS = { 1: "Yes", 2: "No" };

const CLOSING_VARIANTS = [
  "Thanks for your time! Have a great day ahead.",
  "Feel free to reach out anytime. Take care!",
  "We appreciate your feedback. Have a wonderful day!",
  "Thanks again! Come visit us again soon.",
  "Glad we could help! Hope to see you again.",
  "Thanks for chatting with us. Have a good one!",
  "You're welcome! Don't hesitate to reach out if you need anything.",
  "Happy to help! Enjoy the rest of your day.",
  "Anytime! We're here if you have more questions.",
  "Take care and see you at Sharma Cafe next time!",
  "Thanks for your time and feedback — it means a lot!",
  "Have a wonderful day ahead! Looking forward to serving you again.",
];

let _lastClosingIndex = -1;

function closingVariants() {
  let idx;
  do {
    idx = Math.floor(Math.random() * CLOSING_VARIANTS.length);
  } while (idx === _lastClosingIndex && CLOSING_VARIANTS.length > 1);
  _lastClosingIndex = idx;
  return CLOSING_VARIANTS[idx];
}

const REWRITE_KEYWORDS = [
  /\b(rewrite|rephrase|edit|change|improve|update|expand|elaborate|better|polish|fix)\b/i,
  /\b(make\s+it\s+(more|better|longer|detailed))\b/i,
  /\b(not\s+(good|great|detailed|enough))\b/i,
  /\b(can\s+you\s+(rewrite|improve|make|change|write))\b/i,
  /\b(add|include|incorporate)\s+.{1,50}\b(detail\w*|info|description|about|more)\b/i,
  /\b(more\s+details?|more\s+info|more\s+content|fuller|longer)\b/i,
];

function isDraftRewriteRequest(message) {
  return REWRITE_KEYWORDS.some((re) => re.test(message));
}

module.exports = {
  welcomeMessage: (name, item) => pick(WELCOME)(name, item),
  goodFollowup: () => pick(GOOD_FOLLOWUP)(),
  badFollowup: () => pick(BAD_FOLLOWUP)(),
  goodClosing: () => pick(GOOD_CLOSING)(),
  badClosing: () => pick(BAD_CLOSING)(),
  followupReminder: (name) => pick(FOLLOWUP_REMINDER)(name),
  reviewOptionsText: () => REVIEW_OPTIONS_TEXT,
  feedbackOptionsSad: () => FEEDBACK_OPTIONS_SAD,
  feedbackOptionsNeutral: () => FEEDBACK_OPTIONS_NEUTRAL,
  escalationOptions: () => ESCALATION_OPTIONS,
  draftOption: () => DRAFT_OPTION,
  followupReengagement: () => FOLLOWUP_REENGAGEMENT,
  REVIEW_OPTION_LABELS,
  FEEDBACK_OPTION_LABELS,
  ESCALATION_OPTION_LABELS,
  DRAFT_OPTION_LABELS,
  isDraftRewriteRequest,
  closingVariants,
};
