/**
 * @file services/banditService.js
 * @description Thompson Sampling bandit logic using MongoDB for per-chat state.
 */
const BanditChatState = require("../models/banditChatStateSchema");
const logger = require("../config/logger");

// Define available arms (prompt/temperature variants)
const ARMS = [
	{
		armId: "unified_base",
		stage: "unified",
		modelName: process.env.GEMINI_MODEL || "gemini-2.5-flash",
		notes: "Base unified prompt",
		temperature: 0.1,
	},
	{
		armId: "unified_strict_json",
		stage: "unified",
		modelName: process.env.GEMINI_MODEL || "gemini-2.5-flash",
		notes: "Stricter JSON-only response",
		temperature: 0.05,
	},
];

/**
 * Sample from Beta distribution using Box-Muller approximation.
 * For simplicity, we use a gamma-based approach.
 */
function sampleBeta(alpha, beta) {
	// Use the gamma sampling method: Beta(a,b) = Gamma(a,1) / (Gamma(a,1) + Gamma(b,1))
	const gammaA = sampleGamma(alpha);
	const gammaB = sampleGamma(beta);
	return gammaA / (gammaA + gammaB);
}

/**
 * Sample from Gamma distribution using Marsaglia and Tsang's method.
 */
function sampleGamma(shape) {
	if (shape < 1) {
		// For shape < 1, use: Gamma(shape) = Gamma(shape+1) * U^(1/shape)
		return sampleGamma(shape + 1) * Math.pow(Math.random(), 1 / shape);
	}

	const d = shape - 1 / 3;
	const c = 1 / Math.sqrt(9 * d);

	while (true) {
		let x, v;
		do {
			x = randn();
			v = 1 + c * x;
		} while (v <= 0);

		v = v * v * v;
		const u = Math.random();

		if (u < 1 - 0.0331 * (x * x) * (x * x)) {
			return d * v;
		}

		if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) {
			return d * v;
		}
	}
}

/**
 * Standard normal random using Box-Muller transform.
 */
function randn() {
	const u1 = Math.random();
	const u2 = Math.random();
	return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

/**
 * Get or initialize bandit state for a chat.
 */
async function getOrCreateBanditState(chatId) {
	let state = await BanditChatState.findOne({ chat: chatId });

	if (!state) {
		// Initialize with default arms
		state = new BanditChatState({
			chat: chatId,
			arms: ARMS.map((arm) => ({
				armId: arm.armId,
				alpha: 1.0,
				beta: 1.0,
				pulls: 0,
			})),
		});
		try {
			await state.save();
			logger.info("banditService: Created new bandit state", {
				chatId: String(chatId),
			});
		} catch (err) {
			// Handle race: two requests might try to create the same chat state at once
			if (err?.code === 11000) {
				state = await BanditChatState.findOne({ chat: chatId });
			} else {
				throw err;
			}
		}
	} else {
		// Ensure all arms exist (in case new arms were added)
		const existingArmIds = new Set(state.arms.map((a) => a.armId));
		let modified = false;
		for (const arm of ARMS) {
			if (!existingArmIds.has(arm.armId)) {
				state.arms.push({
					armId: arm.armId,
					alpha: 1.0,
					beta: 1.0,
					pulls: 0,
				});
				modified = true;
			}
		}
		if (modified) {
			await state.save();
		}
	}

	return state;
}

/**
 * Choose an arm using Thompson Sampling for a given chat.
 * Returns the full arm config (armId, modelName, temperature).
 */
async function chooseArm(chatId, stage = "unified") {
	const state = await getOrCreateBanditState(chatId);

	// Filter arms by stage
	const candidateArmConfigs = ARMS.filter((a) => a.stage === stage);
	if (!candidateArmConfigs.length) {
		throw new Error(`No arms found for stage: ${stage}`);
	}

	// Sample from Beta distribution for each arm
	const samples = [];
	const sampleMap = {};

	for (const armConfig of candidateArmConfigs) {
		const armStats = state.arms.find((a) => a.armId === armConfig.armId) || {
			alpha: 1.0,
			beta: 1.0,
			pulls: 0,
		};
		const sample = sampleBeta(armStats.alpha, armStats.beta);
		samples.push({ armConfig, sample });
		sampleMap[armConfig.armId] = sample;
	}

	// Pick the arm with the highest sample
	samples.sort((a, b) => b.sample - a.sample);
	const chosen = samples[0].armConfig;
	const chosenStats = state.arms.find((a) => a.armId === chosen.armId);

	logger.info("banditService: Arm chosen", {
		chatId: String(chatId),
		stage,
		armId: chosen.armId,
		alpha: chosenStats?.alpha || 1.0,
		beta: chosenStats?.beta || 1.0,
		pulls: chosenStats?.pulls || 0,
		samples: sampleMap,
	});

	return {
		armId: chosen.armId,
		modelName: chosen.modelName,
		temperature: chosen.temperature,
		notes: chosen.notes,
	};
}

/**
 * Update bandit state after receiving feedback.
 * reward: 1 for helpful, 0 for not helpful.
 */
async function updateArm(chatId, armId, reward) {
	const state = await getOrCreateBanditState(chatId);

	const armStats = state.arms.find((a) => a.armId === armId);
	if (!armStats) {
		logger.warn("banditService: Unknown arm for update", {
			chatId: String(chatId),
			armId,
		});
		return null;
	}

	const before = { alpha: armStats.alpha, beta: armStats.beta, pulls: armStats.pulls };

	armStats.pulls += 1;
	if (reward === 1) {
		armStats.alpha += 1;
	} else {
		armStats.beta += 1;
	}

	await state.save();

	const after = { alpha: armStats.alpha, beta: armStats.beta, pulls: armStats.pulls };

	logger.info("banditService: Arm updated", {
		chatId: String(chatId),
		armId,
		reward,
		before,
		after,
	});

	return after;
}

/**
 * Get current bandit stats for a user (for debugging/inspection).
 */
async function getBanditStats(chatId) {
	const state = await getOrCreateBanditState(chatId);
	return state.arms.reduce((acc, arm) => {
		acc[arm.armId] = {
			alpha: arm.alpha,
			beta: arm.beta,
			pulls: arm.pulls,
		};
		return acc;
	}, {});
}

module.exports = {
	ARMS,
	chooseArm,
	updateArm,
	getBanditStats,
	getOrCreateBanditState,
};
