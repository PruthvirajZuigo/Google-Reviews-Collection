/**
 * ⚠️ COMPLIANCE NOTE — read before reusing this outside a demo:
 * This bot's conversation flow (see src/services/sentiment.js and
 * src/routes/webhook.js) sends the Google review link ONLY to customers
 * detected as "happy", and routes "sad" customers to a private feedback
 * form instead — with no path to the public review link for them.
 *
 * This is "review gating," which Google's current review policy
 * explicitly prohibits. It was built this way on an explicit, informed
 * decision to match the original spec exactly, for a DEMO with mock data
 * only. Do NOT connect this to a real client's real WhatsApp number or
 * real Google Business Profile without first removing the gating (i.e.
 * making the Google link reachable regardless of sentiment) — doing so
 * risks review removal or profile restriction for that business.
 */

const STATES = {
  INIT: "INIT",
  AWAITING_RATING: "AWAITING_RATING",
  AWAITING_REVIEW: "AWAITING_REVIEW",
  AWAITING_FEEDBACK: "AWAITING_FEEDBACK",
  AWAITING_REVIEW_CHOICE: "AWAITING_REVIEW_CHOICE",
  AWAITING_FEEDBACK_CHOICE: "AWAITING_FEEDBACK_CHOICE",
  AWAITING_ESCALATION: "AWAITING_ESCALATION",
  COMPLETED: "COMPLETED",
};

const SENTIMENTS = { HAPPY: "happy", NEUTRAL: "neutral", SAD: "sad" };

const STATE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const SENTIMENT_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

const DEMO_BUSINESS = {
  name: process.env.DEMO_BUSINESS_NAME || "Sharma Cafe Pune",
  googleReviewUrl: process.env.DEMO_GOOGLE_REVIEW_URL || "https://g.page/sharma-cafe-pune/review",
  feedbackFormUrl: process.env.DEMO_FEEDBACK_FORM_URL || "https://forms.gle/demo-feedback-form",
  managerWhatsapp: process.env.DEMO_MANAGER_WHATSAPP || "+91XXXXXXXXXX",
};

const BUSINESS_FAQ = `
Business hours: 9am-9pm, all days.
Current offer: 10% off on weekday lunches.
Contact for anything else: +91XXXXXXXXXX.
`;
module.exports = { ...module.exports, BUSINESS_FAQ };

module.exports = { STATES, SENTIMENTS, STATE_TTL_MS, SENTIMENT_CACHE_TTL_MS, DEMO_BUSINESS, BUSINESS_FAQ };
