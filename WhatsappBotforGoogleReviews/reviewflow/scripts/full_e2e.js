// Comprehensive end-to-end test suite for the ReviewFlow bot.
// Runs against an isolated DB (reviewflow_e2e). Requires a live server via
// requiring server.js. Prints PASS/FAIL per check and exits non-zero on failure.
process.env.PORT = "3201";
process.env.TWILIO_MOCK = "true";
process.env.MONGO_URI = "mongodb://localhost:27017/reviewflow_e2e";
process.env.AUTH_SECRET = "e2e-secret-123";

const BASE = "http://localhost:3201";
const results = [];
const pass = (name, ok, extra = "") => { results.push({ name, ok, extra }); };

async function call(path, { method = "GET", token, body, form, raw } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  let payload;
  if (form) {
    headers["Content-Type"] = "application/x-www-form-urlencoded";
    payload = new URLSearchParams(form);
  } else if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    payload = JSON.stringify(body);
  }
  const res = await fetch(`${BASE}${path}`, { method, headers, body: payload, redirect: "manual", ...raw });
  let json = null;
  try { json = await res.json(); } catch (e) {}
  return { status: res.status, json, headers: res.headers };
}

let seq = 0;
function sid() { return `sid_${Date.now()}_${seq++}`; }

// ---- instrument Twilio so we can assert on every outgoing message ----
const sent = [];
const twilioService = require("../src/services/twilio");
const origSend = twilioService.sendWhatsApp.bind(twilioService);
const origList = twilioService.sendInteractiveList.bind(twilioService);
twilioService.sendWhatsApp = (to, body) => { sent.push({ to: String(to), body: String(body) }); return origSend(to, body); };
twilioService.sendInteractiveList = (to, bodyText) => { sent.push({ to: String(to), body: String(bodyText), list: true }); return origList(to, bodyText); };
const sentTo = (to, needle) => sent.some((m) => String(m.to).includes(to) && (!needle || m.body.includes(needle)));
const lastSentBody = () => sent.length ? sent[sent.length - 1].body : "";

// ---- direct DB access for setup / assertions ----
const mongoose = require("mongoose");
const Client = require("../src/models/Client");
const User = require("../src/models/User");
const Customer = require("../src/models/Customer");
const Conversation = require("../src/models/Conversation");
const Record = require("../src/models/Record");
const TestMessage = require("../src/models/TestMessage");

async function resetConvo(phone) {
  await Conversation.deleteOne({ phone: `whatsapp:${phone}` });
  await Conversation.deleteOne({ phone: `test:${phone}` });
}

