/**
 * @file models/banditStateSchema.js
 * @description DEPRECATED: per-user Thompson Sampling bandit state.
 * The project now uses per-chat state via `banditChatStateSchema.js`.
 */
const mongoose = require("mongoose");

// Schema for individual arm statistics
const ArmStatsSchema = new mongoose.Schema(
	{
		armId: {
			type: String,
			required: true,
		},
		alpha: {
			type: Number,
			default: 1.0, // Prior successes (Beta distribution)
		},
		beta: {
			type: Number,
			default: 1.0, // Prior failures (Beta distribution)
		},
		pulls: {
			type: Number,
			default: 0,
		},
	},
	{ _id: false }
);

// Per-user bandit state
const BanditStateSchema = new mongoose.Schema(
	{
		user: {
			type: mongoose.Schema.Types.ObjectId,
			ref: "User",
			required: true,
			unique: true, // One bandit state document per user
		},
		arms: {
			type: [ArmStatsSchema],
			default: [],
		},
	},
	{ timestamps: true }
);

// Index for fast lookup by user
BanditStateSchema.index({ user: 1 });

const BanditState =
	mongoose.models.BanditState || mongoose.model("BanditState", BanditStateSchema);

module.exports = BanditState;
