const $ = (id) => document.getElementById(id);

function toast(msg, type = "info") {
  let container = document.getElementById("toastContainer");
  if (!container) {
    container = document.createElement("div");
    container.id = "toastContainer";
    document.body.appendChild(container);
  }
  const el = document.createElement("div");
  el.className = `toast toast-${type}`;
  el.textContent = msg;
  container.appendChild(el);
  setTimeout(() => {
    el.classList.add("toast-removing");
    setTimeout(() => el.remove(), 250);
  }, 3500);
}

async function api(url, opts = {}) {
  const headers = Object.assign({}, opts.body ? { "Content-Type": "application/json" } : {}, ReviewAuth.authHeaders());
  const res = await fetch(url, Object.assign({}, opts, { headers }));
  if (res.status === 401) {
    ReviewAuth.clearToken();
    ReviewAuth.showLogin();
    throw new Error("Please sign in to continue");
  }
  if (res.status === 403) {
    throw new Error("You need admin access for this page");
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

let clients = [];
let editingClientId = null;
let userList = [];
let editingUserId = null;

async function loadClients() {
  try {
    clients = await api("/api/admin/clients");
    renderClients();
    populateUserClientSelect();
    $("clientCount").textContent = clients.length;
    refreshStats();
  } catch (err) {
    toast(err.message, "error");
  }
}

async function refreshStats() {
  try {
    const [users, customers] = await Promise.all([
      api("/api/admin/users").catch(() => []),
      api("/api/customers").catch(() => []),
    ]);
    $("statClients").textContent = clients.length;
    if ($("userCount")) $("userCount").textContent = users.length;
    $("statUsers").textContent = users.length;
    $("statCustomers").textContent = Array.isArray(customers) ? customers.length : 0;
  } catch (err) {
    console.error("refreshStats:", err);
  }
}

async function renderClients() {
  const tbody = document.querySelector("#clientTable tbody");
  tbody.innerHTML = "";
  for (const c of clients) {
    const customers = await api(`/api/customers?clientId=${c.clientId}`).catch(() => []);
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td><strong>${escapeHtml(c.name)}</strong>${c.isDefault ? ' <span class="badge">default</span>' : ""}</td>
      <td><code>${c.clientId}</code></td>
      <td class="cell-url">${c.profile.googleReviewUrl ? `<a href="${c.profile.googleReviewUrl}" target="_blank" rel="noopener">open</a>` : "—"}</td>
      <td>${c.scheduler.batchTime}</td>
      <td>${c.features.testLab ? "✅" : "—"}</td>
      <td>${c.compliance.aiMode}</td>
      <td>${customers.length}</td>
      <td class="cell-actions">
        ${c.isDefault ? "" : `<button class="btn-edit" data-edit="${c.clientId}">Edit</button>`}
        ${c.isDefault ? "" : `<button class="btn-delete" data-del="${c.clientId}">Delete</button>`}
      </td>`;
    tbody.appendChild(tr);
  }
  tbody.querySelectorAll("[data-edit]").forEach((b) => b.onclick = () => openEdit(b.dataset.edit));
  tbody.querySelectorAll("[data-del]").forEach((b) => b.onclick = () => deleteClient(b.dataset.del));
}

function escapeHtml(s) {
  return String(s || "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function collectClientForm(id) {
  return {
    name: $(`${id}Name`).value.trim(),
    profile: {
      googleReviewUrl: $(`${id}ReviewUrl`).value.trim(),
      feedbackFormUrl: $(`${id}FeedbackUrl`).value.trim(),
      managerWhatsapp: $(`${id}Manager`).value.trim(),
      businessHours: $(`${id}Hours`).value.trim(),
      offer: $(`${id}Offer`).value.trim(),
    },
    scheduler: {
      batchTime: $(`${id}BatchTime`).value || "12:30",
      confirmDelayMinutes: Number($(`${id}ConfirmDelay`).value) || 30,
      protectionDays: Number($(`${id}Protection`).value) || 7,
    },
    features: {
      testLab: $(`${id}TestLab`).checked,
      dashboard: $(`${id}Dashboard`).checked,
      excelUpload: $(`${id}Excel`).checked,
      manualTrigger: $(`${id}Manual`).checked,
      recordsHistory: $(`${id}Records`).checked,
      businessFaq: $(`${id}Faq`).checked,
    },
    llm: {
      provider: $(`${id}LlmProvider`).value,
      model: $(`${id}LlmModel`).value.trim(),
      temperature: Number($(`${id}LlmTemp`).value) || 0.7,
      maxTokens: Number($(`${id}LlmTokens`).value) || 300,
      dailyBudgetCalls: Number($(`${id}LlmBudget`).value) || 50,
    },
    compliance: {
      requireOptIn: $(`${id}OptIn`).checked,
      handleStop: $(`${id}HandleStop`).checked,
      aiMode: $(`${id}AiMode`).value,
      throttlePerHour: Number($(`${id}Throttle`).value) || 0,
    },
  };
}

function openEdit(clientId) {
  const c = clients.find((x) => x.clientId === clientId);
  if (!c) return;
  editingClientId = clientId;
  $("editClientLabel").textContent = c.clientId;

  $("editName").value = c.name || "";
  $("editManager").value = c.profile?.managerWhatsapp || "";
  $("editReviewUrl").value = c.profile?.googleReviewUrl || "";
  $("editFeedbackUrl").value = c.profile?.feedbackFormUrl || "";
  $("editHours").value = c.profile?.businessHours || "";
  $("editOffer").value = c.profile?.offer || "";

  $("editBatchTime").value = c.scheduler?.batchTime || "12:30";
  $("editConfirmDelay").value = c.scheduler?.confirmDelayMinutes ?? 30;
  $("editProtection").value = c.scheduler?.protectionDays ?? 7;

  $("editTestLab").checked = !!c.features?.testLab;
  $("editDashboard").checked = c.features?.dashboard !== false;
  $("editExcel").checked = c.features?.excelUpload !== false;
  $("editManual").checked = c.features?.manualTrigger !== false;
  $("editRecords").checked = c.features?.recordsHistory !== false;
  $("editFaq").checked = c.features?.businessFaq !== false;

  $("editLlmProvider").value = c.llm?.provider || "groq";
  $("editLlmModel").value = c.llm?.model || "";
  $("editLlmTemp").value = c.llm?.temperature ?? 0.7;
  $("editLlmTokens").value = c.llm?.maxTokens ?? 300;
  $("editLlmBudget").value = c.llm?.dailyBudgetCalls ?? 50;

  $("editOptIn").checked = c.compliance?.requireOptIn !== false;
  $("editHandleStop").checked = c.compliance?.handleStop !== false;
  $("editAiMode").value = c.compliance?.aiMode || "full";
  $("editThrottle").value = c.compliance?.throttlePerHour || 0;

  $("clientEditArea").classList.remove("hidden");
}

// Close modals when clicking the dark backdrop
["clientEditArea", "userEditArea"].forEach((id) => {
  const overlay = document.getElementById(id);
  if (overlay) overlay.addEventListener("click", (e) => {
    if (e.target === overlay) overlay.classList.add("hidden");
  });
});

async function deleteClient(clientId) {
  if (!confirm(`Delete client ${clientId}? Its customers will move to the default client.`)) return;
  try {
    await api(`/api/admin/clients/${clientId}`, { method: "DELETE" });
    toast(`Deleted ${clientId}`, "success");
    loadClients();
  } catch (err) {
    toast(err.message, "error");
  }
}

async function populateUserClientSelect() {
  const html = (sel) => {
    sel.innerHTML = "";
    const none = document.createElement("option");
    none.value = "";
    none.textContent = "— (no client) —";
    sel.appendChild(none);
    for (const c of clients) {
      const opt = document.createElement("option");
      opt.value = c.clientId;
      opt.textContent = c.name;
      sel.appendChild(opt);
    }
  };
  html($("userClient"));
  if ($("editUserClient")) html($("editUserClient"));
}

async function loadUsers() {
  try {
    userList = await api("/api/admin/users");
    const tbody = document.querySelector("#userTable tbody");
    tbody.innerHTML = "";
    for (const u of userList) {
      const client = clients.find((c) => c.clientId === u.clientId);
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td><strong>${escapeHtml(u.username)}</strong>${u.username === "admin" ? ' <span class="badge">root</span>' : ""}</td>
        <td>${escapeHtml(u.name)}</td>
        <td>${u.role}</td>
        <td>${client ? escapeHtml(client.name) : "—"}</td>
        <td class="${u.active ? 'tag-yes' : 'tag-no'}">${u.active ? "✅ Active" : "⛔ Disabled"}</td>
        <td>
          <button class="btn-edit" data-user-edit="${u._id}">Edit</button>
          ${u.username === "admin" ? "" : `<button class="btn-delete" data-user="${u._id}">Delete</button>`}
        </td>`;
      tbody.appendChild(tr);
    }
    tbody.querySelectorAll("[data-user-edit]").forEach((b) => b.onclick = () => openUserEdit(b.dataset.userEdit));
    tbody.querySelectorAll("[data-user]").forEach((b) => b.onclick = async () => {
      if (!confirm("Delete this user?")) return;
      await api(`/api/admin/users/${b.dataset.user}`, { method: "DELETE" });
      toast("User deleted", "success");
      loadUsers();
    });
    refreshStats();
  } catch (err) {
    toast(err.message, "error");
  }
}

function openUserEdit(id) {
  const u = userList.find((x) => x._id === id);
  if (!u) return;
  editingUserId = id;
  $("editUserLabel").textContent = u.username;
  $("editUserName").value = u.name || "";
  $("editUserRole").value = u.role || "client";
  $("editUserClient").value = u.clientId || "";
  $("editUserActive").checked = u.active !== false;
  $("editUserPassword").value = "";
  $("userEditArea").classList.remove("hidden");
}

async function saveUserEdit() {
  if (!editingUserId) return;
  const body = {
    name: $("editUserName").value.trim(),
    role: $("editUserRole").value,
    clientId: $("editUserClient").value || null,
    active: $("editUserActive").checked,
  };
  const pw = $("editUserPassword").value;
  if (pw) body.password = pw;
  try {
    await api(`/api/admin/users/${editingUserId}`, { method: "PUT", body: JSON.stringify(body) });
    toast(pw ? "User updated + password reset" : "User updated", "success");
    $("userEditArea").classList.add("hidden");
    editingUserId = null;
    loadUsers();
  } catch (err) {
    toast(err.message, "error");
  }
}

$("editUserSaveBtn").onclick = saveUserEdit;
$("editUserCancelBtn").onclick = () => {
  $("userEditArea").classList.add("hidden");
  editingUserId = null;
};

$("cliCreateBtn").onclick = async () => {
  if (!$("cliName").value.trim()) return toast("Business name is required", "error");
  try {
    const client = await api("/api/admin/clients", {
      method: "POST",
      body: JSON.stringify(collectClientForm("cli")),
    });
    toast(`Client created: ${client.clientId}`, "success");
    ["cliName", "cliReviewUrl", "cliManager", "cliHours", "cliOffer"].forEach((id) => ($(id).value = ""));
    loadClients();
  } catch (err) {
    toast(err.message, "error");
  }
};

$("editSaveBtn").onclick = async () => {
  try {
    await api(`/api/admin/clients/${editingClientId}`, {
      method: "PUT",
      body: JSON.stringify(collectClientForm("edit")),
    });
    toast("Client updated", "success");
    $("clientEditArea").classList.add("hidden");
    loadClients();
  } catch (err) {
    toast(err.message, "error");
  }
};

$("editCancelBtn").onclick = () => $("clientEditArea").classList.add("hidden");

$("cliYamlBtn").onclick = async () => {
  const file = $("cliYamlFile").files[0];
  if (!file) return toast("Choose a .yaml file first", "error");
  const formData = new FormData();
  formData.append("file", file);
  try {
    const res = await ReviewAuth.apiFetch("/api/admin/clients/from-template", { method: "POST", body: formData });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Upload failed");
    $("cliYamlResult").classList.remove("hidden");
    $("cliYamlResult").textContent = `Client created: ${data.clientId} (${data.name})`;
    toast(`Client created from template: ${data.clientId}`, "success");
    loadClients();
  } catch (err) {
    toast(err.message, "error");
  }
};

$("cliYamlDownload").onclick = async () => {
  const res = await ReviewAuth.apiFetch("/api/admin/template");
  if (!res.ok) return toast("Failed to download template", "error");
  const text = await res.text();
  const blob = new Blob([text], { type: "text/yaml" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "client-template.yaml";
  a.click();
  URL.revokeObjectURL(a.href);
};

$("userAddBtn").onclick = async () => {
  const username = $("userUsername").value.trim();
  if (!username) return toast("Username required", "error");
  try {
    await api("/api/admin/users", {
      method: "POST",
      body: JSON.stringify({
        username,
        name: $("userName").value.trim(),
        password: $("userPassword").value,
        role: $("userRole").value,
        clientId: $("userClient").value || null,
      }),
    });
    toast("User added. Password defaults to the username if you left it blank.", "success");
    $("userUsername").value = "";
    $("userName").value = "";
    $("userPassword").value = "";
    loadUsers();
  } catch (err) {
    toast(err.message, "error");
  }
};

// === Auth gate: the admin panel is admin-only ===
function showAccessDenied() {
  const main = $("adminMain");
  main.innerHTML = `
    <section class="panel">
      <h2>Admin access required</h2>
      <p class="desc">This panel is for platform admins only. If you are a client-role user, go to the <a href="/">Dashboard</a> to see your own business data.</p>
      <a class="btn btn-primary" href="/">Go to Dashboard →</a>
    </section>`;
}

async function initAuth() {
  const user = await ReviewAuth.checkAuth();
  if (!user) {
    ReviewAuth.showLogin(() => {
      if (!ReviewAuth.isAdmin()) return showAccessDenied();
      ReviewAuth.renderAuthUI();
      loadClients();
      loadUsers();
    });
    return;
  }
  if (!ReviewAuth.isAdmin()) return showAccessDenied();
  ReviewAuth.renderAuthUI();
  loadClients();
  loadUsers();
}

initAuth();