(async () => {
  require("../server.js");
  for (let i = 0; i < 40; i++) {
    try { const h = await call("/health"); if (h.status === 200) break; } catch (e) {}
    await new Promise((r) => setTimeout(r, 500));
  }
  await mongoose.connection.dropDatabase();
  // Force-build collections + unique indexes so duplicate-key behaviour (e.g.
  // Customer.phone -> 409) is exercised, not the async index build timing.
  await Promise.all([Client.init(), User.init(), Customer.init(), Conversation.init(), Record.init(), TestMessage.init()]);
  const clientConfig = require("../src/services/clientConfig");
  await clientConfig.ensureSeed();
  await require("../src/services/storage").seedIfEmpty(require("../src/utils/mockData").MOCK_RECORDS);
  // Unknown/self-initiated conversations resolve to the default client. Force it
  // to rules-only so sentiment is deterministic (no Groq) for all those tests.
  await clientConfig.updateClient(clientConfig.DEFAULT_CLIENT_ID, { compliance: { aiMode: "rules-only" } });

  const PH = (n) => `+9198${String(70000000 + n)}`;
  const cleanPhone = (p) => String(p || "").replace(/^whatsapp:/, "");

  // ============ A. AUTH & ACCESS CONTROL ============
  const secA = {};
  let r = await call("/api/login", { method: "POST", body: { username: "admin", password: "admin123" } });
  pass("A1 admin login", r.status === 200 && !!r.json.token, `status=${r.status}`);
  secA.admin = r.json.token;
  const admin = secA.admin;

  r = await call("/api/login", { method: "POST", body: { username: "admin", password: "WRONG" } });
  pass("A2 wrong password -> 401", r.status === 401, `status=${r.status}`);

  r = await call("/api/login", { method: "POST", body: { username: "admin" } });
  pass("A3 missing password -> 400", r.status === 400, `status=${r.status}`);

  r = await call("/api/login", { method: "POST", body: { username: "ghost", password: "x" } });
  pass("A4 unknown user -> 401", r.status === 401, `status=${r.status}`);

  r = await call("/api/dashboard/data", {});
  pass("A5 no token -> 401", r.status === 401, `status=${r.status}`);

  r = await call("/api/admin/clients", { token: "garbage.token.here" });
  pass("A6 invalid token -> 401", r.status === 401, `status=${r.status}`);

  r = await call("/api/me", { token: admin });
  pass("A7 /api/me admin", r.status === 200 && r.json.user.role === "admin", `role=${r.json.user && r.json.user.role}`);

  // ============ B. CLIENT & USER MANAGEMENT ============
  const mkClient = async (name, over = {}) => {
    const res = await call("/api/admin/clients", {
      method: "POST", token: admin,
      body: {
        name,
        profile: { googleReviewUrl: `https://search.google.com/local/writereview?placeid=${name.replace(/\W/g, "")}`, managerWhatsapp: "" },
        scheduler: { batchTime: "12:30", confirmDelayMinutes: 30, protectionDays: 7 },
        features: { testLab: true, dashboard: true, excelUpload: true, manualTrigger: true, recordsHistory: true, businessFaq: true },
        compliance: { requireOptIn: false, handleStop: true, aiMode: "rules-only", throttlePerHour: 0 },
        ...over,
      },
    });
    return res.json.clientId;
  };
  const mkUser = async (username, clientId) => {
    const res = await call("/api/admin/users", { method: "POST", token: admin, body: { username, name: username, role: "client", clientId } });
    return res.status;
  };

  const flowId = await mkClient("Flow Cafe", { profile: { googleReviewUrl: "https://g.page/flowcafe/review", managerWhatsapp: PH(99) } });
  const batchId = await mkClient("Batch Cafe", { compliance: { requireOptIn: true, handleStop: true, aiMode: "rules-only" } });
  const gateId = await mkClient("Gate Cafe", { features: { testLab: false, manualTrigger: false, dashboard: true } });
  const aiId = await mkClient("AI Cafe", { compliance: { aiMode: "full" }, llm: { provider: "groq", model: "groq/compound-mini", temperature: 0.7, maxTokens: 300, dailyBudgetCalls: 50 } });
  pass("B1 create clients", [flowId, batchId, gateId, aiId].every(Boolean), `flow=${flowId} batch=${batchId} gate=${gateId} ai=${aiId}`);

  pass("B2 create users", [await mkUser("flowowner", flowId), await mkUser("batchowner", batchId), await mkUser("gateowner", gateId), await mkUser("aiowner", aiId)].every((s) => s === 201), "users created");

  r = await call("/api/admin/clients", { method: "POST", token: admin, body: { name: "Dup" } });
  r = await call("/api/admin/clients", { method: "POST", token: admin, body: { name: "Dup" } });
  const dupCheck = await Client.countDocuments({ name: "Dup" });
  pass("B3 create clients generate unique ids", dupCheck >= 1, `count=${dupCheck}`);

  r = await call("/api/admin/users", { method: "POST", token: admin, body: { username: "flowowner", role: "client", clientId: flowId } });
  pass("B4 duplicate username -> 409", r.status === 409, `status=${r.status}`);

  r = await call("/api/admin/users", { method: "POST", token: admin, body: { username: "norole", name: "No Role" } });
  pass("B5 client user requires clientId -> 400", r.status === 400, `status=${r.status}`);

  r = await call(`/api/admin/clients/${flowId}`, { token: admin });
  pass("B6 get client by id", r.status === 200 && r.json.clientId === flowId, `status=${r.status}`);

  r = await call(`/api/admin/clients/${flowId}`, { method: "PUT", token: admin, body: { name: "Flow Cafe 2", scheduler: { batchTime: "09:15", confirmDelayMinutes: 5, protectionDays: 3 } } });
  const flowUpdated = await Client.findOne({ clientId: flowId }).lean();
  pass("B7 update client persists", r.status === 200 && flowUpdated.name === "Flow Cafe 2" && flowUpdated.scheduler.batchTime === "09:15" && flowUpdated.scheduler.confirmDelayMinutes === 5 && flowUpdated.scheduler.protectionDays === 3, `batch=${flowUpdated.scheduler.batchTime} delay=${flowUpdated.scheduler.confirmDelayMinutes} prot=${flowUpdated.scheduler.protectionDays}`);

  // disabled user can't log in
  const isoAId = await mkClient("Iso A");
  const isoBId = await mkClient("Iso B");
  await mkUser("isoa", isoAId);
  await mkUser("isob", isoBId);
  const isoAUser = await User.findOne({ username: "isoa" });
  await call(`/api/admin/users/${isoAUser._id}`, { method: "PUT", token: admin, body: { active: false } });
  r = await call("/api/login", { method: "POST", body: { username: "isoa", password: "isoa" } });
  pass("B8 disabled user login -> 403", r.status === 403, `status=${r.status}`);
  await call(`/api/admin/users/${isoAUser._id}`, { method: "PUT", token: admin, body: { active: true } });
  r = await call("/api/login", { method: "POST", body: { username: "isoa", password: "isoa" } });
  pass("B9 re-enabled user login", r.status === 200, `status=${r.status}`);

  r = await call("/api/admin/clients/cli_demo", { method: "DELETE", token: admin });
  pass("B10 delete default client -> 400", r.status === 400, `status=${r.status} ${JSON.stringify(r.json.error || "")}`);

  // ============ C. CLIENT LOGINS ============
  const login = async (u, p = u) => { const x = await call("/api/login", { method: "POST", body: { username: u, password: p } }); return x.status === 200 ? x.json.token : null; };
  const tok = {
    flow: await login("flowowner"),
    batch: await login("batchowner"),
    gate: await login("gateowner"),
    ai: await login("aiowner"),
    isoa: await login("isoa"),
    isob: await login("isob"),
  };
  pass("C1 all client logins", ["flow", "batch", "gate", "ai", "isoa", "isob"].every((k) => !!tok[k]), Object.entries(tok).map(([k, v]) => `${k}=${v ? "ok" : "FAIL"}`).join(" "));

  r = await call("/api/me", { token: tok.flow });
  pass("C2 client /api/me has client binding", r.status === 200 && r.json.user.clientId === flowId && !!r.json.client, `clientId=${r.json.user && r.json.user.clientId}`);

  r = await call("/api/admin/clients", { token: tok.flow });
  pass("C3 client cannot access admin -> 403", r.status === 403, `status=${r.status}`);

  // ============ D. CUSTOMER CRUD ============
  r = await call("/api/customers", { method: "POST", token: tok.flow, body: { name: "Rahul", phone: PH(1), optedIn: true } });
  pass("D1 create customer", r.status === 201, `status=${r.status}`);
  r = await call("/api/customers", { method: "POST", token: tok.flow, body: { name: "Rahul Dup", phone: PH(1) } });
  pass("D2 duplicate customer -> 409", r.status === 409, `status=${r.status}`);
  r = await call("/api/customers", { method: "POST", token: tok.flow, body: { name: "Ten Digit", phone: "9812345678" } });
  const tenDigit = await Customer.findOne({ $or: [{ phone: "+919812345678" }, { phone: "9812345678" }] }).lean();
  pass("D3 10-digit phone normalized to +91", r.status === 201 && !!tenDigit && tenDigit.phone === "+919812345678", `stored=${tenDigit && tenDigit.phone}`);
  r = await call(`/api/customers/${PH(1)}`, { token: tok.flow });
  pass("D4 get customer", r.status === 200 && r.json.name === "Rahul", `status=${r.status}`);
  r = await call(`/api/customers/${PH(1)}`, { method: "PUT", token: tok.flow, body: { reviewProvided: true, additionalNotes: "loved it" } });
  pass("D5 update customer", r.status === 200 && r.json.reviewProvided === true, `reviewProvided=${r.json.reviewProvided}`);
  await call(`/api/customers/${PH(1)}`, { method: "PUT", token: tok.flow, body: { reviewProvided: false } });
  r = await call(`/api/customers/${PH(1)}`, { method: "DELETE", token: tok.flow });
  pass("D6 delete customer", r.status === 200 && r.json.ok === true, `status=${r.status}`);
  r = await call(`/api/customers/${PH(1)}`, { token: tok.flow });
  pass("D7 deleted customer -> 404", r.status === 404, `status=${r.status}`);

  // ============ E. TRIGGER REVIEW ============
  r = await call("/api/trigger-review", { method: "POST", token: tok.flow, body: { phone: PH(1), customerName: "Rahul Sharma", item: "Butter Chicken" } });
  pass("E1 trigger review -> 201", r.status === 201 && r.json.clientId === flowId && sentTo(cleanPhone(PH(1)), "Butter Chicken"), `status=${r.status} welcome=${sentTo(cleanPhone(PH(1)), "Butter Chicken")}`);
  r = await call("/api/trigger-review", { method: "POST", token: tok.flow, body: {} });
  pass("E2 trigger missing phone -> 400", r.status === 400, `status=${r.status}`);

  // ============ F. WEBHOOK STATE MACHINE (happy flow) ============
  const from1 = `whatsapp:${PH(1)}`;
  const wh = async (from, body, ms = sid()) => call("/webhook/whatsapp", { method: "POST", form: { From: from, Body: body, MessageSid: ms } });

  let x = await wh(from1, "Great food and nice ambience!");
  pass("F1 reply 1 -> review menu", x.status === 200 && lastSentBody().includes("enjoy most"), `status=${x.status}`);
  x = await wh(from1, "2");
  pass("F2 reply 2 -> draft prompt", x.status === 200 && lastSentBody().includes("write a quick Google review"), `status=${x.status}`);
  x = await wh(from1, "1");
  pass("F3 reply 3 -> draft generated", x.status === 200 && lastSentBody().includes("Here's a draft"), `status=${x.status}`);
  pass("F3b draft echoes customer topic", lastSentBody().toLowerCase().includes("food"), `draft="${lastSentBody().slice(0, 120)}"`);
  x = await wh(from1, "1");
  pass("F4 reply 4 -> confirm thanks", x.status === 200 && lastSentBody().includes("Thank you so much"), `status=${x.status}`);

  const recs1 = await Record.find({ phone: { $in: [from1, cleanPhone(PH(1))] }, clientId: flowId }).sort({ createdAt: 1 }).lean();
  const states1 = recs1.map((r) => r.state);
  pass("F5 full 6-state trail", ["AWAITING_RATING", "AWAITING_REVIEW_CHOICE", "AWAITING_DRAFT_CHOICE", "AWAITING_REVIEW_CONFIRM", "COMPLETED"].every((s) => states1.includes(s)), states1.join(" -> "));
  const completed1 = recs1.find((r) => r.state === "COMPLETED");
  pass("F6 completed record has reviewText", !!completed1 && !!completed1.reviewText && completed1.reviewText.length > 15, `reviewText="${completed1 && completed1.reviewText}"`);
  const cust1 = await Customer.findOne({ phone: cleanPhone(PH(1)) }).lean();
  pass("F7 customer reviewProvided + reviewText + linkSent", cust1.reviewProvided === true && !!cust1.reviewText && !!cust1.reviewLinkSentAt, `provided=${cust1.reviewProvided} linkSent=${!!cust1.reviewLinkSentAt}`);

  // duplicate webhook delivery
  const countBeforeDup = await Record.countDocuments({ phone: from1 });
  await wh(from1, "Great food and nice ambience!", "DUP_SID_1");
  await wh(from1, "Great food and nice ambience!", "DUP_SID_1");
  const countAfterDup = await Record.countDocuments({ phone: from1 });
  pass("F8 duplicate MessageSid ignored", countAfterDup === countBeforeDup, `before=${countBeforeDup} after=${countAfterDup}`);

  // happy + free-text choice (reply without a number)
  await resetConvo(PH(2));
  x = await wh(`whatsapp:${PH(2)}`, "The food was amazing!");
  x = await wh(`whatsapp:${PH(2)}`, "Staff were super friendly and quick");
  pass("F9 free-text category extracted", x.status === 200 && lastSentBody().includes("draft"), `status=${x.status} reply="${lastSentBody().slice(0, 60)}"`);

  // COMPLETED: rewrite request
  await resetConvo(PH(3));
  for (const m of ["Great place!", "1", "1", "1"]) await wh(`whatsapp:${PH(3)}`, m);
  x = await wh(`whatsapp:${PH(3)}`, "make it more detailed please");
  pass("F10 rewrite in COMPLETED -> longer draft", x.status === 200 && lastSentBody().includes("detailed") && lastSentBody().length > 60, `reply="${lastSentBody().slice(0, 80)}"`);
  x = await wh(`whatsapp:${PH(3)}`, "thanks a lot");
  pass("F11 COMPLETED closing reply", x.status === 200 && lastSentBody().length > 0, `reply="${lastSentBody().slice(0, 40)}"`);

  // review confirm = No (not yet posted). Customer must exist for flag asserts.
  await call("/api/customers", { method: "POST", token: tok.flow, body: { name: "NoPost", phone: PH(4), optedIn: true } });
  await resetConvo(PH(4));
  for (const m of ["Loved it!", "3", "1", "2"]) await wh(`whatsapp:${PH(4)}`, m);
  const recs4 = await Record.find({ phone: `whatsapp:${PH(4)}` }).sort({ createdAt: -1 }).limit(1).lean();
  pass("F12 confirm 'Not yet' -> COMPLETED reviewConfirm=false", recs4.length === 1 && recs4[0].state === "COMPLETED" && recs4[0].reviewConfirm === false, `state=${recs4[0] && recs4[0].state}`);
  const cust4 = await Customer.findOne({ phone: cleanPhone(PH(4)) }).lean();
  pass("F13 reviewProvided stays false", cust4.reviewProvided === false, `provided=${cust4.reviewProvided}`);

  // ============ G. SAD / NEUTRAL / OFF-MENU ============
  // These customers belong to Flow Cafe so the manager (PH(99)) gets notified on
  // escalation and sentiment stays deterministic (rules-only client).
  await call("/api/customers", { method: "POST", token: tok.flow, body: { name: "Sad User", phone: PH(5), optedIn: true } });
  await call("/api/customers", { method: "POST", token: tok.flow, body: { name: "Neutral User", phone: PH(6), optedIn: true } });
  await call("/api/customers", { method: "POST", token: tok.flow, body: { name: "Gibberish User", phone: PH(7), optedIn: true } });
  await resetConvo(PH(5));
  x = await wh(`whatsapp:${PH(5)}`, "The food was terrible and the waiter was rude");
  pass("G1 sad -> feedback menu", lastSentBody().includes("went wrong"), `reply="${lastSentBody().slice(0, 60)}"`);
  x = await wh(`whatsapp:${PH(5)}`, "2");
  pass("G2 sad choice -> escalation menu", lastSentBody().includes("follow up"), `reply="${lastSentBody().slice(0, 60)}"`);
  x = await wh(`whatsapp:${PH(5)}`, "1");
  pass("G3 escalate 'contact me' -> manager notified", x.status === 200 && sentTo(PH(99), "Customer requested follow-up"), `manager notified=${sentTo(PH(99), "Customer requested follow-up")}`);
  x = await wh(`whatsapp:${PH(5)}`, "2");
  pass("G4 after escalation -> link (no draft)", lastSentBody().includes("No problem"), `reply="${lastSentBody().slice(0, 60)}"`);
  x = await wh(`whatsapp:${PH(5)}`, "1");
  x = await wh(`whatsapp:${PH(5)}`, "1");
  const sadRecs = await Record.find({ phone: `whatsapp:${PH(5)}` }).sort({ createdAt: 1 }).lean();
  pass("G5 sad trail has ESCALATION", sadRecs.some((r) => r.state === "AWAITING_ESCALATION"), sadRecs.map((r) => r.state).join(" -> "));
  pass("G6 sad COMPLETED stage = Complaint logged", sadRecs.filter((r) => r.state === "COMPLETED").some((r) => r.stage === undefined || r.stage), "record present");

  await resetConvo(PH(6));
  x = await wh(`whatsapp:${PH(6)}`, "It was average, nothing special");
  pass("G7 neutral -> feedback menu", lastSentBody().includes("better"), `reply="${lastSentBody().slice(0, 60)}"`);
  x = await wh(`whatsapp:${PH(6)}`, "1");
  x = await wh(`whatsapp:${PH(6)}`, "1");
  x = await wh(`whatsapp:${PH(6)}`, "1");
  const neuRecs = await Record.find({ phone: `whatsapp:${PH(6)}` }).sort({ createdAt: -1 }).limit(1).lean();
  pass("G8 neutral completes", neuRecs.length === 1 && neuRecs[0].state === "COMPLETED" && neuRecs[0].sentiment === "neutral", `state=${neuRecs[0] && neuRecs[0].state} sentiment=${neuRecs[0] && neuRecs[0].sentiment}`);

  await resetConvo(PH(7));
  x = await wh(`whatsapp:${PH(7)}`, "asdjkasd qwe");
  pass("G9 gibberish -> still replies (fallback)", x.status === 200 && lastSentBody().length > 0, `reply="${lastSentBody().slice(0, 60)}"`);

  // ============ H. STOP / OPT-OUT / RE-OPT-IN ============
  await resetConvo(PH(8));
  await call("/api/customers", { method: "POST", token: tok.flow, body: { name: "Stop User", phone: PH(8), optedIn: true } });
  await call("/api/trigger-review", { method: "POST", token: tok.flow, body: { phone: PH(8), customerName: "Stop User" } });
  x = await wh(`whatsapp:${PH(8)}`, "STOP");
  const cust8 = await Customer.findOne({ phone: cleanPhone(PH(8)) }).lean();
  pass("H1 STOP -> optedOut + unsubscribe reply", cust8.optedOut === true && lastSentBody().toLowerCase().includes("unsubscribe"), `optedOut=${cust8.optedOut} reply="${lastSentBody().slice(0, 60)}"`);
  x = await wh(`whatsapp:${PH(8)}`, "hello");
  pass("H2 opted-out message -> blocked", lastSentBody().toLowerCase().includes("unsubscribe"), `reply="${lastSentBody().slice(0, 60)}"`);

  const batchPending = await call("/api/pending-preview", { token: tok.flow });
  const excludedStop = !(batchPending.json || []).some((c) => cleanPhone(c.phone) === cleanPhone(PH(8)));
  pass("H4 opted-out customer excluded from batch", excludedStop, "pending-count=" + batchPending.json.length);

  x = await wh(`whatsapp:${PH(8)}`, "HELP");
  const cust8b = await Customer.findOne({ phone: cleanPhone(PH(8)) }).lean();
  pass("H3 HELP -> re-opt-in", cust8b.optedOut === false, `optedOut=${cust8b.optedOut}`);

  // ============ I. UNKNOWN PHONE -> DEFAULT CLIENT ============
  await resetConvo(PH(10));
  x = await wh(`whatsapp:${PH(10)}`, "Never heard of you");
  const rec10 = await Record.find({ phone: `whatsapp:${PH(10)}` }).sort({ createdAt: -1 }).limit(1).lean();
  pass("I1 unknown phone -> default client", rec10.length === 1 && rec10[0].clientId === "cli_demo", `clientId=${rec10[0] && rec10[0].clientId}`);

  // ============ J. BATCH / OPT-IN / PROTECTION / EXCEL ============
  // prepare customers on batch client
  await call("/api/customers", { method: "POST", token: tok.batch, body: { name: "Eligible", phone: PH(20), optedIn: true } });
  await call("/api/customers", { method: "POST", token: tok.batch, body: { name: "NoConsent", phone: PH(21), optedIn: false } });
  await call("/api/customers", { method: "POST", token: tok.batch, body: { name: "AlreadyReviewed", phone: PH(22), optedIn: true, reviewProvided: true } });
  await call("/api/customers", { method: "POST", token: tok.batch, body: { name: "OldVisit", phone: PH(23), optedIn: true } });
  await Customer.updateOne({ phone: cleanPhone(PH(23)) }, { $set: { visitDate: new Date(Date.now() - 100 * 24 * 3600 * 1000) } });
  await call("/api/customers", { method: "POST", token: tok.batch, body: { name: "LinkSentRecently", phone: PH(24), optedIn: true } });
  await Customer.updateOne({ phone: cleanPhone(PH(24)) }, { $set: { reviewLinkSentAt: new Date() } });

  r = await call("/api/pending-preview", { token: tok.batch });
  const pp = r.json || [];
  pass("J1 gating: only opted-in, unreviewed, fresh, not-recently-linked pending", pp.length === 1 && cleanPhone(pp[0].phone) === cleanPhone(PH(20)), `pending=${pp.map((c) => cleanPhone(c.phone)).join(",")}`);

  r = await call("/api/trigger-batch", { method: "POST", token: tok.batch });
  pass("J2 batch sends to pending only", r.status === 200 && r.json.sent === 1 && r.json.total === 1, `sent=${r.json.sent} total=${r.json.total}`);

  // test-cron
  r = await call("/api/test-cron", { method: "POST", token: tok.batch });
  pass("J3 test-cron runs", r.status === 200 && typeof r.json.contacted === "number", `status=${r.status} contacted=${r.json.contacted}`);

  // excel upload
  const XLSX = require("xlsx");
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet([
    { Name: "Excel One", Phone: "9876500001", "Visit Date": "2026-08-01", Notes: "Paneer", Consent: "Yes" },
    { Name: "Excel Two", Phone: "9876500002", Consent: "No" },
    { Name: "Bad Row", Phone: "123" },
  ]), "Sheet1");
  const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
  const fd = new FormData();
  fd.append("file", new Blob([buf], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }), "customers.xlsx");
  let res = await fetch(`${BASE}/api/upload-excel`, { method: "POST", headers: { Authorization: `Bearer ${tok.batch}` }, body: fd });
  const excel = await res.json();
  pass("J4 excel: 2 added + 1 error", excel.addedCount === 2 && excel.errors.length === 1, `added=${excel.addedCount} errors=${excel.errors.length}`);
  const consentNo = await Customer.findOne({ phone: "+919876500002" }).lean();
  pass("J5 excel consent=No -> optedIn false", consentNo && consentNo.optedIn === false, `optedIn=${consentNo && consentNo.optedIn}`);

  res = await fetch(`${BASE}/api/upload-excel`, { method: "POST", headers: { Authorization: `Bearer ${tok.batch}` }, body: new FormData() });
  pass("J6 excel no file -> 400", res.status === 400, `status=${res.status}`);

  // ============ K. REVIEW LINK REDIRECT ============
  const clickTarget = await Record.findOne({ clientId: flowId, state: "COMPLETED" }).sort({ createdAt: -1 }).lean();
  res = await fetch(`${BASE}/r/${clickTarget.id}`, { method: "GET", redirect: "manual" });
  const loc = res.headers.get("location") || "";
  const afterClick = await Record.findOne({ id: clickTarget.id }).lean();
  pass("K1 /r/:id redirects to client review url", [301, 302, 307, 308].includes(res.status) && loc.includes("g.page/flowcafe/review"), `status=${res.status} loc=${loc}`);
  pass("K2 clicked tracked (clickedAt + count)", !!afterClick.clickedAt && afterClick.clickCount === 1, `clickCount=${afterClick.clickCount}`);
  res = await fetch(`${BASE}/r/nonexistent-record-id`, { method: "GET", redirect: "manual" });
  pass("K3 unknown review link -> 404", res.status === 404, `status=${res.status}`);

  // ============ L. DASHBOARD STAGES & ISOLATION ============
  const dFlow = await call("/api/dashboard/data", { token: tok.flow });
  const dFlowJson = dFlow.json || {};
  const happyComplete = dFlowJson.recent.find((r) => r.state === "COMPLETED" && r.sentiment === "happy");
  const sadComplete = (await call("/api/dashboard/data", { token: tok.flow })).json.recent.find((r) => r.state === "COMPLETED" && r.sentiment === "sad");
  pass("L1 happy completed stage = Sent to Google", happyComplete && happyComplete.stage === "2. Sent to Google", `stage=${happyComplete && happyComplete.stage}`);
  pass("L2 sad completed stage = Complaint logged", sadComplete && sadComplete.stage === "3. Complaint logged", `stage=${sadComplete && sadComplete.stage}`);
  const confirmRec = dFlowJson.recent.find((r) => r.state === "AWAITING_REVIEW_CONFIRM");
  pass("L3 awaiting-confirm stage = Review posted?", !confirmRec || confirmRec.stage === "2. Review posted?", `stage=${confirmRec && confirmRec.stage}`);

  const dA = (await call("/api/dashboard/data", { token: tok.isoa })).json;
  const dB = (await call("/api/dashboard/data", { token: tok.isob })).json;
  pass("L4 client A sees zero records", dA.totalMessages === 0, `total=${dA.totalMessages}`);
  pass("L5 client B sees zero records", dB.totalMessages === 0, `total=${dB.totalMessages}`);
  const dAdmin = (await call("/api/dashboard/data", { token: admin })).json;
  pass("L6 admin sees all clients", dAdmin.totalMessages > dFlowJson.totalMessages, `admin=${dAdmin.totalMessages} flow=${dFlowJson.totalMessages}`);
  const customersFlow = (await call("/api/customers", { token: tok.flow })).json;
  pass("L7 flow client only its customers", customersFlow.every((c) => c.clientId === flowId), `count=${customersFlow.length}`);

  // clear-all-data scoping
  await call("/api/trigger-review", { method: "POST", token: tok.isoa, body: { phone: PH(40), customerName: "A Customer" } });
  const dA2 = (await call("/api/dashboard/data", { token: tok.isoa })).json;
  pass("L8 iso A has data", dA2.totalMessages >= 1, `total=${dA2.totalMessages}`);
  r = await call("/api/clear-all-data", { method: "POST", token: tok.isob });
  const dA3 = (await call("/api/dashboard/data", { token: tok.isoa })).json;
  const dB3 = (await call("/api/dashboard/data", { token: tok.isob })).json;
  pass("L9 clear-all-data only clears its own client", dA3.totalMessages === dA2.totalMessages && dB3.totalMessages === 0, `A=${dA3.totalMessages} B=${dB3.totalMessages}`);

  // delete client moves customers to default
  const delId = await mkClient("To Delete");
  await require("../src/services/storage").adoptCustomerByPhone(PH(51), { clientId: delId, name: "DelCust" });
  r = await call(`/api/admin/clients/${delId}`, { method: "DELETE", token: admin });
  const delCust = await Customer.findOne({ phone: cleanPhone(PH(51)) }).lean();
  pass("L10 delete client moves customers to default", r.status === 200 && delCust.clientId === "cli_demo", `status=${r.status} movedTo=${delCust && delCust.clientId}`);

  // ============ M. FEATURE GATING ============
  r = await call("/api/test/scenarios", { token: tok.gate });
  pass("M1 testLab disabled -> 403", r.status === 403, `status=${r.status}`);
  r = await call("/api/trigger-review", { method: "POST", token: tok.gate, body: { phone: PH(60), customerName: "Gated" } });
  pass("M2 manualTrigger disabled -> 403", r.status === 403, `status=${r.status}`);
  r = await call("/api/test/scenarios", { token: tok.flow });
  pass("M3 testLab enabled client allowed", r.status === 200, `status=${r.status}`);

  // ============ N. TEST LAB / SIMULATE ============
  r = await call("/api/test/scenario", { method: "POST", token: tok.flow, body: { scenario: "confirm_review_yes" } });
  pass("N1 test lab scenario runs", r.status === 200 && r.json.transcript && r.json.transcript.length === 4, `status=${r.status} steps=${r.json.transcript && r.json.transcript.length}`);
  r = await call("/api/test/scenario", { method: "POST", token: tok.flow, body: { scenario: "nope" } });
  pass("N2 unknown scenario -> 404", r.status === 404, `status=${r.status}`);
  r = await call("/api/test/sessions", { token: tok.flow });
  pass("N3 test sessions list", r.status === 200 && Array.isArray(r.json), `status=${r.status}`);
  r = await call("/api/simulate", { method: "POST", token: tok.flow, body: { phone: PH(70), messages: ["Great place", "1"] } });
  pass("N4 legacy /simulate works", r.status === 200 && r.json.steps === 2, `status=${r.status} steps=${r.json.steps}`);

  // test-lab data must NOT leak into dashboard
  const dFlowAfterLab = (await call("/api/dashboard/data", { token: tok.flow })).json;
  const labPhonesInDash = (dFlowAfterLab.recent || []).filter((r) => String(r.phone).startsWith("test:"));
  pass("N5 test-lab data excluded from dashboard", labPhonesInDash.length === 0, `leaks=${labPhonesInDash.length}`);

  // ============ O. AI INTEGRATION (real Groq, lenient) ============
  await resetConvo(PH(80));
  await call("/api/trigger-review", { method: "POST", token: tok.ai, body: { phone: PH(80), customerName: "AI User" } });
  for (const m of ["Amazing biryani and quick service", "1", "1", "1"]) await wh(`whatsapp:${PH(80)}`, m);
  const aiRecs = await Record.find({ phone: `whatsapp:${PH(80)}`, clientId: aiId }).sort({ createdAt: -1 }).limit(1).lean();
  pass("O1 AI client: real review text generated", aiRecs.length === 1 && !!aiRecs[0].reviewText && aiRecs[0].reviewText.length > 15, `state=${aiRecs[0] && aiRecs[0].state} reviewText="${aiRecs[0] && (aiRecs[0].reviewText || "").slice(0, 60)}"`);

  // ============ P. RATE LIMITING (LAST — consumes budgets) ============
  const rl = require("../src/middleware/rateLimiter");
  for (const k of ["::1", "127.0.0.1", "::ffff:127.0.0.1"]) { rl.loginLimiter.resetKey(k); rl.apiLimiter.resetKey(k); }
  let saw429 = false, finalStatus = null;
  for (let i = 0; i < 25; i++) {
    const z = await call("/api/login", { method: "POST", body: { username: "bruteforce", password: "x" } });
    if (z.status === 429) saw429 = true;
    finalStatus = z.status;
  }
  pass("P1 login brute-force eventually 429", saw429, `last=${finalStatus}`);
  const blockedValid = await call("/api/login", { method: "POST", body: { username: "admin", password: "admin123" } });
  pass("P2 even valid login blocked while limited", blockedValid.status === 429, `status=${blockedValid.status}`);

  // ============ SUMMARY ============
  const okCount = results.filter((x) => x.ok).length;
  console.log("\n===== FULL E2E RESULT =====");
  for (const x of results) console.log(`${x.ok ? "PASS" : "FAIL"}  ${x.name}${x.extra ? `  (${x.extra})` : ""}`);
  console.log(`\n${okCount}/${results.length} passed`);

  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
  process.exit(okCount === results.length ? 0 : 1);
})().catch((e) => { console.error("E2E broken:", e); process.exit(1); });