const User = require("../models/User");
const auth = require("../services/auth");
const logger = require("../services/logger");

/**
 * Extracts a Bearer token from the Authorization header.
 */
function extractToken(req) {
  const header = req.headers.authorization || "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1] : null;
}

/**
 * Requires a valid login. Attaches req.user (mongoose doc) and req.token.
 */
async function requireAuth(req, res, next) {
  const token = extractToken(req);
  const payload = token ? auth.verifyToken(token) : null;
  if (!payload) return res.status(401).json({ error: "Login required" });
  try {
    const user = await User.findById(payload.userId).lean();
    if (!user || !user.active) return res.status(401).json({ error: "Account not found or disabled" });
    req.user = user;
    req.token = token;
    next();
  } catch (err) {
    logger.error("Auth lookup failed:", err.message);
    next(err);
  }
}

/**
 * Requires the authenticated user to be an admin.
 */
function requireAdmin(req, res, next) {
  if (!req.user) return res.status(401).json({ error: "Login required" });
  if (req.user.role !== "admin") return res.status(403).json({ error: "Admin access required" });
  next();
}

/**
 * Middleware: computes req.scopedClientId after requireAuth.
 * Client users are locked to their own client; admins may pass ?clientId
 * (null = all clients). Client users without a client binding get 403.
 */
function resolveScope(req, res, next) {
  if (!req.user) return res.status(401).json({ error: "Login required" });
  if (req.user.role === "client") {
    if (!req.user.clientId) return res.status(403).json({ error: "No client assigned to this account" });
    req.scopedClientId = req.user.clientId;
  } else {
    req.scopedClientId = req.query.clientId || req.body?.clientId || null;
  }
  next();
}

module.exports = { requireAuth, requireAdmin, resolveScope, extractToken };
