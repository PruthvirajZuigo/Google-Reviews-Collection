const express = require("express");
const router = express.Router();

const storage = require("../services/storage");
const { resolveClient } = require("../services/clientConfig");

router.get("/:id", async (req, res) => {
  const id = req.params.id;

  const record = await storage.markClicked(id);

  console.log("Review Link Clicked:", id);

  if (!record) {
    return res.status(404).send("Invalid review link.");
  }

  // Redirect each customer's review link to their own client's Google review URL.
  const client = await resolveClient({ clientId: record.clientId, phone: record.phone });
  res.redirect(client.profile.googleReviewUrl || "https://www.google.com/maps");
});

module.exports = router;