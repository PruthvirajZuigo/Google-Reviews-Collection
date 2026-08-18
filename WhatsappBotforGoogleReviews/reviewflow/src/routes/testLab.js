const express = require("express");
const router = express.Router();
const mongoose = require("mongoose");
const webhook = require("./webhook");
const twilioService = require("../services/twilio");
const Conversation = require("../models/Conversation");
const TestMessage = require("../models/TestMessage");
const { requireFields } = require("../middleware/validator");
const clientConfig = require("../services/clientConfig");

/**
 * Test Lab is a per-client feature: client-role accounts can only use it when
 * their Admin → Features → Test Lab flag is on. Admins always pass (they own
 * every business, so they're never blocked from the simulator).
 */
async function requireTestLabFeature(req, res, next) {
  try {
    if (req.user && req.user.role === "client") {
      const client = await clientConfig.getClientById(req.user.clientId);
      const allowed = !!(client && client.features && client.features.testLab === true);
      if (!allowed) {
        return res.status(403).json({ error: "Test Lab is disabled for your client." });
      }
    }
    next();
  } catch (err) {
    next(err);
  }
}
router.use(requireTestLabFeature);

const SCENARIOS = {
  happy_review: {
    name: "Happy → full review draft",
    messages: ["Great food and nice ambience!", "1", "Yes"],
  },
  happy_free_text: {
    name: "Happy → free-text feedback",
    messages: ["Great food and nice ambience!", "Staff were super friendly", "Yes"],
  },
  sad_escalate: {
    name: "Sad → complain → contact me",
    messages: ["The food was terrible", "1", "1"],
  },
  neutral_draft: {
    name: "Neutral → improvement draft",
    messages: ["It was okay, not great", "1", "Yes"],
  },
  off_menu: {
    name: "Off-menu free text (AI)",
    messages: ["The waiter was rude to us", "The manager refused to help", "1"],
  },
  draft_rewrite: {
    name: "Draft → rewrite longer",
    messages: ["Great food and nice ambience!", "1", "Yes", "make it more detailed"],
  },
  confirm_review_yes: {
    name: "Link → confirm review posted",
    messages: ["Great food and nice ambience!", "1", "No", "1"],
  },
  confirm_review_no: {
    name: "Link → not yet posted",
    messages: ["Great food and nice ambience!", "1", "No", "2"],
  },
};

function genSid() {
  return `test_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

async function clearConversation(phone) {
  await Conversation.deleteOne({ phone: `test:${phone}` });
  await TestMessage.deleteMany({ phone });
}

async function runMessage(phone, message) {
  const reply = await webhook.handleMessage(phone, message, genSid(), { isTest: true });
  await TestMessage.create({ phone, role: "customer", text: message });
  if (reply) {
    await TestMessage.create({
      phone,
      role: "bot",
      text: reply.text,
      interactive: Boolean(reply.interactive),
      state: reply.state,
    });
    return { customer: message, bot: { text: reply.text, interactive: reply.interactive, state: reply.state } };
  }
  return { customer: message, bot: null };
}

router.get("/scenarios", (req, res) => {
  res.json(Object.entries(SCENARIOS).map(([key, s]) => ({ key, name: s.name, steps: s.messages.length })));
});

router.get("/sessions", async (req, res, next) => {
  try {
    const sessions = await TestMessage.aggregate([
      { $sort: { createdAt: -1 } },
      { $group: { _id: "$phone", lastText: { $first: "$text" }, lastRole: { $first: "$role" }, lastState: { $first: "$state" }, updatedAt: { $first: "$createdAt" }, count: { $sum: 1 } } },
      { $sort: { updatedAt: -1 } },
    ]);
    res.json(sessions.map((s) => ({ phone: s._id, lastText: s.lastText, lastRole: s.lastRole, state: s.lastState, updatedAt: s.updatedAt, count: s.count })));
  } catch (err) {
    next(err);
  }
});

router.get("/history", async (req, res, next) => {
  try {
    const phone = req.query.phone;
    if (!phone) return res.status(400).json({ error: "phone query param required" });
    const transcript = await TestMessage.find({ phone }).sort({ createdAt: 1 }).lean();
    const convo = await Conversation.findOne({ phone: `test:${phone}` }).lean();
    res.json({ phone, transcript, state: convo?.state || null, sentiment: convo?.sentiment || null });
  } catch (err) {
    next(err);
  }
});

router.post("/send", requireFields(["phone", "message"]), async (req, res, next) => {
  try {
    const phone = twilioService.normalizePhone(req.body.phone);
    const message = String(req.body.message);
    const reply = await runMessage(phone, message);
    const convo = await Conversation.findOne({ phone: `test:${phone}` }).lean();
    res.json({
      phone,
      customer: reply.customer,
      bot: reply.bot,
      state: convo?.state || null,
      sentiment: convo?.sentiment || null,
    });
  } catch (err) {
    next(err);
  }
});

router.post("/reset", requireFields(["phone"]), async (req, res, next) => {
  try {
    const phone = twilioService.normalizePhone(req.body.phone);
    await clearConversation(phone);
    res.json({ ok: true, phone, message: "Conversation reset — start fresh" });
  } catch (err) {
    next(err);
  }
});

router.post("/scenario", requireFields(["scenario"]), async (req, res, next) => {
  try {
    const scenario = SCENARIOS[req.body.scenario];
    if (!scenario) return res.status(404).json({ error: "Unknown scenario" });
    const phone = req.body.phone
      ? twilioService.normalizePhone(req.body.phone)
      : `+91${9000000000 + Math.floor(Math.random() * 999999999)}`;
    await clearConversation(phone);
    const transcript = [];
    for (const msg of scenario.messages) {
      transcript.push(await runMessage(phone, msg));
    }
    const convo = await Conversation.findOne({ phone: `test:${phone}` }).lean();
    res.json({
      phone,
      scenario: req.body.scenario,
      name: scenario.name,
      transcript,
      finalState: convo ? { state: convo.state, sentiment: convo.sentiment } : null,
    });
  } catch (err) {
    next(err);
  }
});

router.post("/clear", async (req, res, next) => {
  try {
    const deleted = await TestMessage.deleteMany({});
    res.json({ ok: true, deleted: deleted.deletedCount, message: "All test chats cleared" });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
