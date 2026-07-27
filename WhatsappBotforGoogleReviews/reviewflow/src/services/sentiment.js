const { analyzeSentiment } = require("./huggingface");
const { SENTIMENTS } = require("../config/constants");

/**
 * Business-logic wrapper around the raw Hugging Face client (huggingface.js).
 * Kept separate so webhook.js depends on "what sentiment is this message"
 * rather than "which AI provider are we using" — swapping providers later
 * only touches huggingface.js, not this file or its callers.
 */
async function classifyMessage(message, language = "auto") {
  const result = await analyzeSentiment(message, language);
  if (![SENTIMENTS.HAPPY, SENTIMENTS.NEUTRAL, SENTIMENTS.SAD].includes(result.sentiment)) {
    return { sentiment: SENTIMENTS.NEUTRAL, confidence: 0, intent: "invalid_fallback" };
  }
  return result;
}

module.exports = { classifyMessage };
