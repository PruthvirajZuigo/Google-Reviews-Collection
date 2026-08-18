require("dotenv").config();
const express = require("express");
const helmet = require("helmet");
const cors = require("cors");
const compression = require("compression");
const path = require("path");
const redirectRoutes = require("./src/routes/redirect");

const logger = require("./src/services/logger");
const storage = require("./src/services/storage");
const { MOCK_RECORDS } = require("./src/utils/mockData");
const rateLimiter = require("./src/middleware/rateLimiter");
const { sanitizeBodyStrings } = require("./src/middleware/validator");
const errorHandler = require("./src/middleware/errorHandler");

const webhookRoutes = require("./src/routes/webhook");
const dashboardRoutes = require("./src/routes/dashboard");
const apiRoutes = require("./src/routes/api");

const app = express();

// app.use(helmet());
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
app.use(rateLimiter);
app.use(sanitizeBodyStrings);

app.use(express.static(path.join(__dirname, "src", "public")));

app.get("/health", (req, res) => res.json({ status: "ok", uptime: process.uptime() }));

app.use("/webhook", webhookRoutes);
app.use("/api/dashboard", dashboardRoutes);
app.use("/api", apiRoutes);

app.use("/r", redirectRoutes);

app.use(errorHandler);

// Seed mock data once, so the dashboard has something to show immediately.
storage.seedIfEmpty(MOCK_RECORDS);

const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, () => logger.info(`ReviewFlow running on http://localhost:${PORT}`));

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
