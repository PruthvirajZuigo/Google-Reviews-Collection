const express = require("express");
const router = express.Router();
const multer = require("multer");
const upload = multer({ storage: multer.memoryStorage() });
const twilioService = require("../services/twilio");
const storage = require("../services/storage");
const templates = require("../utils/hinglishTemplates");
const { requireFields } = require("../middleware/validator");
const { requireAuth, requireAdmin, resolveScope } = require("../middleware/auth");
const webhook = require("./webhook");
const { STATES } = require("../config/constants");
const { resolveClient, DEFAULT_CLIENT_ID, getClientById } = require("../services/clientConfig");
const excelService = require("../services/excelService");
const scheduler = require("../services/scheduler");
const path = require("path");
const User = require("../models/User");
const auth = require("../services/auth");

// ---- Auth ----

router.post("/login", requireFields(["username", "password"]), async (req, res, next) => {
  try {
    const user = await User.findOne({ username: req.body.username }).lean();
    if (!user || !auth.verifyPassword(req.body.password, user.passwordHash)) {
      return res.status(401).json({ error: "Invalid username or password" });
    }
    if (!user.active) return res.status(403).json({ error: "Account disabled" });
    const token = auth.signToken(user);
    res.json({
      token,
      user: { _id: user._id, username: user.username, role: user.role, name: user.name, clientId: user.clientId || null },
    });
  } catch (err) {
    next(err);
  }
});

router.get("/me", requireAuth, async (req, res) => {
  const client = req.user.clientId ? await getClientById(req.user.clientId) : null;
  res.json({
    user: { _id: req.user._id, username: req.user.username, role: req.user.role, name: req.user.name, clientId: req.user.clientId || null },
    client: client ? { clientId: client.clientId, name: client.name, features: client.features } : null,
  });
});

// Runs `fn` over `items` with a concurrency pool; returns [{ok, error}] per item.
async function runConcurrent(items, concurrency, fn) {
  const results = [];
  let idx = 0;
  async function worker() {
    while (idx < items.length) {
      const i = idx++;
      const item = items[i];
      try {
        await fn(item);
        results.push({ ok: true });
      } catch (err) {
        results.push({ ok: false, error: err.message });
      }
    }
  }
  const workers = Array.from({ length: Math.min(concurrency, items.length || 1) }, () => worker());
  await Promise.all(workers);
  return results;
}

/**
 * Feature-gate middleware for client-role accounts (Admin → Features).
 * When a feature is disabled for their client, the endpoint returns 403 so a
 * hidden feature can't be called directly. Admins always pass — they manage all
 * clients, so their own gating is the dashboard's job (which shows everything).
 * @param {string} feature one of the Client.features keys
 */
function requireClientFeature(feature) {
  return async (req, res, next) => {
    if (req.user && req.user.role === "client") {
      const client = req.scopedClientId ? await getClientById(req.scopedClientId) : null;
      const allowed = !!(client && client.features && client.features[feature] !== false);
      if (!allowed) {
        return res.status(403).json({ error: `This feature is disabled for your client.` });
      }
    }
    next();
  };
}

/** Load per-client rules (protection days, consent gate) for batch operations. */
async function clientBatchOpts(scopedClientId) {
  if (!scopedClientId) return {};
  const client = await getClientById(scopedClientId);
  if (!client) return {};
  return {
    protectionDays: client.scheduler.protectionDays,
    requireOptIn: client.compliance.requireOptIn,
  };
}

