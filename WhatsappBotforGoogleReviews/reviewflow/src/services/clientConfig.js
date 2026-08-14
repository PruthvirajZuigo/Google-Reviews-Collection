const Client = require("../models/Client");
const User = require("../models/User");
const Customer = require("../models/Customer");
const logger = require("./logger");

const DEFAULT_CLIENT_ID = process.env.DEFAULT_CLIENT_ID || "cli_demo";

/**
 * Seed the platform on first boot: create the default client from the existing
 * DEMO_BUSINESS_* env config (so the current single-client setup keeps working
 * exactly as before) and an admin user. Idempotent — safe to call on every start.
 */
async function ensureSeed() {
  let client = await Client.findOne({ clientId: DEFAULT_CLIENT_ID }).lean();
  if (!client) {
    client = await Client.create({
      clientId: DEFAULT_CLIENT_ID,
      name: process.env.DEMO_BUSINESS_NAME || "Sharma Cafe Pune",
      isDefault: true,
      profile: {
        googleReviewUrl:
          process.env.DEMO_GOOGLE_REVIEW_URL ||
          "https://search.google.com/local/writereview?placeid=ChIJP0warDDowokRfvXMkBqL5Cg",
        feedbackFormUrl: process.env.DEMO_FEEDBACK_FORM_URL || "",
        managerWhatsapp: process.env.DEMO_MANAGER_WHATSAPP || "",
        businessHours: process.env.DEMO_BUSINESS_HOURS || "",
        offer: process.env.DEMO_BUSINESS_OFFER || "",
      },
      features: {
        // The owner's own testing client gets Test Lab visible; real clients don't.
        testLab: String(process.env.DEMO_FEATURES_TESTLAB ?? "true") === "true",
      },
    });
    logger.info(`[CLIENT] Default client seeded: ${client.clientId} (${client.name})`);
  }

  const adminUser = await User.findOne({ role: "admin" }).lean();
  if (!adminUser) {
    const admin = new User({
      username: process.env.ADMIN_USERNAME || "admin",
      role: "admin",
      name: "Platform Admin",
    });
    admin.setPassword(process.env.ADMIN_PASSWORD || "admin123");
    await admin.save();
    logger.info(`[CLIENT] Admin user seeded (username: ${admin.username})`);
  } else if (!adminUser.passwordHash || !adminUser.passwordHash.startsWith("scrypt$")) {
    const doc = await User.findOne({ _id: adminUser._id });
    doc.setPassword(process.env.ADMIN_PASSWORD || "admin123");
    await doc.save();
    logger.info("[CLIENT] Admin user password reset (default: admin123)");
  }
  return client;
}

function normalizeClient(raw) {
  if (!raw) return null;
  return {
    clientId: raw.clientId,
    name: raw.name,
    isDefault: raw.isDefault,
    profile: {
      googleReviewUrl: raw.profile?.googleReviewUrl || "",
      feedbackFormUrl: raw.profile?.feedbackFormUrl || "",
      managerWhatsapp: raw.profile?.managerWhatsapp || "",
      businessHours: raw.profile?.businessHours || "",
      offer: raw.profile?.offer || "",
    },
    scheduler: {
      batchTime: raw.scheduler?.batchTime || "12:30",
      confirmDelayMinutes: raw.scheduler?.confirmDelayMinutes ?? 30,
      protectionDays: raw.scheduler?.protectionDays ?? 7,
    },
    features: {
      testLab: raw.features?.testLab ?? false,
      dashboard: raw.features?.dashboard ?? true,
      excelUpload: raw.features?.excelUpload ?? true,
      manualTrigger: raw.features?.manualTrigger ?? true,
      recordsHistory: raw.features?.recordsHistory ?? true,
      businessFaq: raw.features?.businessFaq ?? true,
    },
    llm: {
      provider: raw.llm?.provider || "groq",
      model: raw.llm?.model || "",
      temperature: raw.llm?.temperature ?? 0.7,
      maxTokens: raw.llm?.maxTokens ?? 300,
      dailyBudgetCalls: raw.llm?.dailyBudgetCalls ?? 50,
    },
    compliance: {
      requireOptIn: raw.compliance?.requireOptIn ?? true,
      handleStop: raw.compliance?.handleStop ?? true,
      aiMode: raw.compliance?.aiMode || "full",
      throttlePerHour: raw.compliance?.throttlePerHour ?? 0,
    },
  };
}

async function getClientById(clientId) {
  const doc = await Client.findOne({ clientId }).lean();
  return normalizeClient(doc);
}

async function getDefaultClient() {
  const doc = await Client.findOne({ isDefault: true }).lean();
  return normalizeClient(doc);
}

/**
 * Resolve which client a customer belongs to.
 * 1) explicit clientId wins, 2) else look up their Customer record, 3) else default.
 */
