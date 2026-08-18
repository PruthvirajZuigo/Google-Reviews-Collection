const logger = require("../services/logger");

function errorHandler(err, req, res, next) {
  logger.error(`${req.method} ${req.originalUrl} ->`, err.message);
  if (process.env.NODE_ENV !== "production") logger.error(err.stack);
  res.status(err.status || 500).json({ error: err.message || "Internal server error" });
}

module.exports = errorHandler;
