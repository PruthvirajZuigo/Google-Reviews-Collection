const axios = require("axios");
const Sentiment = require("sentiment");
const logger = require("./logger");
const { canUseAI, recordUse } = require("./aiBudget");
const { SENTIMENTS, SENTIMENT_CACHE_TTL_MS } = require("../config/constants");

const cache = new Map();
const localAnalyzer = new Sentiment();

async function callGroq(prompt) {
  const { data } = await axios.post(
    "https://api.groq.com/openai/v1/chat/completions",
    {
      model: "llama-3.3-70b-versatile",
      messages: [{ role: "user", content: prompt }],
    },
    { headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}` }, timeout: 10000 }
  );
  return (data.choices?.[0]?.message?.content || "").trim();
}

function localSentimentFallback(message) {
  const normalized = (message || "")
    .replace(/\bgreat(e|e?st)?\b/gi, "great")
    .replace(/\bgr[89]\b/gi, "great")
    .replace(/\bexcellen[td]\b/gi, "excellent")
    .replace(/\baweso+me?\b/gi, "awesome")
    .replace(/\bterrib?l?y?\b/gi, "terrible")
    .replace(/\bhorrib?l?y?\b/gi, "horrible")
    .replace(/\bdisappoin[td]\b/gi, "disappointed");
  const result = localAnalyzer.analyze(normalized);
  const sentiment = result.score > 0 ? SENTIMENTS.HAPPY : result.score < 0 ? SENTIMENTS.SAD : SENTIMENTS.NEUTRAL;
  return { sentiment, confidence: 0.5, intent: "local_fallback" };
}

/**
 * Classifies sentiment from ANY length input — a single word ("great")
 * or a long explanation both work, since this is a real model call, not
 * keyword matching.
 */
async function analyzeSentiment(message) {
  const cacheKey = `sentiment:${message}`;
  const cached = cache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.result;

  if (!process.env.GROQ_API_KEY || !canUseAI()) return localSentimentFallback(message);

  try {
    const text = await callGroq(
      `A customer replied to "how was your experience?" with: "${message}"\n` +
      `This could be one word or a long explanation — read the whole thing. ` +
      `Classify the overall sentiment as exactly one word: happy, neutral, or sad. Reply with only that word.`
    );
    recordUse();
    const lower = text.toLowerCase();
    const sentiment = lower.includes("happy") ? SENTIMENTS.HAPPY : lower.includes("sad") ? SENTIMENTS.SAD : SENTIMENTS.NEUTRAL;
    const result = { sentiment, confidence: 0.8, intent: "groq" };
    cache.set(cacheKey, { result, expiresAt: Date.now() + SENTIMENT_CACHE_TTL_MS });
    return result;
  } catch (err) {
    logger.error("Groq sentiment failed, using local fallback:", err.message);
    return localSentimentFallback(message);
  }
}

/**
 * Drives one turn of the actual conversation. `stage` controls what this
 * turn needs to do:
 *   - "ask_good_followup": customer signaled a good experience — ask
 *     what they liked, naturally. No link yet.
 *   - "ask_bad_followup": customer signaled a bad experience — ask them
 *     to describe the problem right here in chat. No link, no external form.
 *   - "close_good": customer just described what they liked — thank them
 *     naturally referencing what they said. The Google link is appended
 *     by webhook.js after this, not written by the AI, so the URL is
 *     never garbled or wrong.
 *   - "close_bad": customer just described the problem — acknowledge it
 *     empathetically, referencing specifics. No link.
 */
async function craftReply(message, stage, context = {}) {
  if (!process.env.GROQ_API_KEY || !canUseAI()) return null; // caller falls back to hinglishTemplates.js

  const { businessName = "our business", item } = context;
  const itemLine = item ? ` They came in for: ${item}.` : "";

  const stagePrompts = {
    ask_good_followup: `You are a WhatsApp assistant for "${businessName}".${itemLine} A customer just said their experience was good: "${message}". ` +
      `Reply warmly in ONE short sentence (under 20 words, plain English), then ask what they liked most. Reply with only the message text.`,
    ask_bad_followup: `You are a WhatsApp assistant for "${businessName}".${itemLine} A customer just said their experience was not good: "${message}". ` +
      `Reply with empathy in ONE short sentence (under 20 words, plain English), then ask them to describe what went wrong, right here in chat. Reply with only the message text.`,
    close_good: `You are a WhatsApp assistant for "${businessName}". The customer just described what they liked: "${message}". ` +
      `Write ONE short, warm thank-you (under 20 words, plain English) that references something specific they mentioned. ` +
      `Do NOT include any link or ask for a review yourself — that will be added separately. Reply with only the message text.`,
    close_bad: `You are a WhatsApp assistant for "${businessName}". The customer just described a problem: "${message}". ` +
      `Write ONE short, empathetic acknowledgment (under 20 words, plain English) referencing what they said, and reassure them the team will look into it. ` +
      `No links, no discounts. Reply with only the message text.`,
    ask_improve_followup: `You are a WhatsApp assistant for "${businessName}".${itemLine} A customer's experience was just okay/neutral: "${message}". ` +
      `Reply in ONE short sentence (under 20 words, plain English) acknowledging that, then ask what we could do to make it better. Reply with only the message text.`,
    close_neutral: `You are a WhatsApp assistant for "${businessName}". The customer just shared what could be improved: "${message}". ` +
      `Write ONE short, appreciative acknowledgment (under 20 words, plain English) referencing what they said, no links, no discounts. Reply with only the message text.`,
  };

  const prompt = stagePrompts[stage];
  if (!prompt) return null;

  try {
    const reply = await callGroq(prompt);
    recordUse();
    return reply;
  } catch (err) {
    logger.error(`Groq reply generation failed (stage=${stage}):`, err.message);
    return null;
  }
}

async function extractFreeTextFeedback(message, sentiment) {
  const categories = sentiment === "happy"
    ? ["Staff/Service", "Food/Product", "Ambience/Location", "Everything"]
    : ["Staff behavior", "Food/Product quality", "Waiting time", "Something else"];

  if (process.env.GROQ_API_KEY && canUseAI()) {
    try {
      const text = await callGroq(
        `A customer gave this feedback: "${message}". Their overall tone is ${sentiment}. ` +
        `Which single category best matches their feedback? Reply with ONLY the category name: ${categories.join(", ")}.`
      );
      recordUse();
      const match = categories.find((c) => text.toLowerCase().includes(c.toLowerCase()));
      if (match) return match;
    } catch (err) {
      logger.error("Groq extractFreeTextFeedback failed:", err.message);
    }
  }

  const lower = message.toLowerCase();
  const keywords = sentiment === "happy"
    ? { "staff|service|waiter|server|behaviour|behavior|help|friendly": "Staff/Service",
        "food|product|dish|meal|taste|menu|item|quality": "Food/Product",
        "ambience|location|atmosphere|vibe|place|decor|environment|clean": "Ambience/Location" }
    : { "staff|service|waiter|server|rude|behaviour|behavior|unhelpful": "Staff behavior",
        "food|product|dish|meal|taste|quality|cold|bad": "Food/Product quality",
        "wait|time|slow|delay|late|queue": "Waiting time" };
  for (const [pattern, label] of Object.entries(keywords)) {
    if (new RegExp(pattern).test(lower)) return label;
  }
  return null;
}

module.exports = { analyzeSentiment, craftReply, extractFreeTextFeedback };
