const mongoose = require("mongoose");

/**
 * A Client is one business using the platform. All business-specific values
 * live here (nothing hardcoded) — a new client = a new record. Feature flags
 * control what the client can see/use; compliance settings control messaging.
 */
const clientSchema = new mongoose.Schema({
  clientId: { type: String, required: true, unique: true, index: true },
  name: { type: String, required: true },
  isDefault: { type: Boolean, default: false },

  // Business profile
  profile: {
    googleReviewUrl: { type: String, default: "" },
    feedbackFormUrl: { type: String, default: "" },
    managerWhatsapp: { type: String, default: "" },
    businessHours: { type: String, default: "" },
    offer: { type: String, default: "" },
  },

  // Scheduling + messaging behaviour
  scheduler: {
    batchTime: { type: String, default: "12:30" }, // "HH:mm" local
    confirmDelayMinutes: { type: Number, default: 30 }, // nudge after link sent
    protectionDays: { type: Number, default: 7 }, // skip re-contacting fresh link recipients
  },

  // Which tools this client sees on their home page (admin-controlled)
  features: {
    testLab: { type: Boolean, default: false },
    dashboard: { type: Boolean, default: true },
    excelUpload: { type: Boolean, default: true },
    manualTrigger: { type: Boolean, default: true },
    recordsHistory: { type: Boolean, default: true },
    businessFaq: { type: Boolean, default: true },
  },

  // LLM settings for this client
  llm: {
    provider: { type: String, default: "groq" },
    model: { type: String, default: "" },
    temperature: { type: Number, default: 0.7 },
    maxTokens: { type: Number, default: 300 },
    dailyBudgetCalls: { type: Number, default: 50 },
  },

  // Compliance controls (config-driven)
  compliance: {
    requireOptIn: { type: Boolean, default: true },
    handleStop: { type: Boolean, default: true },
    aiMode: { type: String, default: "full" }, // "full" | "rules-only" | "rules+sentiment"
    throttlePerHour: { type: Number, default: 0 }, // 0 = no throttle
  },

  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
});

clientSchema.pre("save", function () {
  this.updatedAt = new Date();
});

module.exports = mongoose.model("Client", clientSchema);
