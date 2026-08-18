const mongoose = require("mongoose");

const customerSchema = new mongoose.Schema({
  clientId: { type: String, index: true, default: null },
  name: { type: String, required: true },
  phone: { type: String, required: true, unique: true, index: true },
  visitDate: { type: Date, default: Date.now },
  reviewProvided: { type: Boolean, default: false },
  reviewLinkSentAt: { type: Date },
  reviewText: { type: String },
  additionalNotes: { type: String, default: "" },
  firstContactedAt: { type: Date },
  optedIn: { type: Boolean, default: false },
  consentSource: { type: String, default: "" },
  consentAt: { type: Date },
  optedOut: { type: Boolean, default: false },
  optedOutAt: { type: Date },
  createdAt: { type: Date, default: Date.now },
});

module.exports = mongoose.model("Customer", customerSchema);
