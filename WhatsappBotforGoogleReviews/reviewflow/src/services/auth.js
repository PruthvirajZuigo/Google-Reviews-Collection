const crypto = require("crypto");
const logger = require("./logger");

const TOKEN_TTL_MS = Number(process.env.AUTH_TOKEN_TTL_MS) || 12 * 60 * 60 * 1000; // 12h

function getSecret() {
  return process.env.AUTH_SECRET || process.env.SESSION_SECRET || "reviewflow-dev-secret-change-me";
}

/**
 * Password hashing via scrypt (Node built-in, no deps).
 * Stored format: scrypt$salt$hash
 */
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(String(password), salt, 64).toString("hex");
  return `scrypt$${salt}$${hash}`;
}

function verifyPassword(password, stored) {
  if (!stored || !stored.startsWith("scrypt$")) return false;
  const [scheme, salt, expected] = stored.split("$");
  if (scheme !== "scrypt" || !salt || !expected) return false;
  const actual = crypto.scryptSync(String(password), salt, 64).toString("hex");
  const a = Buffer.from(actual, "hex");
  const b = Buffer.from(expected, "hex");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * Stateless signed token: payload.base64url(HMAC-SHA256(payload)).
 * Payload: { userId, role, exp }
 */
function signToken(user) {
  const payload = Buffer.from(
    JSON.stringify({ userId: String(user._id), role: user.role, exp: Date.now() + TOKEN_TTL_MS })
  ).toString("base64url");
  const sig = crypto.createHmac("sha256", getSecret()).update(payload).digest("base64url");
  return `${payload}.${sig}`;
}

function verifyToken(token) {
  if (!token || typeof token !== "string" || !token.includes(".")) return null;
  const [payload, sig] = token.split(".");
  const expected = crypto.createHmac("sha256", getSecret()).update(payload).digest("base64url");
  const a = Buffer.from(sig || "");
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (data.exp && Date.now() > data.exp) return null;
    return data;
  } catch (err) {
    logger.warn("Auth token parse failed:", err.message);
    return null;
  }
}

module.exports = { hashPassword, verifyPassword, signToken, verifyToken, TOKEN_TTL_MS };
