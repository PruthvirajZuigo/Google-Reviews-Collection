function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function sanitizeBodyStrings(req, res, next) {
  if (req.body && typeof req.body === "object") {
    for (const key of Object.keys(req.body)) {
      if (typeof req.body[key] === "string") {
        req.body[key] = escapeHtml(req.body[key].slice(0, 1000));
      }
    }
  }
  next();
}

function requireFields(fields) {
  return (req, res, next) => {
    const missing = fields.filter((f) => !req.body?.[f]);
    if (missing.length) {
      return res.status(400).json({ error: `Missing required field(s): ${missing.join(", ")}` });
    }
    next();
  };
}

module.exports = { sanitizeBodyStrings, requireFields, escapeHtml };
