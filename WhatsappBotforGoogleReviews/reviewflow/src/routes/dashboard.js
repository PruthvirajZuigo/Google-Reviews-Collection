const express = require("express");
const router = express.Router();
const storage = require("../services/storage");
const { requireAuth, resolveScope } = require("../middleware/auth");

router.get("/data", requireAuth, resolveScope, async (req, res) => {
  const clientId = req.scopedClientId;
  const records = (await storage.readAll(clientId)).filter((r) => !r.test);
  const happy = records.filter((r) => r.sentiment === "happy").length;
  const neutral = records.filter((r) => r.sentiment === "neutral").length;
  const sad = records.filter((r) => r.sentiment === "sad").length;

  const withStage = records.map((r) => {
    let stage;
    if (r.state === "AWAITING_RATING" || !r.sentiment) {
      stage = r.triggerSource === "followup_reminder" ? "1. Reminder sent" : "1. Waiting for reply";
    } else if (r.state === "AWAITING_REVIEW_CONFIRM") {
      stage = "2. Review posted?";
    } else if (r.sentiment === "sad") {
      stage = r.state === "COMPLETED" && r.feedbackText ? "3. Complaint logged" : "3. Asked what went wrong";
    } else {
      stage = r.state === "COMPLETED" && r.feedbackText ? "2. Sent to Google" : "2. Asked what they liked";
    }
    return { ...r, stage };
  });

  res.json({ totalMessages: records.length, happy, neutral, sad, recent: withStage.slice(-20).reverse() });
});

module.exports = router;
