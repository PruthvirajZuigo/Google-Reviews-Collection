// === Shared helpers (top-level so every listener block can use them) ===
const toastContainer = document.createElement("div");
toastContainer.id = "toastContainer";
document.body.appendChild(toastContainer);

// === Active client state (loaded from the admin panel client list) ===
let CURRENT_CLIENT = { clientId: "", name: "", features: {} };
const CLIENT_MAP = {}; // clientId -> { name, features } (populated for admins)
let selectionSeq = 0; // guards against stale async updates

function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function clientQ() {
  return CURRENT_CLIENT.clientId ? `?clientId=${encodeURIComponent(CURRENT_CLIENT.clientId)}` : "";
}

async function loadClientSelector() {
  const me = ReviewAuth.getMe();
  const isClientUser = me && me.role === "client";
  const adminLink = document.getElementById("adminLink");
  if (adminLink && isClientUser) adminLink.style.display = "none";

  if (isClientUser) {
    // Client users are locked to their own business — no selector.
    const sel = document.getElementById("clientSelector");
    if (sel) {
      sel.parentElement.style.display = "none";
    }
    if (me.client) {
      CLIENT_MAP[me.clientId] = { name: me.client.name, features: me.client.features || {} };
    }
    applyClientSelection(me.clientId || "");
    return;
  }

  try {
    const res = await fetchJSON("/api/admin/clients");
    const clients = await res.json();
    const sel = document.getElementById("clientSelector");
    if (!sel) return;
    sel.innerHTML = '<option value="">All clients</option>' +
      clients.map((c) => `<option value="${c.clientId}">${c.name}</option>`).join("");
    clients.forEach((c) => { CLIENT_MAP[c.clientId] = { name: c.name, features: c.features || {} }; });
    const stored = sessionStorage.getItem("rfClientId") || "";
    if (stored && clients.some((c) => c.clientId === stored)) sel.value = stored;
    applyClientSelection(sel.value);
    sel.addEventListener("change", () => applyClientSelection(sel.value));
  } catch (err) {
    console.error("loadClientSelector:", err);
    // Fallback: still load the dashboard (all clients) if the client list fails.
    applyClientSelection("");
  }
}

function applyClientSelection(clientId) {
  const seq = ++selectionSeq;
  CURRENT_CLIENT = { clientId, name: "", features: {} };
  sessionStorage.setItem("rfClientId", clientId || "");
  const banner = document.getElementById("clientBanner");
  if (banner) {
    if (clientId) {
      banner.classList.remove("hidden");
      const info = CLIENT_MAP[clientId];
      if (info) {
        // Synchronous — no race, always matches what the dropdown shows.
        CURRENT_CLIENT.name = info.name;
        CURRENT_CLIENT.features = info.features || {};
        document.getElementById("clientBannerName").textContent = info.name;
        applyFeatureGating();
      } else if (ReviewAuth.isAdmin()) {
        // Fallback lookup (rare) — guarded so a stale response can't win.
        document.getElementById("clientBannerName").textContent = clientId;
        fetchJSON(`/api/admin/clients/${encodeURIComponent(clientId)}`).then((res) => res.json()).then((c) => {
          if (seq !== selectionSeq) return;
          CLIENT_MAP[clientId] = { name: c.name, features: c.features || {} };
          CURRENT_CLIENT.name = c.name;
          CURRENT_CLIENT.features = c.features || {};
          document.getElementById("clientBannerName").textContent = c.name;
          applyFeatureGating();
        }).catch(() => {});
      } else {
        document.getElementById("clientBannerName").textContent = CURRENT_CLIENT.name || clientId;
        applyFeatureGating();
      }
    } else {
      banner.classList.add("hidden");
      applyFeatureGating();
    }
  }
  // Data loading lives inside the DOMContentLoaded closure (loadDashboard /
  // loadCustomers are not in scope here), so signal the page to reload data
  // instead of calling them directly. Fires on boot and on every client switch.
  document.dispatchEvent(new CustomEvent("reviewflow:clientChanged"));
}

