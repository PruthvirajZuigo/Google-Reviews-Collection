const axios = require("axios");
const Sentiment = require("sentiment");
const logger = require("./logger");
const { canUseAI, recordUse } = require("./aiBudget");
const { SENTIMENTS, SENTIMENT_CACHE_TTL_MS } = require("../config/constants");

const cache = new Map();
const localAnalyzer = new Sentiment();

/**
 * How much AI this client gets, from Admin → Compliance → AI mode:
 *  - "full":            sentiment + replies + drafts all use AI
 *  - "rules+sentiment": AI only classifies sentiment; replies/drafts use local rules
 *  - "rules-only":      everything local — no AI calls at all
 */
function clientAiLevel(client) {
  return client?.compliance?.aiMode || "full";
}

/** Admin → Features → Business FAQ: when off, the AI is not fed business facts. */
function businessFaqEnabled(client) {
  return client?.features?.businessFaq !== false;
}

/**
 * Build the business-info block for an AI prompt from a client's config.
 * Falls back to the legacy env-based FAQ for pre-multi-tenant calls.
 * Empty when the Business FAQ feature is disabled for the client.
 */
function buildBusinessFaq(client) {
  if (!businessFaqEnabled(client)) return "";
  const profile = client?.profile || {};
  const hours = profile.businessHours || process.env.DEMO_BUSINESS_HOURS || "";
  const offer = profile.offer || process.env.DEMO_BUSINESS_OFFER || "";
  const manager = profile.managerWhatsapp || process.env.DEMO_MANAGER_WHATSAPP || "";
  const parts = [];
  if (hours) parts.push(`Business hours: ${hours}.`);
  if (offer) parts.push(`Current offer: ${offer}.`);
  if (manager && !manager.includes("XXXXXXXXXX")) parts.push(`Contact for anything else: ${manager}.`);
  if (parts.length === 0) parts.push("Business hours: 9am-9pm, all days.");
  return parts.join("\n");
}

