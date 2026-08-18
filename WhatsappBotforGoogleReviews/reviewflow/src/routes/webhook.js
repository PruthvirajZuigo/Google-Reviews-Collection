const express = require("express");
const router = express.Router();

const twilioService = require("../services/twilio");
const { analyzeSentiment, extractFreeTextFeedback, generateDraft, generateClosing, understandOffMenuInput } = require("../services/huggingface");
const storage = require("../services/storage");
const logger = require("../services/logger");
const templates = require("../utils/hinglishTemplates");
const { STATES, SENTIMENTS, STATE_TTL_MS, CONTENT_TEMPLATES } = require("../config/constants");
const { resolveClient, DEFAULT_CLIENT_ID } = require("../services/clientConfig");
const Conversation = require("../models/Conversation");

async function getConversation(phone) { return getState(phone); }
async function seedConversation(phone, data) { return setState(phone, data); }

async function getState(phone) {
  const entry = await Conversation.findOne({ phone }).lean();
  if (!entry) return null;
  if (entry.expiresAt && entry.expiresAt < Date.now()) { await Conversation.deleteOne({ phone }); return null; }
  return entry;
}

async function setState(phone, patch) {
  await Conversation.updateOne(
    { phone },
    { $set: { ...patch, updatedAt: new Date(), expiresAt: new Date(Date.now() + STATE_TTL_MS) } },
    { upsert: true }
  );
}

/**
 * Runs the conversation state machine for one incoming WhatsApp message.
 *
 * @param {string} from   The sender (e.g. `whatsapp:+91...` from Twilio, or any
 *                        phone string when testing).
 * @param {string} body   The message text.
 * @param {string} messageSid  Unique message id (used to ignore duplicate webhooks).
 * @param {object} [options]
 * @param {boolean} [options.isTest] When true, all conversation state, records and
 *                        history are stored under a `test:`-prefixed key so the
 *                        simulator never touches real customer data or the dashboard.
 * @returns {Promise<{text: string, interactive?: object, state?: string} | null>}
 */
