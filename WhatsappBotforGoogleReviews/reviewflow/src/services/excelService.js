const XLSX = require("xlsx");
const { normalizePhone } = require("./twilio");
const logger = require("./logger");

function parseExcel(buffer) {
  const workbook = XLSX.read(buffer, { type: "buffer" });
  const sheetName = workbook.SheetNames[0];
  if (!sheetName) throw new Error("Excel file has no sheets");
  const sheet = workbook.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json(sheet, { defval: "" });
  const valid = [];
  const errors = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const name = String(row.name || row.Name || row.NAME || "").trim();
    const phoneRaw = String(row.phone || row.Phone || row.PHONE || row.mobile || row.Mobile || "").trim();
    const visitDate = row.visitDate || row.VisitDate || row["visit date"] || row["Visit Date"] || "";
    const notes = String(row.notes || row.Notes || row.additionalNotes || row.AdditionalNotes || row.item || row.Item || "").trim();
    const rp = row.reviewProvided ?? row.ReviewProvided ?? row["review provided"] ?? row["Review Provided"] ?? false;
    const reviewProvided = typeof rp === "boolean" ? rp : typeof rp === "number" ? rp === 1 : ["yes", "true", "1"].includes(String(rp).toLowerCase());
    if (!name || !phoneRaw) {
      errors.push({ row: i + 2, reason: "Missing name or phone", data: row });
      continue;
    }
    const phone = normalizePhone(phoneRaw);
    const digits = phone.replace(/\D/g, "");
    if (digits.length < 10) {
      errors.push({ row: i + 2, reason: `Invalid phone: "${phoneRaw}" (${digits.length} digits)`, data: row });
      continue;
    }
    valid.push({
      name,
      phone,
      visitDate: visitDate ? new Date(visitDate) : new Date(),
      reviewProvided,
      additionalNotes: notes,
    });
  }
  return { valid, errors, totalRows: rows.length };
}

module.exports = { parseExcel };
