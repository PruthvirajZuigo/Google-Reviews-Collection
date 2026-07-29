const express = require("express");
const router = express.Router();

const twilioService = require("../services/twilio");
const { analyzeSentiment, craftReply, extractFreeTextFeedback, generateDraft, generateClosing, understandOffMenuInput } = require("../services/huggingface");
const storage = require("../services/storage");
const logger = require("../services/logger");
const templates = require("../utils/hinglishTemplates");
const { STATES, SENTIMENTS, STATE_TTL_MS, DEMO_BUSINESS } = require("../config/constants");
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

async function handleMessage(from, body, messageSid) {
  const lastSeen = (await getState(from))?.lastMessageSid;
  if (messageSid && messageSid === lastSeen) {
    logger.info(`Duplicate webhook delivery ignored: ${messageSid}`);
    return null;
  }

  let convo = await getState(from) || { state: STATES.INIT, customerName: "Customer" };
  const history = await storage.getRecentHistory(from);
  let replyText;

  if (convo.state === STATES.INIT || convo.state === STATES.AWAITING_RATING) {
    const pastRecords = await storage.findByPhone(from);
    if (pastRecords.length > 0) {
      convo.customerName = pastRecords[0].customerName || convo.customerName;
    }
    const SEVEN_DAYS = 7 * 24 * 60 * 60 * 1000;
    const oldCompleted = pastRecords.find(
      (r) => r.state === STATES.COMPLETED && new Date(r.createdAt).getTime() < Date.now() - SEVEN_DAYS
    );
    const reengagement = oldCompleted ? `${templates.followupReengagement()}\n\n` : "";

    const { sentiment } = await analyzeSentiment(body, history);

    let nextState, optionText;
    if (sentiment === SENTIMENTS.SAD) {
      nextState = STATES.AWAITING_FEEDBACK_CHOICE;
      optionText = templates.feedbackOptionsSad();
    } else if (sentiment === SENTIMENTS.NEUTRAL) {
      nextState = STATES.AWAITING_FEEDBACK_CHOICE;
      optionText = templates.feedbackOptionsNeutral();
    } else {
      nextState = STATES.AWAITING_REVIEW_CHOICE;
      optionText = templates.reviewOptionsText();
    }

    await setState(from, { state: nextState, sentiment, lastMessageSid: messageSid });
    replyText = reengagement + optionText;
    await storage.appendRecord({ phone: from, customerName: convo.customerName, sentiment, state: nextState, triggerSource: "webhook" });
  } else if (convo.state === STATES.AWAITING_REVIEW_CHOICE) {
    const choice = parseInt(body.trim());
    let label = templates.REVIEW_OPTION_LABELS[choice];
    if (!label) label = await extractFreeTextFeedback(body, "happy", history);
    if (!label) {
      replyText = await tryAiUnderstand(body, convo.state, convo.sentiment, history, templates.reviewOptionsText());
    } else {
      await setState(from, { state: STATES.AWAITING_DRAFT_CHOICE, choice: label, lastMessageSid: messageSid });
      await storage.appendRecord({ phone: from, customerName: convo.customerName, sentiment: convo.sentiment, state: STATES.AWAITING_DRAFT_CHOICE, feedbackText: label, triggerSource: "webhook" });
      replyText = templates.draftOption();
    }
  } else if (convo.state === STATES.AWAITING_FEEDBACK_CHOICE) {
    const choice = parseInt(body.trim());
    let label = templates.FEEDBACK_OPTION_LABELS[choice];
    if (!label) label = await extractFreeTextFeedback(body, convo.sentiment === SENTIMENTS.SAD ? "sad" : "neutral", history);
    if (!label) {
      replyText = await tryAiUnderstand(body, convo.state, convo.sentiment, history,
        convo.sentiment === SENTIMENTS.SAD ? templates.feedbackOptionsSad() : templates.feedbackOptionsNeutral());
    } else {
      if (convo.sentiment === SENTIMENTS.SAD) {
        await setState(from, { state: STATES.AWAITING_ESCALATION, choice: label, lastMessageSid: messageSid });
        await storage.appendRecord({ phone: from, customerName: convo.customerName, sentiment: convo.sentiment, state: STATES.AWAITING_ESCALATION, feedbackText: label, triggerSource: "webhook" });
        replyText = templates.escalationOptions();
      } else {
        await setState(from, { state: STATES.AWAITING_DRAFT_CHOICE, choice: label, lastMessageSid: messageSid });
        await storage.appendRecord({ phone: from, customerName: convo.customerName, sentiment: convo.sentiment, state: STATES.AWAITING_DRAFT_CHOICE, feedbackText: label, triggerSource: "webhook" });
        replyText = templates.draftOption();
      }
    }
  } else if (convo.state === STATES.AWAITING_ESCALATION) {
    const choice = parseInt(body.trim());
    const escalationLabel = templates.ESCALATION_OPTION_LABELS[choice];
    if (!escalationLabel) {
      replyText = await tryAiUnderstand(body, convo.state, convo.sentiment, history, templates.escalationOptions());
    } else {
      await setState(from, { state: STATES.AWAITING_DRAFT_CHOICE, escalation: escalationLabel, lastMessageSid: messageSid });
      if (escalationLabel === "Contact me") {
        await twilioService.sendWhatsApp(DEMO_BUSINESS.managerWhatsapp, `⚠️ Customer requested follow-up from ${from}: "${convo.choice}"\nAction: Contact customer`);
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
      else replyText = await tryAiUnderstand(body, convo.state, convo.sentiment, history, templates.draftOption());
    }
    if (draftChoice) {
      await setState(from, { state: STATES.COMPLETED, lastMessageSid: messageSid });
      await storage.appendRecord({ phone: from, customerName: convo.customerName, sentiment: convo.sentiment, state: STATES.COMPLETED, feedbackText: convo.choice || body, triggerSource: "webhook" });
      if (draftChoice === "Yes") {
        const draft = await generateDraft(convo.choice || body, convo.sentiment || "happy");
        replyText = `Here's a draft based on your feedback:\n\n${draft}\n\n${DEMO_BUSINESS.googleReviewUrl}`;
      } else {
        replyText = `No problem! Here's the link to leave a review:\n\n${DEMO_BUSINESS.googleReviewUrl}`;
      }
    }
  } else if (convo.state === STATES.COMPLETED) {
    if (templates.isDraftRewriteRequest(body) && convo.choice) {
      const draft = await generateDraft(convo.choice, convo.sentiment || "happy", true);
      replyText = `Sure! Here's a more detailed version:\n\n${draft}\n\n${DEMO_BUSINESS.googleReviewUrl}`;
    } else if (templates.isDraftRewriteRequest(body)) {
      replyText = `Sorry, I don't have your previous feedback to expand on. Could you tell me about your experience?`;
    } else {
      const aiResponse = await understandOffMenuInput(body, convo.state, convo.sentiment, history);
      if (aiResponse) {
        replyText = aiResponse;
      } else {
        const aiClosing = await generateClosing(body, convo.sentiment, convo.state, history);
        replyText = aiClosing || templates.closingVariants();
      }
    }
  } else {
    replyText = templates.closingVariants();
  }

  logger.info(`[${from}] state=${convo.state} -> sentiment=${convo.sentiment || "n/a"} -> reply="${replyText?.slice(0, 60)}..."`);
  return replyText;
}

async function tryAiUnderstand(body, stage, sentiment, history, templateFallback) {
  const ai = await understandOffMenuInput(body, stage, sentiment, history);
  return ai || templateFallback;
}

router.post("/whatsapp", async (req, res, next) => {
  try {
    if (!twilioService.validateSignature(req)) {
      return res.status(403).json({ error: "Invalid Twilio signature" });
    }

    const from = req.body.From || "unknown";
    const body = (req.body.Body || "").trim();
    const messageSid = req.body.MessageSid;

    const replyText = await handleMessage(from, body, messageSid);
    if (replyText === null) {
      return res.status(200).send("<Response></Response>");
    }

    await twilioService.sendWhatsApp(from, replyText);
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
