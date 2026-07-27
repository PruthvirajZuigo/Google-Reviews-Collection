const rateLimit = require("express-rate-limit");

const limiter = rateLimit({
  windowMs: Number(process.env.RATE_LIMIT_WINDOW_MS) || 15 * 60 * 1000,
  max: Number(process.env.RATE_LIMIT_MAX_REQUESTS) || 100,
  standardHeaders: true,
  legacyHeaders: false,
  // Local dev isn't behind a real proxy, but something on this machine
  // (antivirus/VPN) is injecting X-Forwarded-For anyway. Disable just
  // this one check rather than blindly trusting the header.
  validate: { xForwardedForHeader: false },
  message: { error: "Too many requests, please try again later." },
});

module.exports = limiter;