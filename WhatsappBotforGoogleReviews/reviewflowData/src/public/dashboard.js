document.addEventListener("DOMContentLoaded", () => {
  let chartInstance = null;

  document.getElementById("triggerBtn").addEventListener("click", async () => {
    const phone = document.getElementById("triggerPhone").value;
    const customerName = document.getElementById("triggerName").value;
    const resultEl = document.getElementById("triggerResult");
    resultEl.textContent = "Sending...";
    try {
      const res = await fetch("/api/trigger-review", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone, customerName }),
      });
      const data = await res.json();
      resultEl.textContent = data.mock
        ? `Mock send logged (no real Twilio configured): "${data.message}"`
        : `Sent! ${data.sent ? "✅" : "❌"}`;
      loadDashboard();
    } catch (err) {
      resultEl.textContent = "Failed: " + err.message;
    }
  });

  async function loadDashboard() {
    try {
      const res = await fetch("/api/dashboard/data");
      if (!res.ok) return;
      const data = await res.json();
      renderStats(data);
      renderChart(data);
      renderTable(data.recent);
    } catch (err) {
      console.error(err);
    }
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
      type: "pie",
      data: {
        labels: ["Happy", "Neutral", "Sad"],
        datasets: [{ data: [data.happy, data.neutral, data.sad], backgroundColor: ["#25D366", "#FBBC05", "#EA4335"] }],
      },
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

  loadDashboard();
});