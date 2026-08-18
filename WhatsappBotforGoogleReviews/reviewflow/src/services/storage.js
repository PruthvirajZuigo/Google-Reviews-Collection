const Record = require("../models/Record");
const Customer = require("../models/Customer");
const Conversation = require("../models/Conversation");
const logger = require("./logger");
const { DEFAULT_CLIENT_ID } = require("./clientConfig");

/**
 * Build a query filter that scopes to one client. Legacy documents (created
 * before multi-tenancy, without a clientId) belong to the default client so
 * nothing disappears for the existing setup. Other clients see only their own.
 */
function buildClientFilter(clientId, extra = {}) {
  if (!clientId) return { ...extra };
  if (clientId === DEFAULT_CLIENT_ID) {
    return {
      ...extra,
      $or: [{ clientId }, { clientId: null }, { clientId: { $exists: false } }],
    };
  }
  return { ...extra, clientId };
}

async function readAll(clientId) {
  try {
    return await Record.find(buildClientFilter(clientId)).sort({ createdAt: -1 }).lean();
  } catch (err) {
    logger.error("Failed to read records:", err.message);
    return [];
  }
}

async function appendRecord(record) {
  try {
    const doc = await Record.create({
      id: `rec_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      createdAt: new Date().toISOString(),
      ...record,
    });
    return doc.toObject();
  } catch (err) {
    logger.error("Failed to append record:", err.message);
  }
}

async function seedIfEmpty(mockRecords) {
  try {
    const count = await Record.countDocuments();
    if (count === 0) {
      await Record.insertMany(mockRecords.map((r) => ({
        id: `rec_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        createdAt: new Date().toISOString(),
        ...r,
      })));
      logger.info(`Seeded ${mockRecords.length} mock records into MongoDB`);
    }
  } catch (err) {
    logger.error("Failed to seed records:", err.message);
  }
}

async function markClicked(id, clientId) {
  try {
    const record = await Record.findOneAndUpdate(
      { id, ...buildClientFilter(clientId) },
      { $set: { clickedAt: new Date().toISOString() }, $inc: { clickCount: 1 } },
      { returnDocument: "after" }
    ).lean();
    return record;
  } catch (err) {
    logger.error("Failed to mark clicked:", err.message);
    return null;
  }
}

async function findByPhone(phone, clientId) {
  try {
    return await Record.find({ phone, ...buildClientFilter(clientId) }).sort({ createdAt: -1 }).lean();
  } catch (err) {
    logger.error("Failed to findByPhone:", err.message);
    return [];
  }
}

async function getRecentHistory(phone, limit = 4, clientId) {
  try {
    const records = await Record.find({ phone, ...buildClientFilter(clientId) })
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean();
    return records.reverse().map((r) => ({
      role: r.triggerSource === "webhook" ? "customer" : "bot",
      text: r.feedbackText || "",
      sentiment: r.sentiment,
    })).filter((r) => r.text);
  } catch (err) {
    return [];
  }
}

function normalizeStoredPhone(phone) {
  const cleaned = String(phone || "").replace(/^whatsapp:/, "").replace(/^test:/, "");
  if (cleaned.startsWith("+")) return cleaned;
  if (cleaned.length === 10) return `+91${cleaned}`;
  if (cleaned.startsWith("91") && cleaned.length === 12) return `+${cleaned}`;
  return cleaned;
}

/**
 * When a client actively messages a phone, that phone becomes theirs. Creates a
 * Customer if none exists, or adopts a legacy customer (one with no clientId,
 * created before multi-tenancy) into `clientId`. Customers that already belong
 * to a client are left untouched — we never steal from another client.
 */
async function adoptCustomerByPhone(phone, { clientId, name }) {
  try {
    const norm = normalizeStoredPhone(phone);
    const existing = await Customer.findOne({ $or: [{ phone }, { phone: norm }] }).lean();
    if (!existing) {
      const doc = await Customer.create({
        clientId,
        phone: norm,
        name: name || "Customer",
        visitDate: new Date(),
        reviewProvided: false,
        reviewLinkSentAt: null,
        optedIn: true,
      });
      logger.info(`[CUSTOMER] Created ${norm} under client ${clientId}`);
      return doc.toObject();
    }
    if (!existing.clientId) {
      const patch = { clientId };
      if (!existing.name && name) patch.name = name;
      await Customer.updateOne({ _id: existing._id }, { $set: patch });
      logger.info(`[CUSTOMER] Adopted legacy customer ${norm} under client ${clientId}`);
    }
    return existing;
  } catch (err) {
    logger.error("Failed to adopt customer:", err.message);
    return null;
  }
}

async function createCustomer(data) {
  try {
    // Normalize every phone to E.164 (+91...) so the same number can't be
    // stored twice in different formats (e.g. "9812345678" vs "+919812345678").
    const doc = await Customer.create({ ...data, phone: normalizeStoredPhone(data.phone) });
    return doc.toObject();
  } catch (err) {
    logger.error("Failed to create customer:", err.message);
    return null;
  }
}

