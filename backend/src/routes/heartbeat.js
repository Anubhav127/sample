/**
 * heartbeat.js
 * Receives periodic heartbeat payloads from the mock agent.
 * Logs the data and acknowledges.
 */

const { Router } = require("express");
const router = Router();

router.post("/", (req, res) => {
  const { hostname, platform, version, timestamp, data } = req.body;

  console.log("─────────────────────────────────────────");
  console.log(`[HEARTBEAT] Received at ${new Date().toISOString()}`);
  console.log(`  Hostname  : ${hostname || "unknown"}`);
  console.log(`  Platform  : ${platform || "unknown"}`);
  console.log(`  Version   : ${version || "unknown"}`);
  console.log(`  Timestamp : ${timestamp || "unknown"}`);
  console.log(`  Data      :`, data || {});
  console.log("─────────────────────────────────────────");

  return res.status(200).json({ success: true, message: "Heartbeat received." });
});

module.exports = router;