async function handleMessage(from, body, messageSid, options = {}) {
  // Test conversations use a separate namespace so they never collide with real
  // customers and never appear in the dashboard stats/records.
  const key = options.isTest ? `test:${from}` : from;
  // Flag test-generated records so dashboard/aggregations can exclude them.
  const recordTag = options.isTest ? { test: true } : {};

  // Read the conversation state first: the client that seeded the message wins
  // ownership (e.g. manual trigger / batch), so replies resolve back to them.
  let convo = await getState(key) || { state: STATES.INIT, customerName: "Customer" };
  const lastSeen = convo?.lastMessageSid;
  if (messageSid && messageSid === lastSeen) {
    logger.info(`Duplicate webhook delivery ignored: ${messageSid}`);
    return null;
  }

  // Resolve the owning client from an explicit clientId, else the seeded
  // conversation's client, else the sender's Customer record, else the default.
  const activeClient = await resolveClient({
    clientId: options.clientId || (convo && convo.clientId),
    phone: options.isTest ? from : String(from).replace(/^whatsapp:/, ""),
  });
  const clientId = activeClient?.clientId || DEFAULT_CLIENT_ID;
  const history = await storage.getRecentHistory(key, 4, clientId);
  let replyText;
  // Set when this reply should be sent as an interactive list instead of plain text.
  let interactive;

  // Compliance: opt-out ("STOP") handling. Config-driven via client.compliance.
  // Honours existing Customer.optedOut too. Does not run for test conversations.
  if (!options.isTest && activeClient.compliance.handleStop) {
    const lower = body.trim().toLowerCase();
    const cleanPhone = String(from).replace(/^whatsapp:/, "");
    if (lower === "stop" || lower === "unsubscribe" || lower === "quit" || lower === "stop all" || lower === "end") {
      await storage.updateCustomer(cleanPhone, { optedOut: true, optedOutAt: new Date() }, clientId);
      await setState(key, { state: STATES.COMPLETED, optedOut: true, clientId, lastMessageSid: messageSid });
      replyText = "You've been unsubscribed. You won't receive any more messages from us. Reply HELP anytime to get a link to our reviews if you change your mind.";
      logger.info(`[STOP] ${from} unsubscribed (client ${clientId})`);
      return { text: replyText, interactive: undefined, state: STATES.COMPLETED };
    }
    const customerDoc = await storage.findCustomerByPhone(cleanPhone, clientId);
    if (customerDoc?.optedOut) {
      // Re-opt-in: HELP / START / UNSTOP re-enables the customer and resumes
      // the normal conversation so the STOP promise ("reply HELP to get a link")
      // is actually honoured.
      if (lower === "help" || lower === "start" || lower === "unstop") {
        await storage.updateCustomer(cleanPhone, { optedOut: false, optedOutAt: null }, clientId);
        await setState(key, { state: STATES.INIT, optedOut: false, clientId, lastMessageSid: messageSid });
        logger.info(`[RE-OPT-IN] ${from} re-subscribed (client ${clientId})`);
      } else {
        await setState(key, { state: STATES.COMPLETED, optedOut: true, clientId, lastMessageSid: messageSid });
        replyText = "You're unsubscribed from our messages. Reply HELP anytime to get our review link if you change your mind.";
        return { text: replyText, interactive: undefined, state: STATES.COMPLETED };
      }
    }
  }

  if (convo.state === STATES.INIT || convo.state === STATES.AWAITING_RATING) {
    const pastRecords = await storage.findByPhone(key, clientId);
    if (pastRecords.length > 0) {
      convo.customerName = pastRecords[0].customerName || convo.customerName;
    }
    const SEVEN_DAYS = 7 * 24 * 60 * 60 * 1000;
    const oldCompleted = pastRecords.find(
      (r) => r.state === STATES.COMPLETED && new Date(r.createdAt).getTime() < Date.now() - SEVEN_DAYS
    );
    const reengagement = oldCompleted ? `${templates.followupReengagement()}\n\n` : "";

    const { sentiment } = await analyzeSentiment(body, history, activeClient);

    let nextState, optionText;
    if (sentiment === SENTIMENTS.SAD) {
      nextState = STATES.AWAITING_FEEDBACK_CHOICE;
      optionText = templates.feedbackOptionsSad();
      interactive = { bodyText: optionText, contentSid: CONTENT_TEMPLATES.feedbackSad };
    } else if (sentiment === SENTIMENTS.NEUTRAL) {
      nextState = STATES.AWAITING_FEEDBACK_CHOICE;
      optionText = templates.feedbackOptionsNeutral();
      interactive = { bodyText: optionText, contentSid: CONTENT_TEMPLATES.feedbackNeutral };
    } else {
      nextState = STATES.AWAITING_REVIEW_CHOICE;
      optionText = templates.reviewOptionsText();
      interactive = { bodyText: optionText, contentSid: CONTENT_TEMPLATES.reviewOptions };
    }

      await setState(key, { state: nextState, sentiment, clientId, lastMessageSid: messageSid, originalFeedback: body });
      replyText = reengagement + optionText;
      // Returning customers get one combined plain-text message (prefix + menu);
      // a list-picker can only carry the menu body, so keep it plain here.
      if (reengagement) interactive = undefined;
      await storage.appendRecord({ clientId, phone: key, customerName: convo.customerName, sentiment, state: nextState, triggerSource: "webhook", ...recordTag });
  } else if (convo.state === STATES.AWAITING_REVIEW_CHOICE) {
    const choice = parseInt(body.trim());
    let label = templates.REVIEW_OPTION_LABELS[choice];
    if (!label) label = await extractFreeTextFeedback(body, "happy", history, activeClient);
    if (!label) {
      replyText = await tryAiUnderstand(body, convo.state, convo.sentiment, history, templates.reviewOptionsText(), activeClient);
    } else {
      await setState(key, { state: STATES.AWAITING_DRAFT_CHOICE, choice: label, clientId, lastMessageSid: messageSid });
      await storage.appendRecord({ clientId, phone: key, customerName: convo.customerName, sentiment: convo.sentiment, state: STATES.AWAITING_DRAFT_CHOICE, feedbackText: label, triggerSource: "webhook", ...recordTag });
      replyText = templates.draftOption();
    }
  } else if (convo.state === STATES.AWAITING_FEEDBACK_CHOICE) {
    const choice = parseInt(body.trim());
    let label = templates.FEEDBACK_OPTION_LABELS[choice];
    if (!label) label = await extractFreeTextFeedback(body, convo.sentiment === SENTIMENTS.SAD ? "sad" : "neutral", history, activeClient);
    if (!label) {
      replyText = await tryAiUnderstand(body, convo.state, convo.sentiment, history,
        convo.sentiment === SENTIMENTS.SAD ? templates.feedbackOptionsSad() : templates.feedbackOptionsNeutral(), activeClient);
    } else {
      if (convo.sentiment === SENTIMENTS.SAD) {
        await setState(key, { state: STATES.AWAITING_ESCALATION, choice: label, clientId, lastMessageSid: messageSid });
        await storage.appendRecord({ clientId, phone: key, customerName: convo.customerName, sentiment: convo.sentiment, state: STATES.AWAITING_ESCALATION, feedbackText: label, triggerSource: "webhook", ...recordTag });
        replyText = templates.escalationOptions();
      } else {
        await setState(key, { state: STATES.AWAITING_DRAFT_CHOICE, choice: label, clientId, lastMessageSid: messageSid });
        await storage.appendRecord({ clientId, phone: key, customerName: convo.customerName, sentiment: convo.sentiment, state: STATES.AWAITING_DRAFT_CHOICE, feedbackText: label, triggerSource: "webhook", ...recordTag });
        replyText = templates.draftOption();
      }
    }
  } else if (convo.state === STATES.AWAITING_ESCALATION) {
    const choice = parseInt(body.trim());
    const escalationLabel = templates.ESCALATION_OPTION_LABELS[choice];
    if (!escalationLabel) {
      replyText = await tryAiUnderstand(body, convo.state, convo.sentiment, history, templates.escalationOptions(), activeClient);
    } else {
      await setState(key, { state: STATES.AWAITING_DRAFT_CHOICE, clientId, lastMessageSid: messageSid });
      await storage.appendRecord({ clientId, phone: key, customerName: convo.customerName, sentiment: convo.sentiment, state: STATES.AWAITING_DRAFT_CHOICE, feedbackText: escalationLabel, triggerSource: "webhook", ...recordTag });
      if (escalationLabel === "Contact me" && !options.isTest && activeClient.profile.managerWhatsapp) {
        await twilioService.sendWhatsApp(activeClient.profile.managerWhatsapp, `⚠️ Customer requested follow-up from ${from}: "${convo.choice}"\nAction: Contact customer`);
      }
      replyText = templates.draftOption();
    }
  } else if (convo.state === STATES.AWAITING_DRAFT_CHOICE) {
    const choice = parseInt(body.trim());
    let draftChoice = templates.DRAFT_OPTION_LABELS[choice];
    if (!draftChoice) {
      const lower = body.trim().toLowerCase();
      const yes = /\b(yes|yeah|sure|okay|ok|yep|write|go\s*ahead|do\s*it|please|yar|haan|hmm|correct)\b/i.test(lower) && !/\b(no|nope|nah|na|skip|don't|dont|not\s*now|cancel|nahi)\b/i.test(lower);
      const no = /\b(no|nope|nah|na|skip|don't|dont|not\s*now|cancel|nahi)\b/i.test(lower) && !/\b(yes|yeah|sure|okay|ok|yep)\b/i.test(lower);
      if (yes) draftChoice = "Yes";
      else if (no) draftChoice = "No";
      else replyText = await tryAiUnderstand(body, convo.state, convo.sentiment, history, templates.draftOption(), activeClient);
    }
    if (draftChoice) {
      if (draftChoice === "Yes") {
        const draft = await generateDraft(convo.originalFeedback || convo.choice || body, convo.sentiment || "happy", false, activeClient);
        await setState(key, { state: STATES.AWAITING_REVIEW_CONFIRM, draft, clientId, lastMessageSid: messageSid });
        await storage.appendRecord({ clientId, phone: key, customerName: convo.customerName, sentiment: convo.sentiment, state: STATES.AWAITING_REVIEW_CONFIRM, feedbackText: convo.choice || body, reviewText: draft, triggerSource: "webhook", ...recordTag });
        replyText = `*Here's a draft you can copy:*\n\n${draft}\n\n_Tap and hold to copy, then paste it here:_\n${activeClient.profile.googleReviewUrl}`;
      } else {
        await setState(key, { state: STATES.AWAITING_REVIEW_CONFIRM, clientId, lastMessageSid: messageSid });
        await storage.appendRecord({ clientId, phone: key, customerName: convo.customerName, sentiment: convo.sentiment, state: STATES.AWAITING_REVIEW_CONFIRM, feedbackText: convo.choice || body, triggerSource: "webhook", ...recordTag });
        replyText = `No problem! Here's the link to leave a review:\n\n${activeClient.profile.googleReviewUrl}`;
      }
      if (!options.isTest) {
        await storage.markReviewLinkSent(from, clientId);
        scheduleReviewNudge(key, (activeClient.scheduler.confirmDelayMinutes ?? 30) * 60 * 1000);
      }
    }
  } else if (convo.state === STATES.AWAITING_REVIEW_CONFIRM) {
    const choice = parseInt(body.trim());
    const lower = body.trim().toLowerCase();
    const yes = choice === 1 || (/\b(yes|yes\b|posted|done|posted\s*it|done\s*it|rakha|kar\s*diya|haan|ha|hurray)\b/i.test(lower) && !/\b(no|not\s*yet|nope|nah|abhi\s*nahi|nahi)\b/i.test(lower));
    const no = choice === 2 || (/\b(no|not\s*yet|nope|nah|later|abhi\s*nahi|nahi)\b/i.test(lower) && !/\b(yes|posted|done|haan|ha)\b/i.test(lower));
    if (yes) {
      await setState(key, { state: STATES.COMPLETED, reviewConfirm: true, clientId, lastMessageSid: messageSid });
      await storage.appendRecord({ clientId, phone: key, customerName: convo.customerName, sentiment: convo.sentiment, state: STATES.COMPLETED, feedbackText: convo.choice || body, reviewText: convo.draft, reviewConfirm: true, triggerSource: "webhook", ...recordTag });
      if (!options.isTest) {
        await storage.markReviewProvided(from, clientId);
        if (convo.draft) await storage.setCustomerReviewText(from, clientId, convo.draft);
        clearReviewNudge(key);
      }
      replyText = templates.reviewConfirmThanks();
    } else if (no) {
      await setState(key, { state: STATES.COMPLETED, reviewConfirm: false, clientId, lastMessageSid: messageSid });
      await storage.appendRecord({ clientId, phone: key, customerName: convo.customerName, sentiment: convo.sentiment, state: STATES.COMPLETED, feedbackText: convo.choice || body, reviewText: convo.draft, reviewConfirm: false, triggerSource: "webhook", ...recordTag });
      replyText = templates.reviewConfirmNotYet(activeClient.profile.googleReviewUrl);
    } else {
      replyText = templates.reviewConfirmPrompt();
    }
  } else if (convo.state === STATES.COMPLETED) {
    if (templates.isDraftRewriteRequest(body) && convo.choice) {
      const draft = await generateDraft(convo.originalFeedback || convo.choice, convo.sentiment || "happy", true, activeClient);
      replyText = `Sure! Here's a more detailed version:\n\n${draft}\n\n${activeClient.profile.googleReviewUrl}`;
    } else if (templates.isDraftRewriteRequest(body)) {
      replyText = `Sorry, I don't have your previous feedback to expand on. Could you tell me about your experience?`;
    } else {
      const aiResponse = await understandOffMenuInput(body, convo.state, convo.sentiment, history, activeClient);
      if (aiResponse) {
        replyText = aiResponse;
      } else {
        const aiClosing = await generateClosing(body, convo.sentiment, convo.state, history, activeClient);
        replyText = aiClosing || templates.closingVariants();
      }
    }
  } else {
    replyText = templates.closingVariants();
  }

  logger.info(`[${from}] client=${clientId} state=${convo.state} -> sentiment=${convo.sentiment || "n/a"} -> reply="${replyText?.slice(0, 60)}..."`);
  const finalConvo = await getState(key);
  return { text: replyText, interactive, state: finalConvo?.state || convo.state };
}

async function tryAiUnderstand(body, stage, sentiment, history, templateFallback, client) {
  const ai = await understandOffMenuInput(body, stage, sentiment, history, client);
  return ai || templateFallback;
}

// Delayed "Did you post your review?" nudge. Keyed per conversation so a reply to
// the review-link message clears the pending nudge instead of piling up timers.
const reviewNudges = new Map();

function scheduleReviewNudge(key, delayMs) {
  clearReviewNudge(key);
  // Per-client confirm delay (minutes) wins; falls back to env then 30 min.
  const ms = Number(delayMs) || Number(process.env.REVIEW_CONFIRM_DELAY_MS) || 30 * 60 * 1000;
  const timer = setTimeout(async () => {
    reviewNudges.delete(key);
    const convo = await getState(key);
    if (!convo || convo.state !== STATES.AWAITING_REVIEW_CONFIRM) return;
    const prompt = templates.reviewConfirmPrompt();
    const realPhone = key.startsWith("test:") ? key.slice(5) : key.replace(/^whatsapp:/, "");
    try {
      await twilioService.sendWhatsApp(realPhone, prompt);
    } catch (err) {
      logger.error(`Review nudge failed for ${key}:`, err.message);
    }
  }, delayMs);
  timer.unref && timer.unref();
  reviewNudges.set(key, timer);
  logger.info(`Review confirmation nudge scheduled for ${key} in ${delayMs}ms`);
}

function clearReviewNudge(key) {
  const timer = reviewNudges.get(key);
  if (timer) {
    clearTimeout(timer);
    reviewNudges.delete(key);
  }
}

router.post("/whatsapp", async (req, res, next) => {
  try {
    if (!twilioService.validateSignature(req)) {
      return res.status(403).json({ error: "Invalid Twilio signature" });
    }

    const from = req.body.From || "unknown";
    const body = (req.body.Body || "").trim();
    const messageSid = req.body.MessageSid;

    const result = await handleMessage(from, body, messageSid);
    if (result === null) {
      return res.status(200).send("<Response></Response>");
    }

    if (result.interactive) {
      await twilioService.sendInteractiveList(
        from,
        result.interactive.bodyText,
        result.interactive.contentSid,
        result.interactive.contentVariables
      );
    } else {
      await twilioService.sendWhatsApp(from, result.text);
    }
    res.status(200).send("<Response></Response>");
  } catch (err) {
    next(err);
  }
});

router.post("/status", express.urlencoded({ extended: false }), (req, res) => {
  const sid = req.body.MessageSid;
  const status = req.body.MessageStatus;
  const errorCode = req.body.ErrorCode;
  const to = req.body.To || "unknown";
  if (status === "failed" || status === "undelivered") {
    logger.error(`[DELIVERY FAILED] to=${to} sid=${sid} status=${status} errorCode=${errorCode || "none"}`);
  } else {
    logger.info(`[DELIVERY] to=${to} sid=${sid} status=${status}`);
  }
  res.sendStatus(200);
});

module.exports = router;
module.exports.getConversation = getConversation;
module.exports.seedConversation = seedConversation;
module.exports.handleMessage = handleMessage;
