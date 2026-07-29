const express = require("express");
const router = express.Router();

const storage = require("../services/storage");
const { DEMO_BUSINESS } = require("../config/constants");

router.get("/:id", async (req, res) => {
  const id = req.params.id;

  const record = await storage.markClicked(id);

  console.log("Review Link Clicked:", id);

  if (!record) {
    return res.status(404).send("Invalid review link.");
  }

  res.redirect(DEMO_BUSINESS.googleReviewUrl);
});

module.exports = router;