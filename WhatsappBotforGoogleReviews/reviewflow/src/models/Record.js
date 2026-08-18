const mongoose = require("mongoose");

const recordSchema = new mongoose.Schema({
  id: { type: String, required: true, unique: true, index: true },
  clientId: { type: String, index: true },
  phone: { type: String, index: true },
  customerName: String,
  sentiment: String,
  state: String,
  feedbackText: String,
  reviewText: String,
  triggerSource: String,
  choice: String,
  escalation: String,
  reviewClicked: { type: Boolean, default: false },
  reviewClickedAt: Date,
  clickedAt: Date,
  clickCount: { type: Number, default: 0 },
  reviewConfirm: Boolean,
  test: { type: Boolean, default: false },
  createdAt: { type: Date, default: Date.now },
});

module.exports = mongoose.model("Record", recordSchema);