router.post("/trigger-review", requireAuth, resolveScope, requireClientFeature("manualTrigger"), requireFields(["phone"]), async (req, res, next) => {
  try {
    const { phone, customerName, item } = req.body;
    const clientId = req.scopedClientId || (req.user.role === "client" ? req.user.clientId : null);
    const client = await resolveClient({ clientId, phone });
    const cId = client?.clientId || DEFAULT_CLIENT_ID;
    // The client that messages a phone becomes its owner (creates the customer,
    // or adopts a legacy customer that predates multi-tenancy) so the customer's
    // replies are attributed back to this client in the webhook.
    await storage.adoptCustomerByPhone(phone, { clientId: cId, name: customerName });
    const welcome = templates.welcomeMessage(client.name, item);
    const result = await twilioService.sendWhatsApp(phone, welcome);

    await storage.appendRecord({ clientId: cId, phone, customerName: customerName || "Customer", sentiment: null, state: STATES.AWAITING_RATING, triggerSource: "manual_api" });

    // Seed conversation state so webhook.js has customerName + item when the reply arrives.
    const { normalizePhone } = require("../services/twilio");
    const waKey = `whatsapp:${normalizePhone(phone)}`;
    await webhook.seedConversation(waKey, { state: STATES.AWAITING_RATING, clientId: cId, customerName, item });


    // Follow-up nudge if they never reply — see .env FOLLOWUP_DELAY_MS.
    const delay = Number(process.env.FOLLOWUP_DELAY_MS) || 24 * 60 * 60 * 1000;
    setTimeout(async () => {
      const convo = await webhook.getConversation(phone);
      if (convo && convo.state === STATES.AWAITING_RATING) {
        const reminder = templates.followupReminder(client.name);
        await twilioService.sendWhatsApp(phone, reminder);
        await storage.appendRecord({ clientId: cId, phone, customerName: customerName || "Customer", sentiment: null, state: STATES.AWAITING_RATING, triggerSource: "followup_reminder" });
      }
    }, delay);

    res.status(201).json({ clientId: cId, sent: result.status === "sent", mock: result.mock, message: welcome });
  } catch (err) {
    next(err);
  }
});

router.post("/customers", requireAuth, resolveScope, requireFields(["name", "phone"]), async (req, res, next) => {
  try {
    const { name, phone, visitDate, reviewProvided, additionalNotes, optedIn } = req.body;
    const customer = await storage.createCustomer({
      clientId: req.scopedClientId || DEFAULT_CLIENT_ID,
      name,
      phone,
      visitDate: visitDate ? new Date(visitDate) : new Date(),
      reviewProvided: reviewProvided || false,
      additionalNotes: additionalNotes || "",
      optedIn: optedIn !== undefined ? optedIn : true,
    });
    if (!customer) {
      return res.status(409).json({ error: "Customer with this phone already exists" });
    }
    res.status(201).json({ ...customer, message: "Customer created. Use Manual Trigger or Batch Send to message them." });
  } catch (err) {
    next(err);
  }
});

router.get("/customers", requireAuth, resolveScope, async (req, res, next) => {
  try {
    const clientId = req.scopedClientId;
    const customers = await storage.listCustomers(clientId);
    res.json(customers);
  } catch (err) {
    next(err);
  }
});

router.get("/customers/:phone", requireAuth, resolveScope, async (req, res, next) => {
  try {
    const clientId = req.scopedClientId;
    const customer = await storage.findCustomerByPhone(req.params.phone, clientId);
    if (!customer) return res.status(404).json({ error: "Customer not found" });
    res.json(customer);
  } catch (err) {
    next(err);
  }
});

router.put("/customers/:phone", requireAuth, resolveScope, async (req, res, next) => {
  try {
    const { name, visitDate, reviewProvided, additionalNotes, optedOut, optedIn } = req.body;
    const updated = await storage.updateCustomer(req.params.phone, {
      ...(name && { name }),
      ...(visitDate && { visitDate: new Date(visitDate) }),
      ...(reviewProvided !== undefined && { reviewProvided }),
      ...(additionalNotes !== undefined && { additionalNotes }),
      ...(optedIn !== undefined && { optedIn }),
      ...(optedOut !== undefined && { optedOut, ...(optedOut ? { optedOutAt: new Date() } : { optedOutAt: null }) }),
    }, req.scopedClientId);
    if (!updated) return res.status(404).json({ error: "Customer not found" });
    res.json(updated);
  } catch (err) {
    next(err);
  }
});

