/**
 * index.js
 * Mock Agent Backend — Entry point
 */

require("dotenv").config();

const express = require("express");
const heartbeatRoute = require("./routes/heartbeat");
const uninstallRoute = require("./routes/uninstall");

const app = express();
const PORT = process.env.PORT || 3000;

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(express.json());

// ── Routes ────────────────────────────────────────────────────────────────────
app.use("/heartbeat", heartbeatRoute);
app.use("/verify-uninstall", uninstallRoute);

// ── Health check ──────────────────────────────────────────────────────────────
app.get("/health", (req, res) => {
  res.status(200).json({ status: "ok", uptime: process.uptime() });
});

// ── 404 fallback ──────────────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ message: "Route not found." });
});

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`[SERVER] Mock Agent Backend running on port ${PORT}`);
  console.log(`[SERVER] Started at ${new Date().toISOString()}`);
  console.log(`  POST /heartbeat`);
  console.log(`  POST /verify-uninstall`);
  console.log(`  GET  /health`);
});
