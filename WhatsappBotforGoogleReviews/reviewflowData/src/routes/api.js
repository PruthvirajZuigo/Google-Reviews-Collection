const express = require("express");
const router = express.Router();
const twilioService = require("../services/twilio");
const storage = require("../services/storage");
const templates = require("../utils/hinglishTemplates");
const { requireFields } = require("../middleware/validator");
const webhook = require("./webhook");
const { STATES } = require("../config/constants");

router.post("/trigger-review", requireFields(["phone"]), async (req, res, next) => {
  try {
    const { phone, customerName, item } = req.body;
    const welcome = templates.welcomeMessage(customerName || "there", item);
    const result = await twilioService.sendWhatsApp(phone, welcome);

    storage.appendRecord({ phone, customerName: customerName || "Customer", sentiment: null, state: STATES.AWAITING_RATING, triggerSource: "manual_api" });

    // Seed conversation state so webhook.js has customerName + item when the reply arrives.
    const { normalizePhone } = require("../services/twilio");
    const waKey = `whatsapp:${normalizePhone(phone)}`;
    webhook.seedConversation(waKey, { state: STATES.AWAITING_RATING, customerName, item });


    // Follow-up nudge if they never reply — see .env FOLLOWUP_DELAY_MS.
    const delay = Number(process.env.FOLLOWUP_DELAY_MS) || 24 * 60 * 60 * 1000;
    setTimeout(async () => {
      const convo = webhook.getConversation(phone);
      if (convo && convo.state === STATES.AWAITING_RATING) {
        const reminder = templates.followupReminder(customerName || "there");
        await twilioService.sendWhatsApp(phone, reminder);
        storage.appendRecord({ phone, customerName: customerName || "Customer", sentiment: null, state: STATES.AWAITING_RATING, triggerSource: "followup_reminder" });
      }
    }, delay);

    res.status(201).json({ sent: result.status === "sent", mock: result.mock, message: welcome });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