async function callGroq(messages, client) {
  // Per-client LLM settings (Admin → AI / LLM) drive the model + parameters.
  const model = client?.llm?.model || process.env.GROQ_MODEL || "groq/compound-mini";
  const temperature = client?.llm?.temperature ?? 0.7;
  const maxTokens = client?.llm?.maxTokens ?? 300;
  const { data } = await axios.post(
    "https://api.groq.com/openai/v1/chat/completions",
    {
      model,
      messages: Array.isArray(messages) ? messages : [{ role: "user", content: messages }],
      temperature,
      max_tokens: maxTokens,
    },
    { headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}` }, timeout: 10000 }
  );
  return (data.choices?.[0]?.message?.content || "").trim();
}

function buildHistoryText(history) {
  if (!history || history.length < 2) return "";
  return history.map((h) => `${h.role === "customer" ? "Customer" : "You"}: ${h.text}`).join("\n");
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

async function analyzeSentiment(message, history, client) {
  const cacheKey = `sentiment:${message}`;
  const cached = cache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.result;

  if (!process.env.GROQ_API_KEY || !canUseAI(client) || clientAiLevel(client) === "rules-only") return localSentimentFallback(message);

  try {
    const past = history ? buildHistoryText(history) : "";
    const contextBlock = past ? `\nRecent conversation:\n${past}\n` : "";
    const text = await callGroq([
      {
        role: "system",
        content: `You classify customer sentiment. Business info:${buildBusinessFaq(client)}\nReply with exactly one word: happy, neutral, or sad.`
      },
      {
        role: "user",
        content: `A customer replied to "how was your experience?" with: "${message}".${contextBlock}\nClassify the overall sentiment. Reply with only the word.`
      }
    ], client);
    recordUse(client);
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

async function extractFreeTextFeedback(message, sentiment, history, client) {
  const categories = sentiment === "happy"
    ? ["Staff/Service", "Food/Product", "Ambience/Location", "Everything"]
    : ["Staff behavior", "Food/Product quality", "Waiting time", "Something else"];

  if (process.env.GROQ_API_KEY && canUseAI(client) && clientAiLevel(client) === "full") {
    try {
      const past = history ? buildHistoryText(history) : "";
      const contextBlock = past ? `\nContext: customer said "${message}". Prior chat:\n${past}\n` : "";
      const text = await callGroq([
        {
          role: "system",
          content: `You categorize customer feedback into a category. Categories: ${categories.join(", ")}. Reply with ONLY the category name.`
        },
        {
          role: "user",
          content: `Customer feedback: "${message}".${contextBlock}\nWhich category fits? Reply with only the category name.`
        }
      ], client);
      recordUse(client);
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

async function generateDraft(feedback, sentiment, isDetailed, client) {
  if (process.env.GROQ_API_KEY && canUseAI(client) && clientAiLevel(client) === "full") {
    try {
      const detailInstruction = isDetailed
        ? "Write a detailed 3-4 sentence Google review in first person. Be specific and elaborate using the customer's own words. Do not add anything they didn't mention. Reply with only the review text."
        : "Write a 1-2 sentence Google review in first person using the customer's own words. Do not add anything they didn't mention. Reply with only the review text.";
      const text = await callGroq([
        {
          role: "system",
          content: detailInstruction
        },
        {
          role: "user",
          content: `A customer said: "${feedback}". Their overall tone is ${sentiment}.`
        }
      ], client);
      recordUse(client);
      return text;
    } catch (err) {
      logger.error("Groq generateDraft failed:", err.message);
    }
  }
  return localDraft(feedback, sentiment, isDetailed, client);
}

function localDraft(feedback, sentiment, isDetailed, client) {
  const lower = feedback.toLowerCase();
  const business = client?.name || process.env.DEMO_BUSINESS_NAME || "Sharma Cafe Pune";

  const happyTemplates = {
    "staff|service|waiter|server|behaviour|behavior|help|friendly": isDetailed
      ? `I had a wonderful experience at ${business}. The staff was incredibly friendly and attentive — they made sure everything was perfect from start to finish. Truly impressed with the service quality. Highly recommended!`
      : `I had a great experience at ${business}. The staff was wonderful and the service was excellent.`,
    "food|product|dish|meal|taste|menu|item|quality|delicious|yummy|tasty": isDetailed
      ? `The food at ${business} was absolutely delicious. Every dish was well-prepared with authentic flavors and fresh ingredients. The portion sizes were generous too. Will definitely be coming back for more!`
      : `I really enjoyed the food at ${business}. The dishes were tasty and well-prepared.`,
    "ambience|location|atmosphere|vibe|place|decor|environment|clean|beautiful": isDetailed
      ? `${business} has a wonderful ambience — great decor, clean environment, and a welcoming atmosphere. Perfect place to relax and enjoy a meal. The location is also very convenient. Loved it!`
      : `The ambience at ${business} was lovely — clean, well-decorated, and comfortable.`,
    "everything": isDetailed
      ? `I had an amazing experience at ${business}. Everything was perfect — the food was delicious, the staff was friendly, and the atmosphere was great. One of the best places I've visited. Highly recommend!`
      : `Everything was great at ${business}. Had a wonderful experience overall!`
  };

  const sadTemplates = {
    "staff|service|waiter|server|rude|behaviour|behavior|unhelpful": isDetailed
      ? `I recently visited ${business}. Unfortunately, the service was below expectations — the staff seemed uninterested and the response time was quite slow. Hope they improve on this aspect.`
      : `I recently visited ${business}. The service was not up to the mark.`,
    "food|product|dish|meal|taste|quality|cold|bad": isDetailed
      ? `I recently visited ${business}. The food quality was disappointing — the dishes lacked flavor and the portion sizes were smaller than expected. There is definitely room for improvement in the kitchen.`
      : `I recently visited ${business}. The food quality was not satisfactory.`,
    "wait|time|slow|delay|late|queue": isDetailed
      ? `I recently visited ${business}. The waiting time was quite long — had to wait much longer than expected for my order. The staff did apologize but the delay was frustrating. Hope they address this issue.`
      : `I recently visited ${business}. The waiting time was too long.`,
    "something else|other|general|not good|bad": isDetailed
      ? `I recently visited ${business}. Unfortunately, my overall experience did not meet expectations. There are several areas that need improvement. I hope the team works on addressing these concerns.`
      : `I recently visited ${business}. The experience was not what I expected.`
  };

  const neutralTemplates = [
    `${business} was okay. Decent food and service — nothing exceptional but no major complaints either.`,
    `I had a mixed experience at ${business}. Some things were good, some could be better.`,
    `Visited ${business} recently. It was an average experience overall.`,
  ];

  if (sentiment === "happy" || sentiment === SENTIMENTS.HAPPY) {
    for (const [pattern, text] of Object.entries(happyTemplates)) {
      if (new RegExp(pattern).test(lower)) return text;
    }
    return isDetailed
      ? `I had a great time at ${business}. The experience was wonderful and I would recommend it to others looking for a good place to visit.`
      : `I had a great experience at ${business}!`;
  }
  if (sentiment === "sad" || sentiment === SENTIMENTS.SAD) {
    for (const [pattern, text] of Object.entries(sadTemplates)) {
      if (new RegExp(pattern).test(lower)) return text;
    }
    return isDetailed
      ? `I recently visited ${business} and my experience was not great. There are several areas that need improvement.`
      : `I recently visited ${business}.`;
  }
  return neutralTemplates[Math.floor(Math.random() * neutralTemplates.length)];
}

