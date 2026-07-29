const logger = require("./logger");

function isTwilioConfigured() {
  return Boolean(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN);
}

function getClient() {
  const twilio = require("twilio");
  return twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
}

/**
 * Normalizes a phone number to E.164 format, defaulting to India's +91
 * country code if none is given — since this product is India-first and
 * a bare 10-digit number typed without "+" should not silently become a
 * US number.
 */
function normalizePhone(raw) {
  let cleaned = (raw || "").replace(/[^\d+]/g, ""); // strip spaces/dashes, keep leading +
  if (cleaned.startsWith("+")) return cleaned;
  if (cleaned.length === 10) return `+91${cleaned}`; // bare 10-digit Indian mobile number
  if (cleaned.startsWith("91") && cleaned.length === 12) return `+${cleaned}`;
  return `+${cleaned}`; // last resort — at least ensure a "+" is present
}

async function sendWhatsApp(to, body) {
  const normalized = normalizePhone(to);
  const baseUrl = process.env.BASE_URL || "";
  const statusCallback = baseUrl ? `${baseUrl.replace(/\/+$/, "")}/webhook/status` : undefined;

  if (!isTwilioConfigured()) {
    logger.info(`[MOCK WHATSAPP SEND] -> ${normalized}\n${body}`);
    return { status: "sent", mock: true };
  }
  try {
    const client = getClient();
    const from = process.env.TWILIO_WHATSAPP_FROM || "whatsapp:+14155238886";
    const msg = await client.messages.create({
      from,
      to: `whatsapp:${normalized}`,
      body,
      ...(statusCallback && { statusCallback }),
    });
    return { status: "sent", sid: msg.sid, mock: false };
  } catch (err) {
    logger.error("Twilio send failed:", err.message);
    return { status: "failed", error: err.message, mock: false };
  }
}

function validateSignature(req) {
  if (process.env.VALIDATE_TWILIO_SIGNATURE !== "true") return true;
  try {
    const twilio = require("twilio");
    const signature = req.headers["x-twilio-signature"];
    const url = `${req.protocol}://${req.get("host")}${req.originalUrl}`;
    return twilio.validateRequest(process.env.TWILIO_AUTH_TOKEN, signature, url, req.body);
  } catch (err) {
    logger.error("Signature validation error:", err.message);
    return false;
  }
}

module.exports = { sendWhatsApp, validateSignature, isTwilioConfigured, normalizePhone };