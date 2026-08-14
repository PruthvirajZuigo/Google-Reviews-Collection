const mongoose = require("mongoose");

const testMessageSchema = new mongoose.Schema({
  phone: { type: String, index: true },
  role: { type: String, enum: ["customer", "bot"], required: true },
  text: { type: String, required: true },
  interactive: { type: Boolean, default: false },
  state: String,
  createdAt: { type: Date, default: Date.now },
});

module.exports = mongoose.model("TestMessage", testMessageSchema);
