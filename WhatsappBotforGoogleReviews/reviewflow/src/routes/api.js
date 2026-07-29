const express = require("express");
const router = express.Router();
const multer = require("multer");
const upload = multer({ storage: multer.memoryStorage() });
const twilioService = require("../services/twilio");
const storage = require("../services/storage");
const templates = require("../utils/hinglishTemplates");
const { requireFields } = require("../middleware/validator");
const webhook = require("./webhook");
const { STATES } = require("../config/constants");
const excelService = require("../services/excelService");
const scheduler = require("../services/scheduler");

router.post("/trigger-review", requireFields(["phone"]), async (req, res, next) => {
  try {
    const { phone, customerName, item } = req.body;
    const welcome = templates.welcomeMessage(customerName || "there", item);
    const result = await twilioService.sendWhatsApp(phone, welcome);

    await storage.appendRecord({ phone, customerName: customerName || "Customer", sentiment: null, state: STATES.AWAITING_RATING, triggerSource: "manual_api" });

    // Seed conversation state so webhook.js has customerName + item when the reply arrives.
    const { normalizePhone } = require("../services/twilio");
    const waKey = `whatsapp:${normalizePhone(phone)}`;
    await webhook.seedConversation(waKey, { state: STATES.AWAITING_RATING, customerName, item });


    // Follow-up nudge if they never reply — see .env FOLLOWUP_DELAY_MS.
    const delay = Number(process.env.FOLLOWUP_DELAY_MS) || 24 * 60 * 60 * 1000;
    setTimeout(async () => {
      const convo = await webhook.getConversation(phone);
      if (convo && convo.state === STATES.AWAITING_RATING) {
        const reminder = templates.followupReminder(customerName || "there");
        await twilioService.sendWhatsApp(phone, reminder);
        await storage.appendRecord({ phone, customerName: customerName || "Customer", sentiment: null, state: STATES.AWAITING_RATING, triggerSource: "followup_reminder" });
      }
    }, delay);

    res.status(201).json({ sent: result.status === "sent", mock: result.mock, message: welcome });
  } catch (err) {
    next(err);
  }
});

router.post("/customers", requireFields(["name", "phone"]), async (req, res, next) => {
  try {
    const { name, phone, visitDate, reviewProvided, additionalNotes } = req.body;
    const customer = await storage.createCustomer({
      name,
      phone,
      visitDate: visitDate ? new Date(visitDate) : new Date(),
      reviewProvided: reviewProvided || false,
      additionalNotes: additionalNotes || "",
    });
    if (!customer) {
      return res.status(409).json({ error: "Customer with this phone already exists" });
    }
    res.status(201).json({ ...customer, message: "Customer created. Use Manual Trigger or Batch Send to message them." });
  } catch (err) {
    next(err);
  }
});

router.get("/customers", async (req, res, next) => {
  try {
    const Customer = require("../models/Customer");
    const customers = await Customer.find({}).sort({ createdAt: -1 }).lean();
    res.json(customers);
  } catch (err) {
    next(err);
  }
});

router.get("/customers/:phone", async (req, res, next) => {
  try {
    const customer = await storage.findCustomerByPhone(req.params.phone);
    if (!customer) return res.status(404).json({ error: "Customer not found" });
    res.json(customer);
  } catch (err) {
    next(err);
  }
});

router.put("/customers/:phone", async (req, res, next) => {
  try {
    const { name, visitDate, reviewProvided, additionalNotes } = req.body;
    const updated = await storage.updateCustomer(req.params.phone, {
      ...(name && { name }),
      ...(visitDate && { visitDate: new Date(visitDate) }),
      ...(reviewProvided !== undefined && { reviewProvided }),
      ...(additionalNotes !== undefined && { additionalNotes }),
    });
    if (!updated) return res.status(404).json({ error: "Customer not found" });
    res.json(updated);
  } catch (err) {
    next(err);
  }
});

router.delete("/customers/:phone", async (req, res, next) => {
  try {
    const ok = await storage.deleteCustomer(req.params.phone);
    if (!ok) return res.status(404).json({ error: "Customer not found or delete failed" });
    res.json({ ok: true, message: `Customer ${req.params.phone} deleted` });
  } catch (err) {
    next(err);
  }
});

router.post("/trigger-batch", async (req, res, next) => {
  try {
    const pending = await storage.findCustomersToContact();
    let sent = 0;
    for (const c of pending) {
      await scheduler.sendWelcome(c);
      sent++;
    }
    res.json({ sent, total: pending.length, mock: !twilioService.isTwilioConfigured() });
  } catch (err) {
    next(err);
  }
});

router.get("/pending-preview", async (req, res, next) => {
  try {
    const pending = await storage.findCustomersToContact();
    res.json(pending);
  } catch (err) {
    next(err);
  }
});

router.post("/test-cron", async (req, res, next) => {
  try {
    await scheduler.processPendingCustomers();
    res.json({ ok: true, message: "Cron logic executed immediately" });
  } catch (err) {
    next(err);
  }
});

router.post("/upload-excel", upload.single("file"), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No file uploaded" });
    const { valid, errors, totalRows } = excelService.parseExcel(req.file.buffer);
    const results = { added: [], skipped: [], errors, totalRows };
    for (const c of valid) {
      const existing = await storage.createCustomer(c);
      if (existing) {
        results.added.push(c.phone);
      } else {
        results.skipped.push(c.phone);
      }
    }
    res.json({ ...results, addedCount: results.added.length, skippedCount: results.skipped.length });
  } catch (err) {
    next(err);
  }
});

router.post("/simulate", async (req, res, next) => {
  try {
    const { phone, messages } = req.body;
    if (!phone || !messages || !Array.isArray(messages)) {
      return res.status(400).json({ error: "Need phone and messages array" });
    }
    const conversation = [];
    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      const reply = await webhook.handleMessage(phone, msg, `sim_${Date.now()}_${i}`);
      conversation.push({ step: i + 1, customer: msg, bot: reply || "(duplicate ignored)" });
    }
    const finalState = await webhook.getConversation(phone);
    res.json({
      phone,
      steps: conversation.length,
      conversation,
      finalState: finalState ? { state: finalState.state, sentiment: finalState.sentiment } : null,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
