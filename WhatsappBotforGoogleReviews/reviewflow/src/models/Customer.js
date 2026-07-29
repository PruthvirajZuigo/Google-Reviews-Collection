const mongoose = require("mongoose");

const customerSchema = new mongoose.Schema({
  name: { type: String, required: true },
  phone: { type: String, required: true, unique: true, index: true },
  visitDate: { type: Date, default: Date.now },
  reviewProvided: { type: Boolean, default: false },
  additionalNotes: { type: String, default: "" },
  firstContactedAt: { type: Date },
  createdAt: { type: Date, default: Date.now },
});

module.exports = mongoose.model("Customer", customerSchema);