router.delete("/customers/:phone", requireAuth, resolveScope, async (req, res, next) => {
  try {
    const clientId = req.scopedClientId;
    const ok = await storage.deleteCustomer(req.params.phone, clientId);
    if (!ok) return res.status(404).json({ error: "Customer not found or delete failed" });
    res.json({ ok: true, message: `Customer ${req.params.phone} deleted` });
  } catch (err) {
    next(err);
  }
});

router.post("/clear-all-data", requireAuth, resolveScope, async (req, res, next) => {
  try {
    const Customer = require("../models/Customer");
    const Conversation = require("../models/Conversation");
    const Record = require("../models/Record");
    const clientId = req.scopedClientId;
    const filter = clientId
      ? (clientId === DEFAULT_CLIENT_ID
          ? { $or: [{ clientId }, { clientId: null }, { clientId: { $exists: false } }] }
          : { clientId })
      : {};
    const c = await Customer.deleteMany(filter);
    const conv = await Conversation.deleteMany(filter);
    const r = await Record.deleteMany(filter);
    res.json({ ok: true, clientId: clientId || null, customersDeleted: c.deletedCount, conversationsDeleted: conv.deletedCount, recordsDeleted: r.deletedCount });
  } catch (err) {
    next(err);
  }
});

router.post("/trigger-batch", requireAuth, resolveScope, requireClientFeature("manualTrigger"), async (req, res, next) => {
  try {
    const clientId = req.scopedClientId;
    const pending = await storage.findCustomersToContact(clientId, await clientBatchOpts(clientId));
    let sent = 0;
    // Send with a small concurrency pool so large batches return quickly
    // without hammering the WhatsApp provider all at once.
    const CONCURRENCY = Number(process.env.BATCH_CONCURRENCY) || 5;
    const results = await runConcurrent(pending, CONCURRENCY, async (c) => {
      const ok = await scheduler.sendWelcome(c);
      if (ok) sent++;
    });
    res.json({ clientId: clientId || DEFAULT_CLIENT_ID, sent, total: pending.length, failed: results.filter((r) => !r.ok).length, mock: !twilioService.isTwilioConfigured() });
  } catch (err) {
    next(err);
  }
});

router.get("/pending-preview", requireAuth, resolveScope, requireClientFeature("manualTrigger"), async (req, res, next) => {
  try {
    const clientId = req.scopedClientId;
    const pending = await storage.findCustomersToContact(clientId, await clientBatchOpts(clientId));
    res.json(pending);
  } catch (err) {
    next(err);
  }
});

router.post("/test-cron", requireAuth, resolveScope, requireClientFeature("manualTrigger"), async (req, res, next) => {
  try {
    const clientId = req.scopedClientId;
    const result = await scheduler.processPendingCustomers(clientId);
    res.json({ ok: true, ...result, message: "Cron logic executed immediately" });
  } catch (err) {
    next(err);
  }
});

router.post("/upload-excel", requireAuth, resolveScope, requireClientFeature("excelUpload"), upload.single("file"), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No file uploaded" });
    const clientId = req.scopedClientId || DEFAULT_CLIENT_ID;
    const { valid, errors, totalRows } = excelService.parseExcel(req.file.buffer);
    const results = { added: [], skipped: [], errors, totalRows };
    for (const c of valid) {
      const existing = await storage.createCustomer({ ...c, clientId });
      if (existing) {
        results.added.push(c.phone);
      } else {
        results.skipped.push(c.phone);
      }
    }
    res.json({ ...results, clientId, addedCount: results.added.length, skippedCount: results.skipped.length });
  } catch (err) {
    next(err);
  }
});

