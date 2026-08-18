require("dotenv").config();
const express = require("express");
const helmet = require("helmet");
const cors = require("cors");
const compression = require("compression");
const path = require("path");
const redirectRoutes = require("./src/routes/redirect");

const logger = require("./src/services/logger");
const storage = require("./src/services/storage");
const scheduler = require("./src/services/scheduler");
const { MOCK_RECORDS } = require("./src/utils/mockData");
const { apiLimiter, loginLimiter } = require("./src/middleware/rateLimiter");
const { sanitizeBodyStrings } = require("./src/middleware/validator");
const errorHandler = require("./src/middleware/errorHandler");
const connectDB = require("./src/config/database");
const { ensureSeed } = require("./src/services/clientConfig");

const webhookRoutes = require("./src/routes/webhook");
const dashboardRoutes = require("./src/routes/dashboard");
const apiRoutes = require("./src/routes/api");
const testLabRoutes = require("./src/routes/testLab");
const { requireAuth } = require("./src/middleware/auth");

const app = express();

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      ...helmet.contentSecurityPolicy.getDefaultDirectives(),
      "script-src": ["'self'", "https://cdnjs.cloudflare.com"],
    },
  },
}));
app.use(
  cors({
    origin: [/^http:\/\/localhost(:\d+)?$/, process.env.PRODUCTION_DOMAIN].filter(Boolean),
  })
);
app.use(compression());
app.use(express.json());
app.use(express.urlencoded({ extended: true })); // Twilio posts form-encoded
// Rate limits apply to the API only (not static assets, not the Twilio webhook).
// Login gets a tight budget; the rest of the API a generous one.
app.use("/api/login", loginLimiter);
app.use("/api", apiLimiter);
app.use(sanitizeBodyStrings);

// Dev: never cache HTML/CSS/JS so a stale browser copy can't run old code
// (the classic "API works but the page looks broken" symptom).
app.use((req, res, next) => {
  if (!/^\/(api|webhook|r|health)(\/|$)/.test(req.path)) {
    res.setHeader("Cache-Control", "no-store");
  }
  next();
});

app.use(express.static(path.join(__dirname, "src", "public")));

app.get("/health", (req, res) => res.json({ status: "ok", uptime: process.uptime() }));

app.use("/webhook", webhookRoutes);
app.use("/api/dashboard", dashboardRoutes);
app.use("/api/test", requireAuth, testLabRoutes);
app.use("/api", apiRoutes);

app.use("/r", redirectRoutes);

app.use(errorHandler);

async function start() {
  await connectDB();
  await ensureSeed();
  await storage.seedIfEmpty(MOCK_RECORDS);

  scheduler.start();

  const PORT = process.env.PORT || 3000;
  const server = app.listen(PORT, () => logger.info(`Zuigo running on http://localhost:${PORT}`));

  function shutdown(signal) {
    logger.info(`${signal} received, shutting down gracefully...`);
    server.close(() => {
      logger.info("Server closed. Bye!");
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 8000).unref();
  }
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

start();