function applyFeatureGating() {
  const me = ReviewAuth.getMe();
  const isClientUser = me && me.role === "client";
  const f = CURRENT_CLIENT.features || {};

  // Client-role accounts see a feature only when its flag isn't off.
  // Admins always see everything (they preview/manage all clients).
  const show = (flag) => !isClientUser || flag !== false;
  const setVisible = (el, visible) => { if (el) el.style.display = visible ? "" : "none"; };

  // Overview tab = the "Dashboard" flag (stats + sentiment chart + recent).
  setVisible(document.getElementById("tabBtnOverview"), show(f.dashboard));
  setVisible(document.querySelector('#dashboardMain .tab-panel[data-panel="overview"]'), show(f.dashboard));

  // Records history panel lives inside Overview.
  setVisible(document.getElementById("panelRecent"), show(f.recordsHistory));

  // Send tab: Manual + Batch are the "Manual trigger" feature; Excel is separate.
  setVisible(document.getElementById("panelManual"), show(f.manualTrigger));
  setVisible(document.getElementById("panelBatch"), show(f.manualTrigger));
  setVisible(document.getElementById("panelExcel"), show(f.excelUpload));

  // Test Lab: always visible to admins (so the layout never jumps when switching
  // clients); for client-role accounts only when that business has the flag on.
  const testLabAllowed = !isClientUser || f.testLab === true;
  setVisible(document.getElementById("panelTestLab"), testLabAllowed);
  setVisible(document.getElementById("tabBtnTestLab"), testLabAllowed);

  // If gating hid the currently active tab, switch to the first visible one so
  // the client never lands on an empty screen.
  const tabBtns = document.querySelectorAll("#mainTabs .tab-btn");
  const activeBtn = document.querySelector("#mainTabs .tab-btn.active");
  if (activeBtn && activeBtn.style.display === "none") {
    const firstVisible = Array.from(tabBtns).find((b) => b.style.display !== "none");
    if (firstVisible) firstVisible.click();
  }
}

function toast(message, type = "success") {
  const el = document.createElement("div");
  el.className = `toast toast-${type}`;
  const icons = { success: "✅", error: "❌", info: "ℹ️" };
  el.innerHTML = `${icons[type] || "ℹ️"} ${message}`;
  el.onclick = () => removeToast(el);
  toastContainer.appendChild(el);
  setTimeout(() => removeToast(el), 4000);
}

function removeToast(el) {
  if (el.classList.contains("toast-removing")) return;
  el.classList.add("toast-removing");
  setTimeout(() => el.remove(), 200);
}

