/**
 * @file models/banditChatStateSchema.js
 * @description Mongoose schema for per-chat Thompson Sampling bandit state.
 * Stores alpha/beta/pulls for each arm, keyed by chat.
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

// Per-chat bandit state
const BanditChatStateSchema = new mongoose.Schema(
	{
		chat: {
			type: mongoose.Schema.Types.ObjectId,
			ref: "Chat",
			required: true,
			unique: true, // One bandit state document per chat
		},
		arms: {
			type: [ArmStatsSchema],
			default: [],
		},
	},
	{ timestamps: true }
);

// Note: `unique: true` on `chat` already creates an index in MongoDB.

const BanditChatState =
	mongoose.models.BanditChatState ||
	mongoose.model("BanditChatState", BanditChatStateSchema);

module.exports = BanditChatState;


