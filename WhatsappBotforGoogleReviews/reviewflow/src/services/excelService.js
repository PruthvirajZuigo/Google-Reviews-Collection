const XLSX = require("xlsx");
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
    const phone = String(row.phone || row.Phone || row.PHONE || row.mobile || row.Mobile || "").trim();
    const visitDate = row.visitDate || row.VisitDate || row["visit date"] || row["Visit Date"] || "";
    const notes = String(row.notes || row.Notes || row.additionalNotes || row.AdditionalNotes || row.item || row.Item || "").trim();
    const reviewProvided = !!(row.reviewProvided || row.ReviewProvided || row["review provided"] || row["Review Provided"] || false);
    if (!name || !phone) {
      errors.push({ row: i + 2, reason: "Missing name or phone", data: row });
      continue;
    }
    valid.push({
      name,
      phone: phone.startsWith("+") ? phone : phone.startsWith("91") && phone.length === 12 ? `+${phone}` : `+91${phone}`,
      visitDate: visitDate ? new Date(visitDate) : new Date(),
      reviewProvided,
      additionalNotes: notes,
    });
  }
  return { valid, errors, totalRows: rows.length };
}

module.exports = { parseExcel };
