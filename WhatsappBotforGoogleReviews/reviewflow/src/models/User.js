const mongoose = require("mongoose");
const auth = require("../services/auth");

/**
 * A User is a person who can log in: an admin (sees everything, manages
 * clients) or a client-scoped user (only their own business).
 */
const userSchema = new mongoose.Schema({
  username: { type: String, required: true, unique: true, index: true },
  passwordHash: { type: String, default: "" },
  role: { type: String, enum: ["admin", "client"], default: "client" },
  name: { type: String, default: "" },
  clientId: { type: String, index: true }, // null/empty for admins
  active: { type: Boolean, default: true },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
});

userSchema.pre("save", function () {
  this.updatedAt = new Date();
});

userSchema.methods.setPassword = function (password) {
  this.passwordHash = auth.hashPassword(password);
};

module.exports = mongoose.model("User", userSchema);
