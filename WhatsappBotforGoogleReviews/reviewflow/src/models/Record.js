const mongoose = require("mongoose");

const recordSchema = new mongoose.Schema({
  id: { type: String, required: true, unique: true, index: true },
  phone: { type: String, index: true },
  customerName: String,
  sentiment: String,
  state: String,
  feedbackText: String,
  triggerSource: String,
  choice: String,
  escalation: String,
  reviewClicked: { type: Boolean, default: false },
  reviewClickedAt: Date,
  clickCount: { type: Number, default: 0 },
  createdAt: { type: Date, default: Date.now },
});

module.exports = mongoose.model("Record", recordSchema);
