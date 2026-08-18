const express = require("express");
const router = express.Router();

const twilioService = require("../services/twilio");
const { analyzeSentiment, craftReply, extractFreeTextFeedback } = require("../services/huggingface");
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
      const pastRecords = storage.findByPhone(from);
      if (pastRecords.length > 0) {
        convo.customerName = pastRecords[0].customerName || convo.customerName;
      }
      const SEVEN_DAYS = 7 * 24 * 60 * 60 * 1000;
      const oldCompleted = pastRecords.find(
        (r) => r.state === STATES.COMPLETED && new Date(r.createdAt).getTime() < Date.now() - SEVEN_DAYS
      );
      const reengagement = oldCompleted ? `${templates.followupReengagement()}\n\n` : "";

      const { sentiment } = await analyzeSentiment(body);

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

      setState(from, { state: nextState, sentiment, lastMessageSid: messageSid });
      replyText = reengagement + optionText;

      storage.appendRecord({ phone: from, customerName: convo.customerName, sentiment, state: nextState, triggerSource: "webhook" });
    } else if (convo.state === STATES.AWAITING_REVIEW_CHOICE) {
      const choice = parseInt(body.trim());
      let label = templates.REVIEW_OPTION_LABELS[choice];

      if (!label) {
        label = await extractFreeTextFeedback(body, "happy");
      }

      if (!label) {
        replyText = templates.reviewOptionsText();
      } else {
        setState(from, { state: STATES.COMPLETED, choice: label, lastMessageSid: messageSid });

        storage.appendRecord({
          phone: from, customerName: convo.customerName, sentiment: convo.sentiment,
          state: STATES.COMPLETED, feedbackText: label, triggerSource: "webhook",
        });

        const aiReply = await craftReply(body, "close_good", { businessName: DEMO_BUSINESS.name });
        const thanks = aiReply || templates.goodClosing();
        replyText = `${thanks}\n\n${DEMO_BUSINESS.googleReviewUrl}`;
      }
    } else if (convo.state === STATES.AWAITING_FEEDBACK_CHOICE) {
      const choice = parseInt(body.trim());
      let label = templates.FEEDBACK_OPTION_LABELS[choice];

      if (!label) {
        label = await extractFreeTextFeedback(body, convo.sentiment === SENTIMENTS.SAD ? "sad" : "neutral");
      }

      if (!label) {
        replyText = convo.sentiment === SENTIMENTS.SAD ? templates.feedbackOptionsSad() : templates.feedbackOptionsNeutral();
      } else {
        if (convo.sentiment === SENTIMENTS.SAD) {
          setState(from, { state: STATES.AWAITING_ESCALATION, choice: label, lastMessageSid: messageSid });

          storage.appendRecord({
            phone: from, customerName: convo.customerName, sentiment: convo.sentiment,
            state: STATES.AWAITING_ESCALATION, feedbackText: label, triggerSource: "webhook",
          });

          replyText = templates.escalationOptions();
        } else {
          setState(from, { state: STATES.COMPLETED, choice: label, lastMessageSid: messageSid });

          storage.appendRecord({
            phone: from, customerName: convo.customerName, sentiment: convo.sentiment,
            state: STATES.COMPLETED, feedbackText: label, triggerSource: "webhook",
          });

          const closeStage = "close_neutral";
          const aiReply = await craftReply(body, closeStage, { businessName: DEMO_BUSINESS.name });
          replyText = aiReply || templates.badClosing();
        }
      }
    } else if (convo.state === STATES.AWAITING_ESCALATION) {
      const choice = parseInt(body.trim());
      const escalationLabel = templates.ESCALATION_OPTION_LABELS[choice];

      if (!escalationLabel) {
        replyText = templates.escalationOptions();
      } else {
        setState(from, { state: STATES.COMPLETED, escalation: escalationLabel, lastMessageSid: messageSid });

        if (escalationLabel === "Contact me") {
          await twilioService.sendWhatsApp(
            DEMO_BUSINESS.managerWhatsapp,
            `⚠️ Customer requested follow-up from ${from}: "${convo.choice}"\nAction: Contact customer`
          );
        }

        const aiReply = await craftReply(body, "close_bad", { businessName: DEMO_BUSINESS.name });
        replyText = aiReply || templates.badClosing();
      }
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