async function findCustomersToContact(clientId, opts = {}) {
  try {
    const maxAge = 90 * 24 * 60 * 60 * 1000;
    // Per-client protection window (days); falls back to env then the platform default.
    const protectionDays = opts.protectionDays ?? (Number(process.env.REVIEW_CONFIRM_PROTECTION_DAYS) || 7);
    const protectionMs = protectionDays * 24 * 60 * 60 * 1000;
    // Per-client consent gating: when requireOptIn is on, only contact customers
    // who have explicitly opted in.
    const consentFilter = opts.requireOptIn === true ? { optedIn: true } : {};
    const customers = await Customer.find(buildClientFilter(clientId, { reviewProvided: false, optedOut: { $ne: true }, ...consentFilter })).lean();
    const pending = [];
    for (const c of customers) {
      if (c.visitDate && Date.now() - new Date(c.visitDate).getTime() > maxAge) continue;
      // Don't re-message someone who recently got the review link — they may be
      // about to (or have just) posted their review.
      if (c.reviewLinkSentAt && Date.now() - new Date(c.reviewLinkSentAt).getTime() < protectionMs) continue;
      const waPhone = `whatsapp:${normalizeStoredPhone(c.phone)}`;
      const convo = await Conversation.findOne({ phone: waPhone }).lean();
      const isExpired = convo && convo.expiresAt && new Date(convo.expiresAt).getTime() < Date.now();
      if (!convo || isExpired) {
        pending.push(c);
      }
    }
    return pending;
  } catch (err) {
    logger.error("Failed to find customers to contact:", err.message);
    return [];
  }
}

async function countMessagesSentInHour(clientId) {
  try {
    const hourAgo = new Date(Date.now() - 60 * 60 * 1000);
    return await Record.countDocuments(buildClientFilter(clientId, { createdAt: { $gte: hourAgo } }));
  } catch (err) {
    logger.error("Failed to count hourly messages:", err.message);
    return 0;
  }
}

async function markContacted(phone, clientId) {
  try {
    await Customer.updateOne({ phone, ...buildClientFilter(clientId) }, { $set: { firstContactedAt: new Date() } });
  } catch (err) {
    logger.error("Failed to mark contacted:", err.message);
  }
}

async function markReviewProvided(phone, clientId) {
  try {
    const normalized = normalizeStoredPhone(phone);
    await Customer.updateOne(
      { $and: [{ $or: [{ phone }, { phone: normalized }] }, buildClientFilter(clientId)] },
      { $set: { reviewProvided: true } }
    );
  } catch (err) {
    logger.error("Failed to mark review provided:", err.message);
  }
}

async function markReviewLinkSent(phone, clientId) {
  try {
    const normalized = normalizeStoredPhone(phone);
    await Customer.updateOne(
      { $and: [{ $or: [{ phone }, { phone: normalized }] }, buildClientFilter(clientId)] },
      { $set: { reviewLinkSentAt: new Date() } }
    );
  } catch (err) {
    logger.error("Failed to mark review link sent:", err.message);
  }
}

async function setCustomerReviewText(phone, clientId, text) {
  try {
    const normalized = normalizeStoredPhone(phone);
    await Customer.updateOne(
      { $and: [{ $or: [{ phone }, { phone: normalized }] }, buildClientFilter(clientId)] },
      { $set: { reviewText: text } }
    );
  } catch (err) {
    logger.error("Failed to set customer review text:", err.message);
  }
}

async function deleteCustomer(phone, clientId) {
  try {
    const normalized = normalizeStoredPhone(phone);
    const waPhone = `whatsapp:${normalized}`;
    const result = await Customer.deleteOne({ $and: [{ $or: [{ phone }, { phone: normalized }] }, buildClientFilter(clientId)] });
    if (result.deletedCount === 0) {
      logger.info(`Customer not found for deletion: ${phone}`);
      return false;
    }
    await Conversation.deleteOne({ phone: waPhone });
    await Record.deleteMany({ phone: { $in: [phone, normalized, waPhone] } });
    logger.info(`Deleted customer + associated data for ${normalized}`);
    return true;
  } catch (err) {
    logger.error("Failed to delete customer:", err.message);
    return false;
  }
}

async function updateCustomer(phone, data, clientId) {
  try {
    const normalized = normalizeStoredPhone(phone);
    const doc = await Customer.findOneAndUpdate(
      { $and: [{ $or: [{ phone }, { phone: normalized }] }, buildClientFilter(clientId)] },
      { $set: { ...data, updatedAt: new Date() } },
      { returnDocument: "after", upsert: false }
    ).lean();
    return doc;
  } catch (err) {
    logger.error("Failed to update customer:", err.message);
    return null;
  }
}

async function findCustomerByPhone(phone, clientId) {
  try {
    const normalized = normalizeStoredPhone(phone);
    return await Customer.findOne({
      $and: [{ $or: [{ phone }, { phone: normalized }] }, buildClientFilter(clientId)],
    }).lean();
  } catch (err) {
    return null;
  }
}

async function listCustomers(clientId) {
  try {
    return await Customer.find(buildClientFilter(clientId)).sort({ createdAt: -1 }).lean();
  } catch (err) {
    return [];
  }
}

module.exports = {
  readAll,
  appendRecord,
  seedIfEmpty,
  markClicked,
  findByPhone,
  getRecentHistory,
  createCustomer,
  findCustomersToContact,
  countMessagesSentInHour,
  markContacted,
  markReviewProvided,
  markReviewLinkSent,
  setCustomerReviewText,
  deleteCustomer,
  updateCustomer,
  findCustomerByPhone,
  listCustomers,
  adoptCustomerByPhone,
};
