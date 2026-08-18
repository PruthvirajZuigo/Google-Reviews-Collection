const express = require("express");
const router = express.Router();

const storage = require("../services/storage");
const { resolveClient, DEFAULT_CLIENT_ID } = require("../services/clientConfig");

router.get("/:id", async (req, res) => {
  const id = req.params.id;

  const record = await storage.markClicked(id);

  console.log("Review Link Clicked:", id);

  if (!record) {
    return res.status(404).send("Invalid review link.");
  }

  // Redirect each customer's review link to their own client's Google review URL.
  const client = await resolveClient({ clientId: record.clientId, phone: record.phone });
  const reviewUrl = client.profile.googleReviewUrl || process.env.DEMO_GOOGLE_REVIEW_URL || "https://www.google.com/maps";
  res.redirect(reviewUrl);
});

module.exports = router;