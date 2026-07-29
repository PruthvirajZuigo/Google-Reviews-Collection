const Record = require("../models/Record");
const Customer = require("../models/Customer");
const Conversation = require("../models/Conversation");
const logger = require("./logger");

async function readAll() {
  try {
    return await Record.find({}).sort({ createdAt: -1 }).lean();
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

async function markClicked(id) {
  try {
    const record = await Record.findOneAndUpdate(
      { id },
      { $set: { clickedAt: new Date().toISOString() }, $inc: { clickCount: 1 } },
      { new: true }
    ).lean();
    return record;
  } catch (err) {
    logger.error("Failed to mark clicked:", err.message);
    return null;
  }
}

async function findByPhone(phone) {
  try {
    return await Record.find({ phone }).sort({ createdAt: -1 }).lean();
  } catch (err) {
    logger.error("Failed to findByPhone:", err.message);
    return [];
  }
}

async function getRecentHistory(phone, limit = 4) {
  try {
    const records = await Record.find({ phone }).sort({ createdAt: -1 }).limit(limit).lean();
    return records.reverse().map((r) => ({
      role: r.triggerSource === "webhook" ? "customer" : "bot",
      text: r.feedbackText || r.choice || "",
      sentiment: r.sentiment,
    })).filter((r) => r.text);
  } catch (err) {
    return [];
  }
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

async function findCustomersToContact() {
  try {
    const maxAge = 90 * 24 * 60 * 60 * 1000;
    const customers = await Customer.find({ reviewProvided: false }).lean();
    const pending = [];
    for (const c of customers) {
      if (c.visitDate && Date.now() - new Date(c.visitDate).getTime() > maxAge) continue;
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

async function markContacted(phone) {
  try {
    await Customer.updateOne({ phone }, { $set: { firstContactedAt: new Date() } });
  } catch (err) {
    logger.error("Failed to mark contacted:", err.message);
  }
}

async function markReviewProvided(phone) {
  try {
    await Customer.updateOne({ phone }, { $set: { reviewProvided: true } });
  } catch (err) {
    logger.error("Failed to mark review provided:", err.message);
  }
}

async function deleteCustomer(phone) {
  try {
    const normalized = phone.startsWith("+") ? phone : phone.length === 10 ? `+91${phone}` : phone;
    const waPhone = `whatsapp:${normalized}`;
    const result = await Customer.deleteOne({ $or: [{ phone }, { phone: normalized }] });
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

async function updateCustomer(phone, data) {
  try {
    const normalized = phone.startsWith("+") ? phone : phone.length === 10 ? `+91${phone}` : phone;
    const doc = await Customer.findOneAndUpdate(
      { $or: [{ phone }, { phone: normalized }] },
      { $set: { ...data, updatedAt: new Date() } },
      { returnDocument: "after", upsert: false }
    ).lean();
    return doc;
  } catch (err) {
    logger.error("Failed to update customer:", err.message);
    return null;
  }
}

async function findCustomerByPhone(phone) {
  try {
    const normalized = phone.startsWith("+") ? phone : phone.length === 10 ? `+91${phone}` : phone;
    return await Customer.findOne({ $or: [{ phone }, { phone: normalized }] }).lean();
  } catch (err) {
    return null;
  }
}

module.exports = { readAll, appendRecord, seedIfEmpty, markClicked, findByPhone, getRecentHistory, createCustomer, findCustomersToContact, markContacted, markReviewProvided, deleteCustomer, updateCustomer, findCustomerByPhone };
