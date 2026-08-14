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
      text: r.feedbackText || r.choice || "",
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

async function createCustomer(data) {
  try {
    const doc = await Customer.create(data);
    return doc.toObject();
  } catch (err) {
    logger.error("Failed to create customer:", err.message);
    return null;
  }
}

async function findCustomersToContact(clientId) {
  try {
    const maxAge = 90 * 24 * 60 * 60 * 1000;
    const protectionDays = Number(process.env.REVIEW_CONFIRM_PROTECTION_DAYS) || 7;
    const protectionMs = protectionDays * 24 * 60 * 60 * 1000;
    const customers = await Customer.find(buildClientFilter(clientId, { reviewProvided: false, optedOut: { $ne: true } })).lean();
    const pending = [];
    for (const c of customers) {
      if (c.visitDate && Date.now() - new Date(c.visitDate).getTime() > maxAge) continue;
      // Don't re-message someone who recently got the review link — they may be
      // about to (or have just) posted their review.
      if (c.reviewLinkSentAt && Date.now() - new Date(c.reviewLinkSentAt).getTime() < protectionMs) continue;
      const normalized = c.phone.startsWith("+") ? c.phone : c.phone.length === 10 ? `+91${c.phone}` : c.phone;
      const waPhone = `whatsapp:${normalized}`;
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

async function deleteCustomer(phone, clientId) {
  try {
    const normalized = phone.startsWith("+") ? phone : phone.length === 10 ? `+91${phone}` : phone;
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
    const normalized = phone.startsWith("+") ? phone : phone.length === 10 ? `+91${phone}` : phone;
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
    const normalized = phone.startsWith("+") ? phone : phone.length === 10 ? `+91${phone}` : phone;
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
  markContacted,
  markReviewProvided,
  markReviewLinkSent,
  deleteCustomer,
  updateCustomer,
  findCustomerByPhone,
  listCustomers,
};
