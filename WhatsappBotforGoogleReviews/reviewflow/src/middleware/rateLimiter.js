const rateLimit = require("express-rate-limit");

const windowMs = () => Number(process.env.RATE_LIMIT_WINDOW_MS) || 15 * 60 * 1000;

function makeLimiter(max, message) {
  return rateLimit({
    windowMs: windowMs(),
    max,
    standardHeaders: true,
    legacyHeaders: false,
    // Local dev isn't behind a real proxy, but something on this machine
    // (antivirus/VPN) is injecting X-Forwarded-For anyway. Disable just
    // this one check rather than blindly trusting the header.
    validate: { xForwardedForHeader: false },
    message: { error: message },
  });
}

// Whole API surface: generous budget so the admin panel (which fans out ~15
// requests per page load for clients/users/customers) and the dashboard never
// trip it. Only /api is limited — static files and the Twilio webhook are not.
const apiLimiter = makeLimiter(
  Number(process.env.RATE_LIMIT_MAX_REQUESTS) || 300,
  "Too many requests, please try again later."
);

// Login specifically: tight budget to stop brute-force attempts.
const loginLimiter = makeLimiter(
  Number(process.env.RATE_LIMIT_LOGIN_MAX) || 20,
  "Too many login attempts, please try again later."
);

module.exports = { apiLimiter, loginLimiter };