router.post("/simulate", requireAuth, resolveScope, async (req, res, next) => {
  try {
    const { phone, messages } = req.body;
    if (!phone || !messages || !Array.isArray(messages)) {
      return res.status(400).json({ error: "Need phone and messages array" });
    }
    const clientId = req.scopedClientId;
    const conversation = [];
    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      const reply = await webhook.handleMessage(phone, msg, `sim_${Date.now()}_${i}`, { isTest: true, clientId });
      const replyText = reply && typeof reply === "object" && reply.text ? reply.text : reply;
      conversation.push({ step: i + 1, customer: msg, bot: replyText || "(duplicate ignored)" });
    }
    const finalState = await webhook.getConversation(`test:${phone}`);
    res.json({
      phone,
      clientId,
      steps: conversation.length,
      conversation,
      finalState: finalState ? { state: finalState.state, sentiment: finalState.sentiment } : null,
    });
  } catch (err) {
    next(err);
  }
});

// ---- Admin: client + user management (admin panel backend) ----

const clientConfig = require("../services/clientConfig");

// Serve the admin panel page
router.get("/admin", (req, res) => {
  res.sendFile(path.join(__dirname, "..", "public", "admin.html"));
});

router.get("/admin/clients", requireAuth, requireAdmin, async (req, res, next) => {
  try {
    res.json(await clientConfig.listClients());
  } catch (err) {
    next(err);
  }
});

router.get("/admin/clients/:clientId", requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const client = await clientConfig.getClientById(req.params.clientId);
    if (!client) return res.status(404).json({ error: "Client not found" });
    res.json(client);
  } catch (err) {
    next(err);
  }
});

router.post("/admin/clients", requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const client = await clientConfig.createClient(req.body);
    scheduler.reschedule().catch((err) => console.error("reschedule after create:", err.message));
    res.status(201).json(client);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.put("/admin/clients/:clientId", requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const client = await clientConfig.updateClient(req.params.clientId, req.body);
    scheduler.reschedule().catch((err) => console.error("reschedule after update:", err.message));
    res.json(client);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.delete("/admin/clients/:clientId", requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const ok = await clientConfig.deleteClient(req.params.clientId);
    scheduler.reschedule().catch((err) => console.error("reschedule after delete:", err.message));
    res.json({ ok });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.get("/admin/users", requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const users = await User.find({}).sort({ createdAt: 1 }).lean();
    res.json(users.map((u) => ({ _id: u._id, username: u.username, role: u.role, name: u.name, clientId: u.clientId, active: u.active })));
  } catch (err) {
    next(err);
  }
});

router.post("/admin/users", requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const { username, password, role, name, clientId } = req.body;
    if (!username) return res.status(400).json({ error: "username required" });
    if (role === "client" && !clientId) return res.status(400).json({ error: "clientId required for client accounts" });
    const existing = await User.findOne({ username }).lean();
    if (existing) return res.status(409).json({ error: "Username already exists" });
    const user = new User({ username, role: role || "client", name: name || "", clientId: role === "client" ? clientId : null });
    user.setPassword(password || username);
    await user.save();
    res.status(201).json({ _id: user._id, username: user.username, role: user.role, name: user.name, clientId: user.clientId, active: user.active });
  } catch (err) {
    next(err);
  }
});

router.put("/admin/users/:id", requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const { name, role, clientId, active, password } = req.body;
    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ error: "User not found" });
    if (name !== undefined) user.name = name;
    if (role !== undefined) user.role = role === "admin" ? "admin" : "client";
    if (role === "client" && clientId) user.clientId = clientId;
    if (role === "admin") user.clientId = null;
    if (clientId !== undefined && user.role === "client") user.clientId = clientId;
    if (active !== undefined) user.active = Boolean(active);
    if (password) user.setPassword(password);
    await user.save();
    res.json({ _id: user._id, username: user.username, role: user.role, name: user.name, clientId: user.clientId, active: user.active });
  } catch (err) {
    next(err);
  }
});

router.delete("/admin/users/:id", requireAuth, requireAdmin, async (req, res, next) => {
  try {
    await User.deleteOne({ _id: req.params.id });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
