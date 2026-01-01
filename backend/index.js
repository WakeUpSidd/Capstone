/**
 * @file index.js
 * @description Entry point of the application. Initializes server, DB connection, and middleware.
 */

require("dotenv").config();
const express = require("express");
const connectDB = require("./config/db");
const expressConfig = require("./config/expressConfig");
const routes = require("./routes/index");
const { verifyToken } = require("./middlewares/auth");

const app = express();

// Connect to MongoDB
connectDB();

// Apply express middleware and config
expressConfig(app);

// Mount routes
app.use("/", routes);

/**
 * @route   GET /healthz
 * @desc    Public health check endpoint for Render/uptime monitors
 * @access  Public
 */
app.get("/healthz", (req, res) => {
	// Lightweight readiness info (no auth). Useful for Render health checks.
	const mongoose = require("mongoose");
	return res.status(200).json({
		ok: true,
		uptimeSec: Math.round(process.uptime()),
		dbReadyState: mongoose.connection?.readyState, // 0=disconnected, 1=connected, 2=connecting, 3=disconnecting
	});
});

/**
 * @route   GET /
 * @desc    Simple public root endpoint (useful for Render default health checks)
 * @access  Public
 */
app.get("/", (req, res) => {
	return res.status(200).send("OK");
});

/**
 * @route   GET /app
 * @desc    Render index page after token verification (legacy)
 * @access  Private
 */
app.get("/app", verifyToken, (req, res) => {
	res.render("index", { user: req.user || null });
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
	console.log(`Server is running on port ${PORT}`);
});
