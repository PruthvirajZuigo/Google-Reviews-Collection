const mongoose = require("mongoose");

const conversationSchema = new mongoose.Schema({
  phone: { type: String, required: true, unique: true, index: true },
  clientId: { type: String, index: true },
  state: { type: String, default: "INIT" },
  customerName: { type: String, default: "Customer" },
  sentiment: { type: String },
  choice: { type: String },
  escalation: { type: String },
  draft: { type: String },
  originalFeedback: { type: String },
  lastMessageSid: { type: String },
  item: { type: String },
  expiresAt: { type: Date },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
});

conversationSchema.pre("save", function () {
  this.updatedAt = new Date();
});

module.exports = mongoose.model("Conversation", conversationSchema);
