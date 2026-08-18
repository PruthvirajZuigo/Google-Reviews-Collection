require("dotenv").config();
const fs = require("fs");
const path = require("path");

let hasErrors = false;
function ok(msg) { console.log(`✅ ${msg}`); }
function fail(msg) { console.log(`❌ ${msg}`); hasErrors = true; }
function warn(msg) { console.log(`⚠️  ${msg}`); }

console.log("\n=== ReviewFlow setup verification ===\n");

// 1. Node version
const nodeVersion = process.versions.node;
const major = parseInt(nodeVersion.split(".")[0], 10);
if (major >= 18) ok(`Node.js ${nodeVersion} (>= 18 required)`);
else fail(`Node.js ${nodeVersion} — please upgrade to v18+`);

// 2. Dependencies installed
const nodeModulesPath = path.join(__dirname, "..", "node_modules");
if (fs.existsSync(nodeModulesPath)) ok("node_modules present (npm install was run)");
else fail("node_modules missing — run `npm install`");

// 3. Required env vars
const required = ["PORT", "TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_WHATSAPP_FROM", "DASHBOARD_PASSWORD"];
required.forEach((key) => {
  if (process.env[key] && !process.env[key].includes("xxx")) ok(`${key} is set`);
  else warn(`${key} is missing or still a placeholder — demo mode will use mocks instead`);
});

if (process.env.HUGGINGFACE_API_KEY && !process.env.HUGGINGFACE_API_KEY.includes("xxx")) {
  ok("HUGGINGFACE_API_KEY is set");
} else {
  warn("HUGGINGFACE_API_KEY missing — sentiment analysis will use the keyword fallback only");
}

// 4. Twilio connectivity (only if creds look real)
async function checkTwilio() {
  if (!process.env.TWILIO_ACCOUNT_SID || process.env.TWILIO_ACCOUNT_SID.includes("xxx")) {
    warn("Skipping Twilio connectivity check (no real credentials set)");
    return;
  }
  try {
    const twilio = require("twilio");
    const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
    await client.api.accounts(process.env.TWILIO_ACCOUNT_SID).fetch();
    ok("Twilio credentials are valid");
  } catch (err) {
    fail(`Twilio connectivity failed: ${err.message}`);
  }
}

// 5. Hugging Face connectivity (only if key looks real)
async function checkHuggingFace() {
  if (!process.env.HUGGINGFACE_API_KEY || process.env.HUGGINGFACE_API_KEY.includes("xxx")) {
    warn("Skipping Hugging Face connectivity check (no real key set)");
    return;
  }
  try {
    const axios = require("axios");
    await axios.post(
      `https://api-inference.huggingface.co/models/${process.env.HF_SENTIMENT_MODEL || "cardiffnlp/twitter-roberta-base-sentiment-latest"}`,
      { inputs: "test" },
      { headers: { Authorization: `Bearer ${process.env.HUGGINGFACE_API_KEY}` }, timeout: 10000 }
    );
    ok("Hugging Face API key is valid");
  } catch (err) {
    fail(`Hugging Face connectivity failed: ${err.message}`);
  }
}

(async () => {
  await checkTwilio();
  await checkHuggingFace();
  console.log("\n=== Done ===");
  if (hasErrors) {
    console.log("Some checks failed — see ❌ above. The app will still run in mock mode for anything unconfigured.\n");
    process.exit(1);
  } else {
    console.log("All good — run `npm start`.\n");
  }
})();
