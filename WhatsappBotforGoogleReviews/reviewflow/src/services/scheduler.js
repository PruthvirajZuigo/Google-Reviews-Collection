const cron = require("node-cron");
const storage = require("./storage");
const twilioService = require("./twilio");
const templates = require("../utils/hinglishTemplates");
const webhook = require("../routes/webhook");
const { STATES, DEMO_BUSINESS } = require("../config/constants");
const logger = require("./logger");

async function sendWelcome(customer) {
  const welcome = templates.welcomeMessage(DEMO_BUSINESS.name, customer.additionalNotes);
  const normalizedPhone = twilioService.normalizePhone(customer.phone);
  const result = await twilioService.sendWhatsApp(customer.phone, welcome);
  await storage.markContacted(customer.phone);
  await storage.appendRecord({
    phone: normalizedPhone,
    customerName: customer.name,
    sentiment: null,
    state: STATES.INIT,
    triggerSource: "scheduler_welcome",
  });
  const waKey = `whatsapp:${normalizedPhone}`;
  await webhook.seedConversation(waKey, {
    state: STATES.INIT,
    customerName: customer.name,
    item: customer.additionalNotes || undefined,
  });
  if (result.status === "sent") {
    logger.info(`[SCHEDULER] Welcome sent to ${customer.name} (${customer.phone})`);
  }
}

async function processPendingCustomers() {
  logger.info("[SCHEDULER] Running 12:30pm batch — checking pending customers...");
  const pending = await storage.findCustomersToContact();
  for (const c of pending) {
    await sendWelcome(c);
  }
  logger.info(`[SCHEDULER] Batch complete — contacted ${pending.length} customers`);
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
