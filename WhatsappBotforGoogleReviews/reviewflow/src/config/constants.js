/**
 * Conversation states for the state machine.
 * AWAITING_REVIEW and AWAITING_FEEDBACK are intentionally removed — 
 * the live flow uses the _CHOICE variants instead.
 */

const STATES = {
  INIT: "INIT",
  AWAITING_RATING: "AWAITING_RATING",
  AWAITING_REVIEW_CHOICE: "AWAITING_REVIEW_CHOICE",
  AWAITING_FEEDBACK_CHOICE: "AWAITING_FEEDBACK_CHOICE",
  AWAITING_ESCALATION: "AWAITING_ESCALATION",
  AWAITING_DRAFT_CHOICE: "AWAITING_DRAFT_CHOICE",
  AWAITING_REVIEW_CONFIRM: "AWAITING_REVIEW_CONFIRM",
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
${DEMO_BUSINESS.managerWhatsapp && !DEMO_BUSINESS.managerWhatsapp.includes("XXXXXXXXXX")
  ? `Contact for anything else: ${DEMO_BUSINESS.managerWhatsapp}.`
  : "Contact for anything else: ask the staff when you visit."}
`;
module.exports = { ...module.exports, BUSINESS_FAQ };

/**
 * Content SIDs for the Twilio "twilio/list-picker" interactive templates.
 * Set the env vars once the templates are created in the Twilio Console
 * (see docs/twilio-content-templates.md). Empty string = template not
 * configured yet → the bot gracefully falls back to plain-text menus.
 */
const CONTENT_TEMPLATES = {
  reviewOptions: process.env.TWILIO_CONTENT_SID_REVIEW_OPTIONS || "",
  feedbackSad: process.env.TWILIO_CONTENT_SID_FEEDBACK_SAD || "",
  feedbackNeutral: process.env.TWILIO_CONTENT_SID_FEEDBACK_NEUTRAL || "",
};

module.exports = { STATES, SENTIMENTS, STATE_TTL_MS, SENTIMENT_CACHE_TTL_MS, DEMO_BUSINESS, BUSINESS_FAQ, CONTENT_TEMPLATES };
