const mongoose = require("mongoose");
const logger = require("../services/logger");

const MONGO_URI = process.env.MONGO_URI || "mongodb://localhost:27017/reviewflow";

async function connectDB() {
  try {
    await mongoose.connect(MONGO_URI);
    logger.info(`MongoDB connected: ${MONGO_URI}`);
  } catch (err) {
    logger.error("MongoDB connection failed:", err.message);
    process.exit(1);
  }
}

module.exports = connectDB;