// === Confirm modal ===
function confirmModal(message) {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "modal-overlay";
    overlay.innerHTML = `
      <div class="modal-box">
        <h3>⚠️ Confirm</h3>
        <p>${message}</p>
        <div class="modal-actions">
          <button class="btn btn-secondary" id="modalCancel">Cancel</button>
          <button class="btn btn-danger" id="modalConfirm">Delete</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    overlay.querySelector("#modalCancel").onclick = () => { overlay.remove(); resolve(false); };
    overlay.querySelector("#modalConfirm").onclick = () => { overlay.remove(); resolve(true); };
    overlay.onclick = (e) => { if (e.target === overlay) { overlay.remove(); resolve(false); } };
  });
}

// === Fetch with timeout (authenticated) ===
async function fetchJSON(url, options, timeoutMs = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await ReviewAuth.apiFetch(url, { ...options, signal: controller.signal });
    clearTimeout(timer);
    if (res.status === 401 && !(url === "/api/login")) {
      ReviewAuth.clearToken();
      ReviewAuth.showLogin();
      throw new Error("Please sign in to continue");
    }
    return res;
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

// === Loading spinner ===
function setLoading(btn, loading) {
  if (!btn.dataset.originalText) btn.dataset.originalText = btn.textContent.trim();
  btn.disabled = loading;
  btn.innerHTML = loading ? `<span class="spinner"></span> Processing...` : btn.dataset.originalText;
  if (loading) {
    // Safety: auto-recover after 30s
    setTimeout(() => { if (btn.disabled) { btn.disabled = false; btn.innerHTML = btn.dataset.originalText; } }, 30000);
  }
}

document.addEventListener("DOMContentLoaded", () => {
  let chartInstance = null;
  let editingPhone = null;

  // === Auth gate: every dashboard user must sign in first ===
  async function initAuth() {
    const user = await ReviewAuth.checkAuth();
    if (!user) {
      ReviewAuth.showLogin(() => {
        ReviewAuth.renderAuthUI();
        loadClientSelector();
      });
      return;
    }
    ReviewAuth.renderAuthUI();
    loadClientSelector();
  }

  // === Method 1: Manual single customer ===
  document.getElementById("manualBtn").addEventListener("click", async () => {
    const name = document.getElementById("manualName").value.trim();
    const phone = document.getElementById("manualPhone").value.trim();
    const item = document.getElementById("manualItem").value.trim();
    const btn = document.getElementById("manualBtn");
    if (!name || !phone) { toast("Name and phone are required", "error"); return; }
    setLoading(btn, true);
    try {
      const res = await fetchJSON("/api/trigger-review", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone, customerName: name, item: item || undefined, clientId: CURRENT_CLIENT.clientId || undefined }),
      });
      const data = await res.json();
      if (!res.ok) { toast(data.error || "Failed", "error"); return; }
      toast(`Welcome sent to ${name} (${phone})`);
      document.getElementById("manualName").value = "";
      document.getElementById("manualPhone").value = "";
      document.getElementById("manualItem").value = "";
      loadDashboard();
    } catch (err) { toast("Error: " + err.message, "error"); }
    finally { setLoading(btn, false); }
  });

  // === Method 2: Database batch send ===
  document.getElementById("batchBtn").addEventListener("click", async () => {
    const btn = document.getElementById("batchBtn");
    setLoading(btn, true);
    try {
      const res = await fetchJSON("/api/trigger-batch", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ clientId: CURRENT_CLIENT.clientId || undefined }) }, 60000);
      const data = await res.json();
      const failed = data.failed ? `, ${data.failed} failed` : "";
      toast(`Sent to ${data.sent} of ${data.total} pending customers${failed}`);
      loadDashboard();
    } catch (err) { toast("Error: " + err.message, "error"); }
    finally { setLoading(btn, false); }
  });

  document.getElementById("batchPreviewBtn").addEventListener("click", async () => {
    const previewEl = document.getElementById("batchPreview");
    previewEl.classList.remove("hidden");
    previewEl.innerHTML = '<span class="spinner"></span> Loading...';
    try {
      const res = await fetchJSON(`/api/pending-preview${clientQ()}`);
      const pending = await res.json();
      previewEl.innerHTML = pending.length === 0
        ? '<span style="color:var(--ink-soft)">No pending customers — all have been messaged or left a review.</span>'
        : `<strong>${pending.length} customer(s) will be contacted:</strong>
           <div class="table-wrap" style="max-height:200px">
           <table><thead><tr><th>Name</th><th>Phone</th><th>Visited</th></tr></thead>
           <tbody>${pending.map(c => `<tr><td>${c.name}</td><td>${c.phone}</td><td>${new Date(c.visitDate).toLocaleDateString()}</td></tr>`).join("")}
           </tbody></table></div>`;
    } catch (err) { previewEl.innerHTML = `<span style="color:var(--red)">Error: ${err.message}</span>`; }
  });

  // === Method 3: Excel upload ===
  document.getElementById("excelBtn").addEventListener("click", async () => {
    const fileInput = document.getElementById("excelFile");
    const btn = document.getElementById("excelBtn");
    if (!fileInput.files.length) { toast("Please select a file", "error"); return; }
    setLoading(btn, true);
    const formData = new FormData();
    formData.append("file", fileInput.files[0]);
    if (CURRENT_CLIENT.clientId) formData.append("clientId", CURRENT_CLIENT.clientId);
    try {
      const res = await fetchJSON("/api/upload-excel", { method: "POST", body: formData }, 30000);
      const data = await res.json();
      let msg = `Processed ${data.totalRows} rows. Added: ${data.addedCount}, Skipped: ${data.skippedCount}`;
      if (data.errors.length) msg += `. Errors: ${data.errors.length}`;
      toast(msg);
      fileInput.value = "";
      loadDashboard();
    } catch (err) { toast("Error: " + err.message, "error"); }
    finally { setLoading(btn, false); }
  });

  // === Dashboard data ===
  // Reload dashboard + customers whenever the active client changes (or on
  // first boot). Dispatched by applyClientSelection.
  document.addEventListener("reviewflow:clientChanged", () => {
    loadDashboard();
    loadCustomers();
  });

  async function loadDashboard() {
    const seq = selectionSeq;
    try {
      const res = await fetchJSON(`/api/dashboard/data${clientQ()}`);
      if (!res.ok) return;
      const data = await res.json();
      if (seq !== selectionSeq) return; // a newer client selection happened
      renderStats(data);
      renderChart(data);
      renderTable(data.recent);
    } catch (err) { console.error(err); }
  }

  function renderStats(data) {
    document.getElementById("statTotal").textContent = data.totalMessages;
    document.getElementById("statHappy").textContent = data.happy;
    document.getElementById("statNeutral").textContent = data.neutral;
    document.getElementById("statSad").textContent = data.sad;
  }

  function renderChart(data) {
    const ctx = document.getElementById("sentimentChart");
    const chartData = [data.happy, data.neutral, data.sad];
    if (chartInstance) {
      // Update in place — avoids the flash from destroy()+recreate on every reload.
      chartInstance.data.datasets[0].data = chartData;
      chartInstance.update();
      return;
    }
    chartInstance = new Chart(ctx, {
      type: "doughnut",
      data: {
        labels: ["Happy", "Neutral", "Sad"],
        datasets: [{ data: chartData, backgroundColor: ["#25D366", "#F59E0B", "#EF4444"], borderWidth: 0 }],
      },
      options: { cutout: "60%", plugins: { legend: { display: true, position: "bottom", labels: { padding: 16, usePointStyle: true } } } },
    });
  }

  function renderTable(recent) {
    const tbody = document.querySelector("#recentTable tbody");
    tbody.innerHTML = "";
    recent.forEach((r) => {
      const tr = document.createElement("tr");
      const note = r.reviewText || r.feedbackText || "-";
      const clicked = r.clickedAt ? `✅ ${new Date(r.clickedAt).toLocaleTimeString()}` : "—";
      tr.innerHTML = `<td>${new Date(r.createdAt).toLocaleString()}</td><td>${r.customerName || "-"}</td><td>${r.phone || "-"}</td><td>${r.sentiment || "-"}</td><td>${r.stage}</td><td>${clicked}</td><td>${note}</td>`;
      tbody.appendChild(tr);
    });
  }

  // === Customer Management ===
  document.getElementById("crudAddBtn").addEventListener("click", async () => {
    const name = document.getElementById("crudName").value.trim();
    const phone = document.getElementById("crudPhone").value.trim();
    const visitDate = document.getElementById("crudVisitDate").value;
    const btn = document.getElementById("crudAddBtn");
    if (!name || !phone) { toast("Name and phone required", "error"); return; }
    setLoading(btn, true);
    try {
    const body = { name, phone };
    if (visitDate) body.visitDate = visitDate;
    body.optedIn = document.getElementById("crudOptIn") ? document.getElementById("crudOptIn").checked : true;
    if (CURRENT_CLIENT.clientId) body.clientId = CURRENT_CLIENT.clientId;
      const res = await fetchJSON("/api/customers", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) { toast(data.error || "Failed", "error"); return; }
      toast(`Added ${data.name}`);
      document.getElementById("crudName").value = "";
      document.getElementById("crudPhone").value = "";
      loadCustomers();
    } catch (err) { toast("Error: " + err.message, "error"); }
    finally { setLoading(btn, false); }
  });

  async function loadCustomers() {
    const seq = selectionSeq;
    try {
      const res = await fetchJSON(`/api/customers${clientQ()}`);
      const customers = await res.json();
      if (seq !== selectionSeq) return; // a newer client selection happened
      document.getElementById("customerCount").textContent = customers.length;
      const tbody = document.querySelector("#customerTable tbody");
      tbody.innerHTML = "";
      customers.forEach((c) => {
        const tr = document.createElement("tr");
        tr.dataset.phone = c.phone;
        const visited = c.visitDate ? new Date(c.visitDate).toLocaleDateString() : "-";
        const review = c.reviewText ? c.reviewText.length > 80 ? esc(c.reviewText.slice(0, 80)) + "…" : esc(c.reviewText) : "—";
        tr.innerHTML = `
          <td><strong>${esc(c.name)}</strong></td>
          <td style="font-family:monospace;font-size:.8rem">${esc(c.phone)}</td>
          <td>${visited}</td>
          <td class="${c.firstContactedAt ? 'tag-yes' : 'tag-no'}">${c.firstContactedAt ? '✅ Yes' : '—'}</td>
          <td class="${c.reviewProvided ? 'tag-yes' : 'tag-no'}">${c.reviewProvided ? '✅ Yes' : '—'}</td>
          <td title="${esc(c.reviewText || "")}" style="max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${review}</td>
          <td style="white-space:nowrap">
            <button class="btn-edit" data-phone="${esc(c.phone)}" data-name="${esc(c.name.replace(/"/g, '&quot;'))}" data-visit="${c.visitDate || ''}" data-reviewed="${c.reviewProvided}" data-opted="${c.optedIn !== false}">Edit</button>
            <button class="btn-delete" data-phone="${esc(c.phone)}">Delete</button>
          </td>`;
        tbody.appendChild(tr);
      });
    } catch (err) { console.error("loadCustomers:", err); }
  }

  // Event delegation for customer table (handles dynamically created buttons)
  document.querySelector("#customerTable tbody").addEventListener("click", async (e) => {
    const target = e.target.closest("button");
    if (!target) return;
    if (target.classList.contains("btn-edit")) {
      editingPhone = target.dataset.phone;
      document.getElementById("editPhoneLabel").textContent = editingPhone;
      document.getElementById("editName").value = target.dataset.name;
      document.getElementById("editVisitDate").value = target.dataset.visit ? target.dataset.visit.substring(0, 10) : "";
      document.getElementById("editReviewed").checked = target.dataset.reviewed === "true";
      const optInEl = document.getElementById("editOptIn");
      if (optInEl) optInEl.checked = target.dataset.opted !== "false";
      document.getElementById("crudEditArea").classList.remove("hidden");
    }
    if (target.classList.contains("btn-delete")) {
      const phone = target.dataset.phone;
      const confirmed = await confirmModal(`Delete customer <strong>${phone}</strong> and all their conversation data? This cannot be undone.`);
      if (!confirmed) return;
      const row = target.closest("tr");
      row.classList.add("removing");
      try {
        const res = await fetchJSON(`/api/customers/${encodeURIComponent(phone)}${clientQ()}`, { method: "DELETE" });
        if (!res.ok) { row.classList.remove("removing"); toast("Delete failed", "error"); return; }
        toast(`Deleted ${phone}`);
        loadCustomers();
        loadDashboard();
      } catch (err) { row.classList.remove("removing"); toast("Error: " + err.message, "error"); }
    }
  });

  document.getElementById("editCancelBtn").addEventListener("click", () => {
    document.getElementById("crudEditArea").classList.add("hidden");
    editingPhone = null;
  });

  document.getElementById("editSaveBtn").addEventListener("click", async () => {
    if (!editingPhone) return;
    const name = document.getElementById("editName").value.trim();
    const visitDate = document.getElementById("editVisitDate").value;
    const reviewed = document.getElementById("editReviewed").checked;
    const btn = document.getElementById("editSaveBtn");
    setLoading(btn, true);
    try {
      const body = {};
      if (name) body.name = name;
      if (visitDate) body.visitDate = visitDate;
      body.reviewProvided = reviewed;
      const optInEl = document.getElementById("editOptIn");
      if (optInEl) body.optedIn = optInEl.checked;
      if (CURRENT_CLIENT.clientId) body.clientId = CURRENT_CLIENT.clientId;
      const res = await fetchJSON(`/api/customers/${encodeURIComponent(editingPhone)}`, {
        method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      });
      if (!res.ok) { toast("Save failed", "error"); return; }
      toast(`Updated ${editingPhone}`);
      document.getElementById("crudEditArea").classList.add("hidden");
      editingPhone = null;
      loadCustomers();
    } catch (err) { toast("Error: " + err.message, "error"); }
    finally { setLoading(btn, false); }
  });

  document.getElementById("clearAllBtn").addEventListener("click", async () => {
    const confirmed = await confirmModal("Delete ALL customers, conversations, and records? The mock seed data will reappear after refresh. This cannot be undone.");
    if (!confirmed) return;
    const btn = document.getElementById("clearAllBtn");
    setLoading(btn, true);
    try {
      const res = await fetchJSON("/api/clear-all-data", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ clientId: CURRENT_CLIENT.clientId || undefined }) });
      const data = await res.json();
      toast(`Cleared ${data.customersDeleted} customers, ${data.conversationsDeleted} conversations, ${data.recordsDeleted} records`);
      loadDashboard();
      loadCustomers();
    } catch (err) { toast("Error: " + err.message, "error"); }
    finally { setLoading(btn, false); }
  });

  initAuth();

  // === Tab navigation (UI only) ===
  const tabBtns = document.querySelectorAll("#mainTabs .tab-btn");
  const panels = document.querySelectorAll("#dashboardMain .tab-panel");
  tabBtns.forEach((btn) => {
    btn.addEventListener("click", () => {
      tabBtns.forEach((b) => b.classList.toggle("active", b === btn));
      panels.forEach((p) => p.classList.toggle("hidden", p.dataset.panel !== btn.dataset.tab));
    });
  });
});

// === Test Lab (free simulator) ===
document.addEventListener("DOMContentLoaded", () => {
let testPhone = null;

async function initTestLab() {
  const user = await ReviewAuth.checkAuth();
  if (!user) {
    ReviewAuth.onLogin(() => loadTestLab());
    return;
  }
  loadTestLab();
}
initTestLab();

function escHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

async function loadTestLab() {
  renderTestScenarios();
  await loadTestSessions();
}

async function renderTestScenarios() {
  const container = document.getElementById("testLabScenarios");
  container.innerHTML = "";
  try {
    const res = await fetchJSON("/api/test/scenarios");
    const scenarios = await res.json();
    scenarios.forEach((s) => {
      const btn = document.createElement("button");
      btn.className = "btn btn-secondary scenario-btn";
      btn.textContent = `${s.name} (${s.steps} steps)`;
      btn.onclick = () => runTestScenario(s.key);
      container.appendChild(btn);
    });
  } catch (err) {
    container.innerHTML = `<span style="color:var(--red)">Failed to load scenarios: ${escHtml(err.message)}</span>`;
  }
}

async function loadTestSessions() {
  const container = document.getElementById("testLabSessions");
  try {
    const res = await fetchJSON("/api/test/sessions");
    const sessions = await res.json();
    if (sessions.length === 0) {
      container.innerHTML = `<span class="chat-empty">No test chats yet. Open a chat below or run a scenario.</span>`;
      return;
    }
    container.innerHTML = "";
    sessions.forEach((s) => {
      const chip = document.createElement("button");
      chip.className = `session-chip ${s.phone === testPhone ? "active" : ""}`;
      chip.innerHTML = `<span class="chip-phone">${escHtml(s.phone)}</span><span class="chip-meta">${escHtml(s.lastText || "").slice(0, 60)}${s.state ? ` · ${s.state}` : ""}</span>`;
      chip.onclick = () => openTestChat(s.phone);
      container.appendChild(chip);
    });
  } catch (err) {
    container.innerHTML = `<span style="color:var(--red)">${escHtml(err.message)}</span>`;
  }
}

function openTestChat(phone) {
  testPhone = phone;
  document.getElementById("testLabResetBtn").classList.remove("hidden");
  renderTestSessionsUI();
}

function setChatEmpty(msg) {
  document.getElementById("testLabChat").innerHTML = `<div class="chat-empty">${msg}</div>`;
}

function renderTestSessionsUI() {
  const sessions = document.querySelectorAll(".session-chip");
  sessions.forEach((c) => c.classList.toggle("active", c.querySelector(".chip-phone").textContent === testPhone));
}

async function loadTestHistory() {
  const chatEl = document.getElementById("testLabChat");
  const stateEl = document.getElementById("testLabState");
  if (!testPhone) { setChatEmpty("Pick or open a chat first."); return; }
  chatEl.innerHTML = "";
  try {
    const res = await fetchJSON(`/api/test/history?phone=${encodeURIComponent(testPhone)}`);
    const data = await res.json();
    if (data.transcript.length === 0) { setChatEmpty("Empty conversation — send the first message as the customer."); }
    data.transcript.forEach((m) => {
      const bubble = document.createElement("div");
      bubble.className = `bubble ${m.role}`;
      bubble.innerHTML = `<span>${escHtml(m.text)}</span>${m.role === "bot" ? `<span class="bubble-tag">${m.interactive ? "📋 list-picker" : m.state ? `state: ${escHtml(m.state)}` : ""}</span>` : ""}`;
      chatEl.appendChild(bubble);
    });
    chatEl.scrollTop = chatEl.scrollHeight;
    if (data.state) {
      stateEl.classList.remove("hidden");
      stateEl.innerHTML = `<strong>Bot state:</strong> ${escHtml(data.state)}${data.sentiment ? ` · sentiment: <strong>${escHtml(data.sentiment)}</strong>` : ""}`;
    } else {
      stateEl.classList.add("hidden");
    }
  } catch (err) {
    setChatEmpty(`Error loading history: ${escHtml(err.message)}`);
  }
}

async function sendTestMessage() {
  const input = document.getElementById("testLabMsg");
  const message = input.value.trim();
  if (!message) return;
  if (!testPhone) { toast("Open or pick a chat first", "error"); return; }
  input.value = "";
  const chatEl = document.getElementById("testLabChat");
  const customerBubble = document.createElement("div");
  customerBubble.className = "bubble customer";
  customerBubble.innerHTML = `<span>${escHtml(message)}</span><span class="bubble-tag">customer</span>`;
  chatEl.appendChild(customerBubble);
  chatEl.scrollTop = chatEl.scrollHeight;
  const typing = document.createElement("div");
  typing.className = "bubble bot";
  typing.innerHTML = `<span class="spinner"></span> bot is typing…`;
  chatEl.appendChild(typing);
  chatEl.scrollTop = chatEl.scrollHeight;
  try {
    const res = await fetchJSON("/api/test/send", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ phone: testPhone, message }),
    }, 30000);
    const data = await res.json();
    if (!res.ok) { typing.remove(); toast(data.error || "Failed", "error"); return; }
    typing.remove();
    await loadTestHistory();
    await loadTestSessions();
  } catch (err) {
    typing.remove();
    toast("Error: " + err.message, "error");
  }
}

async function runTestScenario(key) {
  const btn = document.querySelector(`.scenario-btn`);
  try {
    toast(`Running scenario…`);
    const res = await fetchJSON("/api/test/scenario", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ scenario: key }),
    }, 60000);
    const data = await res.json();
    if (!res.ok) { toast(data.error || "Scenario failed", "error"); return; }
    testPhone = data.phone;
    document.getElementById("testLabResetBtn").classList.remove("hidden");
    await loadTestHistory();
    await loadTestSessions();
    toast(`Scenario "${data.name}" done — ${data.transcript.length} exchanges`);
  } catch (err) {
    toast("Error: " + err.message, "error");
  }
}

async function resetTestChat() {
  if (!testPhone) return;
  try {
    const res = await fetchJSON("/api/test/reset", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ phone: testPhone }),
    });
    if (!res.ok) { toast("Reset failed", "error"); return; }
    toast("Conversation reset");
    await loadTestHistory();
    await loadTestSessions();
  } catch (err) { toast("Error: " + err.message, "error"); }
}

async function clearAllTestChats() {
  const confirmed = await confirmModal("Delete ALL test simulator chats? This does not touch real customers or dashboard data.");
  if (!confirmed) return;
  try {
    const res = await fetchJSON("/api/test/clear", { method: "POST" });
    const data = await res.json();
    testPhone = null;
    document.getElementById("testLabResetBtn").classList.add("hidden");
    setChatEmpty("All test chats cleared.");
    await loadTestSessions();
    toast(`Cleared ${data.deleted} test messages`);
  } catch (err) { toast("Error: " + err.message, "error"); }
}

document.getElementById("testLabNewBtn").addEventListener("click", () => {
  const phone = document.getElementById("testLabNewPhone").value.trim();
  if (!phone) { toast("Enter a phone number", "error"); return; }
  document.getElementById("testLabNewPhone").value = "";
  openTestChat(phone);
  loadTestHistory();
});

document.getElementById("testLabSendBtn").addEventListener("click", sendTestMessage);
document.getElementById("testLabMsg").addEventListener("keydown", (e) => { if (e.key === "Enter") sendTestMessage(); });
document.getElementById("testLabResetBtn").addEventListener("click", resetTestChat);
document.getElementById("testLabClearBtn").addEventListener("click", clearAllTestChats);
});