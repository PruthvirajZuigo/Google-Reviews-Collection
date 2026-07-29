const axios = require("axios");
const Sentiment = require("sentiment");
const logger = require("./logger");
const { canUseAI, recordUse } = require("./aiBudget");
const { SENTIMENTS, SENTIMENT_CACHE_TTL_MS, BUSINESS_FAQ } = require("../config/constants");

const cache = new Map();
const localAnalyzer = new Sentiment();

async function callGroq(messages) {
  const { data } = await axios.post(
    "https://api.groq.com/openai/v1/chat/completions",
    {
      model: "llama-3.3-70b-versatile",
      messages: Array.isArray(messages) ? messages : [{ role: "user", content: messages }],
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

async function analyzeSentiment(message, history) {
  const cacheKey = `sentiment:${message}`;
  const cached = cache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.result;

  if (!process.env.GROQ_API_KEY || !canUseAI()) return localSentimentFallback(message);

  try {
    const past = history ? buildHistoryText(history) : "";
    const contextBlock = past ? `\nRecent conversation:\n${past}\n` : "";
    const text = await callGroq([
      {
        role: "system",
        content: `You classify customer sentiment. Business info:${BUSINESS_FAQ}\nReply with exactly one word: happy, neutral, or sad.`
      },
      {
        role: "user",
        content: `A customer replied to "how was your experience?" with: "${message}".${contextBlock}\nClassify the overall sentiment. Reply with only the word.`
      }
    ]);
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

async function craftReply(message, stage, context = {}) {
  if (!process.env.GROQ_API_KEY || !canUseAI()) return null;

  const { businessName = "our business", item, history } = context;
  const itemLine = item ? ` They came in for: ${item}.` : "";
  const past = history ? buildHistoryText(history) : "";
  const historyBlock = past ? `\nFull conversation so far:\n${past}\n` : "";

  const stagePrompts = {
    ask_good_followup: `You are a WhatsApp assistant for "${businessName}".${itemLine}\nBusiness info:${BUSINESS_FAQ}${historyBlock}A customer just said their experience was good: "${message}". Reply warmly in ONE short sentence (under 20 words, plain English), then ask what they liked most. Reply with only the message text.`,
    ask_bad_followup: `You are a WhatsApp assistant for "${businessName}".${itemLine}\nBusiness info:${BUSINESS_FAQ}${historyBlock}A customer just said their experience was not good: "${message}". Reply with empathy in ONE short sentence (under 20 words, plain English), then ask them to describe what went wrong, right here in chat. Reply with only the message text.`,
    close_good: `You are a WhatsApp assistant for "${businessName}".\nBusiness info:${BUSINESS_FAQ}${historyBlock}The customer just described what they liked: "${message}". Write ONE short, warm thank-you (under 20 words, plain English) that references something specific they mentioned. Do NOT include any link or ask for a review yourself — that will be added separately. Reply with only the message text.`,
    close_bad: `You are a WhatsApp assistant for "${businessName}".\nBusiness info:${BUSINESS_FAQ}${historyBlock}The customer just described a problem: "${message}". Write ONE short, empathetic acknowledgment (under 20 words, plain English) referencing what they said, and reassure them the team will look into it. No links, no discounts. Reply with only the message text.`,
    ask_improve_followup: `You are a WhatsApp assistant for "${businessName}".${itemLine}\nBusiness info:${BUSINESS_FAQ}${historyBlock}A customer's experience was just okay/neutral: "${message}". Reply in ONE short sentence (under 20 words, plain English) acknowledging that, then ask what we could do to make it better. Reply with only the message text.`,
    close_neutral: `You are a WhatsApp assistant for "${businessName}".\nBusiness info:${BUSINESS_FAQ}${historyBlock}The customer just shared what could be improved: "${message}". Write ONE short, appreciative acknowledgment (under 20 words, plain English) referencing what they said, no links, no discounts. Reply with only the message text.`,
  };

  const prompt = stagePrompts[stage];
  if (!prompt) return null;

  try {
    const reply = await callGroq([{ role: "user", content: prompt }]);
    recordUse();
    return reply;
  } catch (err) {
    logger.error(`Groq reply generation failed (stage=${stage}):`, err.message);
    return null;
  }
}

async function extractFreeTextFeedback(message, sentiment, history) {
  const categories = sentiment === "happy"
    ? ["Staff/Service", "Food/Product", "Ambience/Location", "Everything"]
    : ["Staff behavior", "Food/Product quality", "Waiting time", "Something else"];

  if (process.env.GROQ_API_KEY && canUseAI()) {
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
      ]);
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

async function generateDraft(feedback, sentiment, isDetailed) {
  if (process.env.GROQ_API_KEY && canUseAI()) {
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
      ]);
      recordUse();
      return text;
    } catch (err) {
      logger.error("Groq generateDraft failed:", err.message);
    }
  }
  return localDraft(feedback, sentiment, isDetailed);
}

function localDraft(feedback, sentiment, isDetailed) {
  const lower = feedback.toLowerCase();
  const business = process.env.DEMO_BUSINESS_NAME || "Sharma Cafe Pune";

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

async function generateClosing(message, sentiment, conversationState, history) {
  if (!process.env.GROQ_API_KEY || !canUseAI()) return null;

  const past = history ? buildHistoryText(history) : "";
  const historyBlock = past ? `\nConversation history:\n${past}\n` : "";
  try {
    const text = await callGroq([
      {
        role: "system",
        content: `Business info:${BUSINESS_FAQ}\nYou are a WhatsApp assistant closing a conversation naturally. Generate ONE short, warm sentence (under 15 words). Don't mention reviews or links — the customer has already completed the process. Just a natural conversation ender.`
      },
      {
        role: "user",
        content: `The customer's last message was: "${message}". Their overall sentiment was ${sentiment}. Current state: ${conversationState}.${historyBlock}Generate a natural closing line.`
      }
    ]);
    recordUse();
    return text;
  } catch (err) {
    return null;
  }
}

async function understandOffMenuInput(message, stage, sentiment, history) {
  if (!process.env.GROQ_API_KEY || !canUseAI()) return null;
  const past = history ? buildHistoryText(history) : "";
  const historyBlock = past ? `\nConversation history:\n${past}\n` : "";
  const isCompleted = stage === "COMPLETED";
  const systemPrompt = isCompleted
    ? `Business info:${BUSINESS_FAQ}\nA customer is sending a follow-up message after completing the review process. Read their message in context of the full conversation and respond naturally:`
    : `Business info:${BUSINESS_FAQ}\nA customer sent an unexpected reply (not a valid number option). Read their message and decide: can you understand what they mean and respond naturally? If yes, generate a helpful response in under 20 words. If truly gibberish/unrelated, reply with exactly "UNRECOGNIZED".`;
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
    ]);
    recordUse();
    if (text === "UNRECOGNIZED") return null;
    return text;
  } catch (err) {
    return null;
  }
}

module.exports = { analyzeSentiment, craftReply, extractFreeTextFeedback, generateDraft, generateClosing, understandOffMenuInput };
