/**
 * NOTE ON NAMING: the original spec listed this as "sheets.js" (Google
 * Sheets API). Since the confirmed choice was "standalone demo, JSON
 * file, no MongoDB," this is a plain JSON-file store instead — same
 * role (persistent log for the dashboard), different backing store.
 * Swap this file's internals for the Sheets API later without touching
 * any of its callers, since they only use the functions below.
 */
const fs = require("fs");
const path = require("path");
const logger = require("./logger");

const DATA_DIR = path.join(__dirname, "..", "..", "data");
const DATA_FILE = path.join(DATA_DIR, "conversations.json");

function ensureFile() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DATA_FILE)) fs.writeFileSync(DATA_FILE, "[]", "utf8");
}

function readAll() {
  ensureFile();
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
  } catch (err) {
    logger.error("Failed to read data file, resetting:", err.message);
    fs.writeFileSync(DATA_FILE, "[]", "utf8");
    return [];
  }
}

function writeAll(records) {
  ensureFile();
  fs.writeFileSync(DATA_FILE, JSON.stringify(records, null, 2), "utf8");
}

function appendRecord(record) {
  const records = readAll();
  records.push({ id: `rec_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`, createdAt: new Date().toISOString(), ...record });
  writeAll(records);
  return record;
}

function seedIfEmpty(mockRecords) {
  const existing = readAll();
  if (existing.length === 0) {
    writeAll(mockRecords);
    logger.info(`Seeded ${mockRecords.length} mock records into ${DATA_FILE}`);
  }
}

function markClicked(id) {
  const records = readAll();

  const index = records.findIndex((r) => r.id === id);

  if (index === -1) return null;

  records[index].clickedAt = new Date().toISOString();
  records[index].clickCount = (records[index].clickCount || 0) + 1;

  writeAll(records);

  return records[index];
}


module.exports = { readAll, writeAll, appendRecord, seedIfEmpty, markClicked };