async function resolveClient({ clientId, phone } = {}) {
  if (clientId) {
    const byId = await getClientById(clientId);
    if (byId) return byId;
  }
  if (phone) {
    const cleaned = String(phone).replace(/^(whatsapp:|test:)/, "");
    const customer = await Customer.findOne({
      $or: [{ phone: cleaned }, { phone: phone }, { phone: `+91${cleaned}` }],
    })
      .select("clientId phone")
      .lean();
    if (customer?.clientId) {
      const byCustomer = await getClientById(customer.clientId);
      if (byCustomer) return byCustomer;
    }
  }
  return getDefaultClient();
}

async function listClients() {
  const docs = await Client.find({}).sort({ isDefault: -1, createdAt: 1 }).lean();
  return docs.map(normalizeClient);
}

async function createClient(data) {
  const clientId =
    data.clientId ||
    `cli_${Math.random().toString(36).slice(2, 10)}`;
  const existing = await Client.findOne({ clientId }).lean();
  if (existing) throw new Error(`clientId already exists: ${clientId}`);
  const doc = await Client.create({
    clientId,
    name: data.name,
    isDefault: data.isDefault || false,
    profile: data.profile || {},
    scheduler: data.scheduler || {},
    features: data.features || {},
    llm: data.llm || {},
    compliance: data.compliance || {},
  });
  logger.info(`[CLIENT] Created ${clientId} (${data.name})`);
  return normalizeClient(doc);
}

async function updateClient(clientId, patch) {
  const allowed = ["profile", "scheduler", "features", "llm", "compliance", "name"];
  const $set = {};
  for (const key of allowed) {
    if (patch[key] !== undefined) {
      if (key === "profile" || key === "scheduler" || key === "features" || key === "llm" || key === "compliance") {
        $set[key] = { ...(await Client.findOne({ clientId }).lean())[key], ...patch[key] };
      } else {
        $set[key] = patch[key];
      }
    }
  }
  const doc = await Client.findOneAndUpdate({ clientId }, { $set }, { returnDocument: "after", upsert: false }).lean();
  if (!doc) throw new Error(`Client not found: ${clientId}`);
  return normalizeClient(doc);
}

async function deleteClient(clientId) {
  const target = await Client.findOne({ clientId }).lean();
  if (!target) throw new Error(`Client not found: ${clientId}`);
  if (target.isDefault) throw new Error("Cannot delete the default client");
  await Client.deleteOne({ clientId });
  await Customer.updateMany({ clientId }, { $set: { clientId: DEFAULT_CLIENT_ID } });
  await User.updateMany({ clientId }, { $set: { clientId: DEFAULT_CLIENT_ID } });
  logger.info(`[CLIENT] Deleted ${clientId}; its customers moved to default`);
  return true;
}

/**
 * YAML template loader — a new client can be created by uploading a template.
 * See src/config/client-template.yaml. Unknown keys are ignored; missing keys
 * fall back to defaults.
 */
async function createClientFromYaml(yamlText) {
  const YAML = require("yaml");
  const data = YAML.parse(yamlText);
  if (!data || !data.name) throw new Error("Template must contain a 'name'");
  const pick = (obj, key) => (obj && obj[key] !== undefined ? obj[key] : undefined);
  return createClient({
    clientId: pick(data, "clientId"),
    name: data.name,
    profile: {
      googleReviewUrl: pick(data.profile, "googleReviewUrl"),
      feedbackFormUrl: pick(data.profile, "feedbackFormUrl"),
      managerWhatsapp: pick(data.profile, "managerWhatsapp"),
      businessHours: pick(data.profile, "businessHours"),
      offer: pick(data.profile, "offer"),
    },
    scheduler: {
      batchTime: pick(data.scheduler, "batchTime"),
      confirmDelayMinutes: pick(data.scheduler, "confirmDelayMinutes"),
      protectionDays: pick(data.scheduler, "protectionDays"),
    },
    features: {
      testLab: pick(data.features, "testLab"),
      dashboard: pick(data.features, "dashboard"),
      excelUpload: pick(data.features, "excelUpload"),
      manualTrigger: pick(data.features, "manualTrigger"),
      recordsHistory: pick(data.features, "recordsHistory"),
      businessFaq: pick(data.features, "businessFaq"),
    },
    llm: {
      provider: pick(data.llm, "provider"),
      model: pick(data.llm, "model"),
      temperature: pick(data.llm, "temperature"),
      maxTokens: pick(data.llm, "maxTokens"),
      dailyBudgetCalls: pick(data.llm, "dailyBudgetCalls"),
    },
    compliance: {
      requireOptIn: pick(data.compliance, "requireOptIn"),
      handleStop: pick(data.compliance, "handleStop"),
      aiMode: pick(data.compliance, "aiMode"),
      throttlePerHour: pick(data.compliance, "throttlePerHour"),
    },
  });
}

module.exports = {
  DEFAULT_CLIENT_ID,
  ensureSeed,
  getClientById,
  getDefaultClient,
  resolveClient,
  listClients,
  createClient,
  updateClient,
  deleteClient,
  createClientFromYaml,
  normalizeClient,
};
