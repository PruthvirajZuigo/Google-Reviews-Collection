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
      return { contacted: 0 };
    }
    logger.info(`[SCHEDULER] Running batch for ${client.name} (${clientId})...`);
    const pending = await storage.findCustomersToContact(clientId);
    for (const c of pending) {
      await sendWelcome(c);
    }
    logger.info(`[SCHEDULER] Batch complete for ${clientId} — contacted ${pending.length} customers`);
    return { contacted: pending.length };
  }

  logger.info("[SCHEDULER] Running batch — checking pending customers across all clients...");
  let total = 0;
  const clients = await listClients();
  for (const client of clients) {
    const pending = await storage.findCustomersToContact(client.clientId);
    for (const c of pending) {
      await sendWelcome(c);
    }
    total += pending.length;
  }
  logger.info(`[SCHEDULER] Batch complete — contacted ${total} customers`);
  return { contacted: total };
}

function start() {
  const EVERY_1230PM = "30 12 * * *";
  cron.schedule(EVERY_1230PM, () => {
    processPendingCustomers();
  });
  logger.info("[SCHEDULER] Cron scheduled: 12:30 PM daily");
  return { processPendingCustomers };
}

module.exports = { start, processPendingCustomers, sendWelcome };
