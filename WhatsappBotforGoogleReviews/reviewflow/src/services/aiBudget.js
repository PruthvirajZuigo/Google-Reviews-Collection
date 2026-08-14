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
    if (raw.date !== todayKey()) {
      return { date: todayKey(), clients: {}, global: 0 };
    }
    return { clients: raw.clients || {}, global: raw.global || 0, ...raw };
  } catch {
    return { date: todayKey(), clients: {}, global: 0 };
  }
}

function writeUsage(usage) {
  fs.writeFileSync(BUDGET_FILE, JSON.stringify(usage), "utf8");
}

/**
 * Per-client daily AI budget. Falls back to the global cap when no client is
 * provided (legacy callers). The per-client cap comes from Client.llm.dailyBudgetCalls.
 */
function capFor(client) {
  if (client && Number.isFinite(client.llm?.dailyBudgetCalls) && client.llm.dailyBudgetCalls > 0) {
    return client.llm.dailyBudgetCalls;
  }
  return MAX_PER_DAY;
}

/** Call before every real AI request. Returns false once today's cap is hit. */
function canUseAI(client) {
  const usage = readUsage();
  const cap = capFor(client);
  if (client && client.clientId) {
    return (usage.clients[client.clientId] || 0) < cap;
  }
  return usage.global < cap;
}

/** Call only after a real AI request actually goes out. */
function recordUse(client) {
  const usage = readUsage();
  const cap = capFor(client);
  if (client && client.clientId) {
    usage.clients[client.clientId] = (usage.clients[client.clientId] || 0) + 1;
    if (usage.clients[client.clientId] === cap) {
      logger.info(`[AI BUDGET] Daily cap of ${cap} reached for client ${client.clientId} — falling back to local sentiment/templates for the rest of today.`);
    }
  } else {
    usage.global += 1;
    if (usage.global === cap) {
      logger.info(`[AI BUDGET] Daily cap of ${cap} reached — falling back to local sentiment/templates for the rest of today.`);
    }
  }
  writeUsage(usage);
}

function remainingToday(client) {
  const usage = readUsage();
  const cap = capFor(client);
  if (client && client.clientId) return cap - (usage.clients[client.clientId] || 0);
  return cap - usage.global;
}

module.exports = { canUseAI, recordUse, remainingToday };
