const fs = require("fs");
const path = require("path");
const logger = require("./logger");

const BUDGET_FILE = path.join(__dirname, "..", "..", "data", "ai-usage.json");
const MAX_PER_DAY = Number(process.env.MAX_AI_CALLS_PER_DAY) || 50;

function todayKey() {
  return new Date().toISOString().slice(0, 10); // "2026-07-23"
}

function readUsage() {
  try {
    const raw = JSON.parse(fs.readFileSync(BUDGET_FILE, "utf8"));
    if (raw.date !== todayKey()) return { date: todayKey(), count: 0 }; // new day, reset
    return raw;
  } catch {
    return { date: todayKey(), count: 0 };
  }
}

function writeUsage(usage) {
  fs.writeFileSync(BUDGET_FILE, JSON.stringify(usage), "utf8");
}

/** Call before every real AI request. Returns false once today's cap is hit. */
function canUseAI() {
  const usage = readUsage();
  return usage.count < MAX_PER_DAY;
}

/** Call only after a real AI request actually goes out. */
function recordUse() {
  const usage = readUsage();
  usage.count += 1;
  writeUsage(usage);
  if (usage.count === MAX_PER_DAY) {
    logger.info(`[AI BUDGET] Daily cap of ${MAX_PER_DAY} reached — falling back to local sentiment/templates for the rest of today.`);
  }
}

function remainingToday() {
  return MAX_PER_DAY - readUsage().count;
}

module.exports = { canUseAI, recordUse, remainingToday };