const express = require("express");
const router = express.Router();

const twilioService = require("../services/twilio");
const { analyzeSentiment, craftReply } = require("../services/huggingface");
const storage = require("../services/storage");
const logger = require("../services/logger");
const templates = require("../utils/hinglishTemplates");
const { STATES, SENTIMENTS, STATE_TTL_MS, DEMO_BUSINESS } = require("../config/constants");

const conversations = new Map();

function getConversation(phone) { return getState(phone); }
function seedConversation(phone, data) { setState(phone, data); }

function getState(phone) {
  const entry = conversations.get(phone);
  if (!entry) return null;
  if (entry.expiresAt < Date.now()) { conversations.delete(phone); return null; }
  return entry;
}

function setState(phone, patch) {
  const existing = conversations.get(phone) || {};
  conversations.set(phone, { ...existing, ...patch, expiresAt: Date.now() + STATE_TTL_MS });
}

router.post("/whatsapp", async (req, res, next) => {
  try {
    if (!twilioService.validateSignature(req)) {
      return res.status(403).json({ error: "Invalid Twilio signature" });
    }

    const from = req.body.From || "unknown";
    const body = (req.body.Body || "").trim();
    const messageSid = req.body.MessageSid;
    const lastSeen = getState(from)?.lastMessageSid;
    if (messageSid && messageSid === lastSeen) {
      logger.info(`Duplicate webhook delivery ignored: ${messageSid}`);
      return res.status(200).send("<Response></Response>");
    }

    let convo = getState(from) || { state: STATES.INIT, customerName: "Customer" };

    let replyText;

    if (convo.state === STATES.INIT || convo.state === STATES.AWAITING_RATING) {
      const { sentiment } = await analyzeSentiment(body);

      let nextState, stage;
      if (sentiment === SENTIMENTS.SAD) { nextState = STATES.AWAITING_FEEDBACK; stage = "ask_bad_followup"; }
      else if (sentiment === SENTIMENTS.NEUTRAL) { nextState = STATES.AWAITING_FEEDBACK; stage = "ask_improve_followup"; }
      else { nextState = STATES.AWAITING_REVIEW; stage = "ask_good_followup"; }

      setState(from, { state: nextState, sentiment, lastMessageSid: messageSid });

      const aiReply = await craftReply(body, stage, { businessName: DEMO_BUSINESS.name, item: convo.item });
      const fallback = sentiment === SENTIMENTS.SAD ? templates.badFollowup()
        : sentiment === SENTIMENTS.NEUTRAL ? "Thanks for letting us know. What can we do to make it better?"
          : templates.goodFollowup();
      replyText = aiReply || fallback;

      storage.appendRecord({ phone: from, customerName: convo.customerName, sentiment, state: nextState, triggerSource: "webhook" });
    } else if (convo.state === STATES.AWAITING_FEEDBACK) {
      setState(from, { state: STATES.COMPLETED, lastMessageSid: messageSid });

      storage.appendRecord({
        phone: from, customerName: convo.customerName, sentiment: convo.sentiment,
        state: STATES.COMPLETED, feedbackText: body, triggerSource: "webhook",
      });

      // Only alert the manager for genuinely sad feedback, not neutral suggestions.
      if (convo.sentiment === SENTIMENTS.SAD) {
        await twilioService.sendWhatsApp(DEMO_BUSINESS.managerWhatsapp, `⚠️ Customer complaint from ${from}: "${body}"`);
      }

      const closeStage = convo.sentiment === SENTIMENTS.SAD ? "close_bad" : "close_neutral";
      const aiReply = await craftReply(body, closeStage, { businessName: DEMO_BUSINESS.name });
      replyText = aiReply || templates.badClosing();
    } else if (convo.state === STATES.AWAITING_REVIEW) {
      setState(from, { state: STATES.COMPLETED, lastMessageSid: messageSid });

      storage.appendRecord({
        phone: from,
        customerName: convo.customerName,
        sentiment: convo.sentiment,
        state: STATES.COMPLETED,
        feedbackText: body,
        triggerSource: "webhook",
      });

      const aiReply = await craftReply(body, "close_good", { businessName: DEMO_BUSINESS.name });
      const thanks = aiReply || templates.goodClosing();
      replyText = `${thanks}\n\n${DEMO_BUSINESS.googleReviewUrl}`;
    } else if (convo.state === STATES.AWAITING_FEEDBACK) {
      // Turn 2, bad path: they just described the problem — acknowledge it, no link, no external form.
      // This complaint text (feedbackText) is what shows up in the dashboard's "Note" column.
      setState(from, { state: STATES.COMPLETED, lastMessageSid: messageSid });

      storage.appendRecord({
        phone: from,
        customerName: convo.customerName,
        sentiment: SENTIMENTS.SAD,
        state: STATES.COMPLETED,
        feedbackText: body,
        triggerSource: "webhook",
      });

      await twilioService.sendWhatsApp(
        DEMO_BUSINESS.managerWhatsapp,
        `⚠️ Customer complaint from ${from}: "${body}"`
      );

      const aiReply = await craftReply(body, "close_bad", { businessName: DEMO_BUSINESS.name });
      replyText = aiReply || templates.badClosing();
    } else {
      replyText = "Thanks again! 🙏";
    }

    logger.info(`[${from}] state=${convo.state} -> sentiment=${convo.sentiment || "n/a"} -> reply="${replyText.slice(0, 40)}..."`);
    await twilioService.sendWhatsApp(from, replyText);
    res.status(200).send("<Response></Response>");
  } catch (err) {
    next(err);
  }
});

module.exports = router;
module.exports.getConversation = getConversation;
module.exports.seedConversation = seedConversation;
