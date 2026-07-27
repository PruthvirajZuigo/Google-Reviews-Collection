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

module.exports = {
  welcomeMessage: (name, item) => pick(WELCOME)(name, item),
  goodFollowup: () => pick(GOOD_FOLLOWUP)(),
  badFollowup: () => pick(BAD_FOLLOWUP)(),
  goodClosing: () => pick(GOOD_CLOSING)(),
  badClosing: () => pick(BAD_CLOSING)(),
  followupReminder: (name) => pick(FOLLOWUP_REMINDER)(name),
};
