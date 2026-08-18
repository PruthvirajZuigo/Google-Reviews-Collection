const cron = require("node-cron");
const storage = require("./storage");
const twilioService = require("./twilio");
const templates = require("../utils/hinglishTemplates");
const webhook = require("../routes/webhook");
const { STATES } = require("../config/constants");
const { resolveClient, getClientById, listClients, DEFAULT_CLIENT_ID } = require("./clientConfig");
const logger = require("./logger");

async function sendWelcome(customer) {
  const client = await resolveClient({ clientId: customer.clientId, phone: customer.phone });
  const clientId = client?.clientId || DEFAULT_CLIENT_ID;

  // Per-client hourly throttle (0 = off). Counts messages this client has
  // already sent this hour; skips the rest once the cap is reached.
  const throttle = Number(client?.compliance?.throttlePerHour) || 0;
  if (throttle > 0) {
    const sentThisHour = await storage.countMessagesSentInHour(clientId);
    if (sentThisHour >= throttle) {
      logger.info(`[SCHEDULER] Throttled for ${clientId}: ${sentThisHour}/${throttle} sent this hour — skipped ${customer.phone}`);
      return false;
    }
  }

  const welcome = templates.welcomeMessage(client.name, customer.additionalNotes);
  const normalizedPhone = twilioService.normalizePhone(customer.phone);
  const result = await twilioService.sendWhatsApp(customer.phone, welcome);
  await storage.markContacted(customer.phone, clientId);
  await storage.appendRecord({
    clientId,
    phone: normalizedPhone,
    customerName: customer.name,
    sentiment: null,
    state: STATES.INIT,
    triggerSource: "scheduler_welcome",
  });
  const waKey = `whatsapp:${normalizedPhone}`;
  await webhook.seedConversation(waKey, {
    state: STATES.INIT,
    clientId,
    customerName: customer.name,
    item: customer.additionalNotes || undefined,
  });
  if (result.status === "sent") {
    logger.info(`[SCHEDULER] Welcome sent to ${customer.name} (${customer.phone}) [${clientId}]`);
  } else {
    logger.info(`[SCHEDULER] Welcome FAILED for ${customer.name} (${customer.phone}): ${result.error || result.status}`);
  }
  return result.status === "sent";
}

async function processPendingCustomers(clientId) {
  if (clientId) {
    const client = await getClientById(clientId);
    if (!client) {
      logger.warn(`[SCHEDULER] Unknown client, skipping: ${clientId}`);
      return { contacted: 0, total: 0 };
    }
    const pending = await storage.findCustomersToContact(clientId, {
      protectionDays: client.scheduler.protectionDays,
      requireOptIn: client.compliance.requireOptIn,
    });
    let contacted = 0;
    for (const c of pending) {
      if (await sendWelcome(c)) contacted++;
    }
    logger.info(`[SCHEDULER] Batch complete for ${client.name} (${clientId}) — contacted ${contacted} of ${pending.length} customers`);
    return { contacted, total: pending.length };
  }

  logger.info("[SCHEDULER] Running batch — checking pending customers across all clients...");
  let total = 0;
  let contacted = 0;
  const clients = await listClients();
  for (const client of clients) {
    const pending = await storage.findCustomersToContact(client.clientId, {
      protectionDays: client.scheduler.protectionDays,
      requireOptIn: client.compliance.requireOptIn,
    });
    total += pending.length;
    for (const c of pending) {
      if (await sendWelcome(c)) contacted++;
    }
  }
  logger.info(`[SCHEDULER] Batch complete — contacted ${contacted} of ${total} customers`);
  return { contacted, total };
}

// One cron task per unique batch time. Rebuilt on boot and whenever a client is
// created/updated/deleted so per-client times genuinely drive the scheduler.
const crons = new Map();

async function reschedule() {
  for (const task of crons.values()) task.stop();
  crons.clear();

  const clients = await listClients();
  const byTime = new Map();
  for (const c of clients) {
    const time = c.scheduler.batchTime || "12:30";
    const parts = time.split(":");
    const h = Number(parts[0]);
    const m = Number(parts[1]);
    if (!Number.isFinite(h) || !Number.isFinite(m)) {
      logger.warn(`[SCHEDULER] Invalid batchTime "${time}" for ${c.clientId} — skipped`);
      continue;
    }
    const expr = `${m} ${h} * * *`;
    if (!byTime.has(expr)) byTime.set(expr, []);
    byTime.get(expr).push(c.clientId);
  }

  for (const [expr, ids] of byTime.entries()) {
    const task = cron.schedule(expr, async () => {
      logger.info(`[SCHEDULER] Cron ${expr} — running batch for client(s): ${ids.join(", ")}`);
      for (const id of ids) {
        try {
          await processPendingCustomers(id);
        } catch (err) {
          logger.error(`[SCHEDULER] Cron batch failed for ${id}:`, err.message);
        }
      }
    });
    crons.set(expr, task);
    logger.info(`[SCHEDULER] Cron scheduled at ${expr} for client(s): ${ids.join(", ")}`);
  }
  if (byTime.size === 0) logger.info("[SCHEDULER] No clients with a valid batch time");
}

function start() {
  reschedule().catch((err) => logger.error("[SCHEDULER] Initial reschedule failed:", err.message));
  return { processPendingCustomers, reschedule };
}

module.exports = { start, processPendingCustomers, sendWelcome, reschedule };