async function generateClosing(message, sentiment, conversationState, history, client) {
  if (!process.env.GROQ_API_KEY || !canUseAI(client) || clientAiLevel(client) !== "full") return null;

  const past = history ? buildHistoryText(history) : "";
  const historyBlock = past ? `\nConversation history:\n${past}\n` : "";
  try {
    const text = await callGroq([
      {
        role: "system",
        content: `Business info:${buildBusinessFaq(client)}\nYou are a WhatsApp assistant closing a conversation naturally. Generate ONE short, warm sentence (under 15 words). Don't mention reviews or links — the customer has already completed the process. Just a natural conversation ender.`
      },
      {
        role: "user",
        content: `The customer's last message was: "${message}". Their overall sentiment was ${sentiment}. Current state: ${conversationState}.${historyBlock}Generate a natural closing line.`
      }
    ], client);
    recordUse(client);
    return text;
  } catch (err) {
    return null;
  }
}

async function understandOffMenuInput(message, stage, sentiment, history, client) {
  if (!process.env.GROQ_API_KEY || !canUseAI(client) || clientAiLevel(client) !== "full") return null;
  const past = history ? buildHistoryText(history) : "";
  const historyBlock = past ? `\nConversation history:\n${past}\n` : "";
  const isCompleted = stage === "COMPLETED";
  const systemPrompt = isCompleted
    ? `Business info:${buildBusinessFaq(client)}\nA customer is sending a follow-up message after completing the review process. Read their message in context of the full conversation and respond naturally:`
    : `Business info:${buildBusinessFaq(client)}\nA customer sent an unexpected reply (not a valid number option). Read their message and decide: can you understand what they mean and respond naturally? If yes, generate a helpful response in under 20 words. If truly gibberish/unrelated, reply with exactly "UNRECOGNIZED".`;
  try {
    const text = await callGroq([
      {
        role: "system",
        content: systemPrompt
      },
      {
        role: "user",
        content: `Current stage: ${stage}. Customer's overall sentiment: ${sentiment}. Their message: "${message}".${historyBlock}`
      }
    ], client);
    recordUse(client);
    if (text === "UNRECOGNIZED") return null;
    return text;
  } catch (err) {
    return null;
  }
}

module.exports = { analyzeSentiment, extractFreeTextFeedback, generateDraft, generateClosing, understandOffMenuInput };
