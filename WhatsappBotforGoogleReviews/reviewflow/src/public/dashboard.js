document.addEventListener("DOMContentLoaded", () => {
  let chartInstance = null;
  let editingPhone = null;

  // === Toast system ===
  const toastContainer = document.createElement("div");
  toastContainer.id = "toastContainer";
  document.body.appendChild(toastContainer);

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

  // === Loading spinner ===
  function setLoading(btn, loading) {
    btn.disabled = loading;
    btn.innerHTML = loading ? `<span class="spinner"></span> Processing...` : btn.dataset.originalText || btn.textContent;
    if (!btn.dataset.originalText) btn.dataset.originalText = btn.textContent;
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
      const res = await fetch("/api/trigger-review", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone, customerName: name, item: item || undefined }),
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
      const res = await fetch("/api/trigger-batch", { method: "POST" });
      const data = await res.json();
      toast(`Sent to ${data.sent} of ${data.total} pending customers`);
      loadDashboard();
    } catch (err) { toast("Error: " + err.message, "error"); }
    finally { setLoading(btn, false); }
  });

  document.getElementById("batchPreviewBtn").addEventListener("click", async () => {
    const previewEl = document.getElementById("batchPreview");
    previewEl.classList.remove("hidden");
    previewEl.innerHTML = '<span class="spinner"></span> Loading...';
    try {
      const res = await fetch("/api/pending-preview");
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
    try {
      const res = await fetch("/api/upload-excel", { method: "POST", body: formData });
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
  async function loadDashboard() {
    try {
      const res = await fetch("/api/dashboard/data");
      if (!res.ok) return;
      const data = await res.json();
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
    if (chartInstance) chartInstance.destroy();
    chartInstance = new Chart(ctx, {
      type: "doughnut",
      data: {
        labels: ["Happy", "Neutral", "Sad"],
        datasets: [{ data: [data.happy, data.neutral, data.sad], backgroundColor: ["#25D366", "#F59E0B", "#EF4444"], borderWidth: 0 }],
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
      const res = await fetch("/api/customers", {
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
    try {
      const res = await fetch("/api/customers");
      const customers = await res.json();
      document.getElementById("customerCount").textContent = customers.length;
      const tbody = document.querySelector("#customerTable tbody");
      tbody.innerHTML = "";
      customers.forEach((c) => {
        const tr = document.createElement("tr");
        tr.dataset.phone = c.phone;
        const visited = c.visitDate ? new Date(c.visitDate).toLocaleDateString() : "-";
        tr.innerHTML = `
          <td><strong>${c.name}</strong></td>
          <td style="font-family:monospace;font-size:.8rem">${c.phone}</td>
          <td>${visited}</td>
          <td class="${c.firstContactedAt ? 'tag-yes' : 'tag-no'}">${c.firstContactedAt ? '✅ Yes' : '—'}</td>
          <td class="${c.reviewProvided ? 'tag-yes' : 'tag-no'}">${c.reviewProvided ? '✅ Yes' : '—'}</td>
          <td style="white-space:nowrap">
            <button class="btn-edit" data-phone="${c.phone}" data-name="${c.name.replace(/"/g, '&quot;')}" data-visit="${c.visitDate || ''}" data-reviewed="${c.reviewProvided}">Edit</button>
            <button class="btn-delete" data-phone="${c.phone}">Delete</button>
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
      document.getElementById("crudEditArea").classList.remove("hidden");
    }
    if (target.classList.contains("btn-delete")) {
      const phone = target.dataset.phone;
      const confirmed = await confirmModal(`Delete customer <strong>${phone}</strong> and all their conversation data? This cannot be undone.`);
      if (!confirmed) return;
      const row = target.closest("tr");
      row.classList.add("removing");
      try {
        const res = await fetch(`/api/customers/${encodeURIComponent(phone)}`, { method: "DELETE" });
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
      const res = await fetch(`/api/customers/${encodeURIComponent(editingPhone)}`, {
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

  loadDashboard();
  loadCustomers();
});