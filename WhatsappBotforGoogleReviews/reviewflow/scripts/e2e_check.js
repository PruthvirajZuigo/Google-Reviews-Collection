process.env.PORT = "3201";
process.env.TWILIO_MOCK = "true";
process.env.MONGO_URI = "mongodb://localhost:27017/reviewflow_e2e";
process.env.AUTH_SECRET = "e2e-secret-123";

const BASE = "http://localhost:3201";

function qs(obj) { return new URLSearchParams(obj).toString(); }

async function call(path, { method = "GET", token, body, form } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  let payload;
  if (form) {
    headers["Content-Type"] = "application/x-www-form-urlencoded";
    payload = qs(form);
  } else if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    payload = JSON.stringify(body);
  }
  const res = await fetch(`${BASE}${path}`, { method, headers, body: payload });
  let json = null;
  try { json = await res.json(); } catch (e) {}
  return { status: res.status, json };
}

(async () => {
  require("../server.js"); // boots app + DB + scheduler on PORT 3201
  const mongo = require("mongoose");
  for (let i = 0; i < 30; i++) {
    try {
      const h = await call("/health");
      if (h.status === 200) break;
    } catch (e) {}
    await new Promise((r) => setTimeout(r, 500));
  }
  await mongo.connection.dropDatabase(); // fresh slate each run
  await require("../src/services/clientConfig").ensureSeed();
  await require("../src/services/storage").seedIfEmpty(require("../src/utils/mockData").MOCK_RECORDS);
  const results = [];
  const check = (name, ok, extra) => results.push({ name, ok, extra });

  try {
    // 1. Admin login
    let r = await call("/api/login", { method: "POST", body: { username: "admin", password: "admin123" } });
    check("admin login", r.status === 200 && r.json.token, `status=${r.status}`);
    const adminToken = r.json.token;

    // 2. Create a new client
    r = await call("/api/admin/clients", {
      method: "POST", token: adminToken,
      body: {
        name: "E2E Cafe Pune",
        profile: { googleReviewUrl: "https://search.google.com/local/writereview?placeid=E2E", managerWhatsapp: "+919999999999" },
        scheduler: { batchTime: "12:30", confirmDelayMinutes: 30, protectionDays: 7 },
        features: { testLab: true, dashboard: true, excelUpload: true, manualTrigger: true, recordsHistory: true, businessFaq: true },
        compliance: { requireOptIn: true, handleStop: true, aiMode: "full", throttlePerHour: 0 },
      },
    });
    check("admin create client", r.status === 201 && r.json.clientId, `status=${r.status} ${JSON.stringify(r.json.error || "")}`);
    const clientId = r.json.clientId;

    // 3. Create a client user
    r = await call("/api/admin/users", {
      method: "POST", token: adminToken,
      body: { username: "e2eowner", name: "E2E Owner", role: "client", clientId },
    });
    check("admin create client user", r.status === 201, `status=${r.status}`);

    // 4. Client login
    r = await call("/api/login", { method: "POST", body: { username: "e2eowner", password: "e2eowner" } });
    check("client login", r.status === 200 && r.json.user.clientId === clientId, `status=${r.status} clientId=${r.json.user && r.json.user.clientId}`);
    const clientToken = r.json.token;

    // 5. Client adds a customer
    r = await call("/api/customers", {
      method: "POST", token: clientToken,
      body: { name: "Rahul Sharma", phone: "+919876543210", optedIn: true },
    });
    check("client add customer", r.status === 201, `status=${r.status} ${JSON.stringify(r.json.error || "")}`);

    // 6. Manual trigger (mock send)
    r = await call("/api/trigger-review", {
      method: "POST", token: clientToken,
      body: { phone: "+919876543210", customerName: "Rahul Sharma", item: "Butter Chicken" },
    });
    check("trigger review (mock)", r.status === 201 && r.json.clientId === clientId, `status=${r.status} clientId=${r.json.clientId}`);

    // 7. Webhook conversation (customer replies)
    const PHONE = "whatsapp:+919876543210";
    const turns = [
      { From: PHONE, Body: "Great food and nice ambience!", MessageSid: "E2E1" },
      { From: PHONE, Body: "2", MessageSid: "E2E2" },
      { From: PHONE, Body: "1", MessageSid: "E2E3" },
      { From: PHONE, Body: "1", MessageSid: "E2E4" },
    ];
    for (const t of turns) {
      r = await call("/webhook/whatsapp", { method: "POST", form: t });
      check(`webhook turn "${t.Body}"`, r.status === 200, `status=${r.status}`);
    }

    // 8. Dashboard data as the CLIENT (their page)
    r = await call("/api/dashboard/data", { token: clientToken });
    check("client dashboard loads", r.status === 200, `status=${r.status}`);
    const dash = r.json || {};
    const completed = (dash.recent || []).filter((x) => x.state === "COMPLETED");
    const reviewShown = completed.find((x) => x.reviewText) || completed.find((x) => x.feedbackText);
    check("COMPLETED record present on client page", completed.length > 0, `completed=${completed.length}`);
    check("review text visible on client page", !!completed.find((x) => x.reviewText), `note="${(completed.find((x) => x.reviewText) || {}).reviewText || "NONE"}"`);
    check("stage = Sent to Google", !!reviewShown && reviewShown.stage === "2. Sent to Google", `stage="${reviewShown && reviewShown.stage}"`);

    // 9. Customer record: adopted, link sent, review marked provided + text saved
    r = await call("/api/customers", { token: clientToken });
    const cust = (r.json || []).find((c) => c.phone.includes("9876543210"));
    check("customer adopted under client", !!cust && cust.clientId === clientId, `clientId=${cust && cust.clientId}`);
    check("review link marked sent", !!cust && !!cust.reviewLinkSentAt, `reviewLinkSentAt=${cust && cust.reviewLinkSentAt}`);
    check("review marked provided", !!cust && cust.reviewProvided === true, `reviewProvided=${cust && cust.reviewProvided}`);
    check("review text saved on customer", !!cust && !!cust.reviewText && cust.reviewText.length > 20, `reviewText="${cust && cust.reviewText}"`);

    // 9. Data isolation: only this client's records
    const allNowShown = (dash.recent || []);
    check("all records scoped to this client", allNowShown.every((x) => x.clientId === clientId), `counts=${allNowShown.length}, ids=${[...new Set(allNowShown.map((x) => x.clientId))].join(",")}`);
    const phoneKeys = [...new Set(allNowShown.map((x) => x.phone))];
    check("records keyed by whatsapp phone", phoneKeys.length <= 2, `phones=${phoneKeys.join(",")}`);

  } catch (err) {
    check("unexpected error", false, err.message);
  }

  console.log("\n===== E2E RESULT =====");
  let pass = 0;
  for (const x of results) {
    console.log(`${x.ok ? "PASS" : "FAIL"}  ${x.name}${x.extra ? `  (${x.extra})` : ""}`);
    if (x.ok) pass++;
  }
  console.log(`\n${pass}/${results.length} passed`);

  const mongoose = require("mongoose");
  await mongoose.disconnect();
  process.exit(0);
})().catch((e) => { console.error("E2E broken:", e); process.exit(1); });