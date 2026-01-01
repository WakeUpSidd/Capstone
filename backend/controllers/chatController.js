require("dotenv").config();
const path = require("path");
const Project = require("../models/projectSchema");
const Team = require("../models/teamSchema");
const Chat = require("../models/chatSchema");
const Message = require("../models/messageSchema");
const axios = require("axios");
const logger = require("../config/logger");
const banditService = require("../services/banditService");

// Configuration from environment
const FASTAPI_URL =
	process.env.FASTAPI_URL ||
	process.env.LLM_API_URL ||
	process.env.LLM_URL ||
	(process.env.NODE_ENV !== "production" ? "http://localhost:8000" : null);
const FASTAPI_TIMEOUT = parseInt(process.env.FASTAPI_TIMEOUT_MS || "180000", 10);

/**
 * Helper to normalize selectedDatasets input into an array of strings.
 * Handles JSON strings, comma-separated strings, single values, or arrays.
 */
function parseSelectedDatasets(input) {
	if (!input) return [];
	if (Array.isArray(input)) return input;

	if (typeof input === "string") {
		try {
			// Try parsing as JSON (e.g. "['id1', 'id2']")
			const parsed = JSON.parse(input);
			if (Array.isArray(parsed)) return parsed;
			return [parsed];
		} catch (_) {
			// Fallback: comma-separated (e.g. "id1,id2")
			return input.includes(",")
				? input.split(",").map((s) => s.trim()).filter(Boolean)
				: [input.trim()];
		}
	}
	return [input];
}

async function chatHandler(req, res) {
	try {
		const { chatId, projectId, content } = req.body;
		
		// 1. Process Files: Only CSVs, store as Base64
		const incomingFiles = req.files || [];
		const tempFiles = incomingFiles
			.filter((f) => {
				const ext = path.extname(f.originalname || "").toLowerCase();
				return ext === ".csv" || f.mimetype === "text/csv";
			})
			.map((f) => ({
				originalname: f.originalname,
				mimetype: f.mimetype,
				size: f.size,
				headText: "", 
				bufferBase64: f.buffer?.toString("base64") || null,
			}));

	// 2. Normalize Datasets
	const selectedDatasets = parseSelectedDatasets(req.body.selectedDatasets);

	// 3. Validation: Must have ProjectID and at least one form of content
	const hasContent = content?.trim();
	const hasFiles = tempFiles.length > 0;
	const hasDatasets = selectedDatasets.length > 0;		if (!projectId || (!hasContent && !hasFiles && !hasDatasets)) {
			return res.status(400).json({
				error: "projectId and at least one of content, selectedDatasets, or files are required.",
			});
		}

		// 4. Load Project & Check Access
		const project = await Project.findById(projectId).populate({
			path: "team",
			populate: { path: "members.user", select: "_id role" },
		});
		if (!project) return res.status(404).json({ error: "Project not found." });

		const team = project.team;
		if (!team) return res.status(404).json({ error: "Team not found." });

		const { userId, organization, role: globalRole } = req.user;

		if (globalRole !== "superadmin") {
			if (team.organization.toString() !== organization.toString()) {
				return res.status(403).json({ error: "Not in this organization." });
			}
			const memberEntry = team.members.find(
				(m) => m.user._id.toString() === userId.toString()
			);
			if (!memberEntry) {
				return res.status(403).json({ error: "Not a member of this team." });
			}
		}

		// 5. Get or Create Chat
		let chat;
		if (chatId) {
			chat = await Chat.findOne({ _id: chatId, project: projectId });
		} else {
			// Fallback: find any chat for project or create new
			chat = await Chat.findOne({ project: projectId });
			if (!chat) {
				chat = await Chat.create({
					project: projectId,
					title: "New chat",
					messages: [],
				});
				project.chats.push(chat._id);
				await project.save();
			}
		}

		if (!chat) {
			return res.status(404).json({ error: "Chat not found or could not be created." });
		}

	// 6. Save User Message
	const userMsg = await Message.create({
		chat: chat._id,
		sender: "user",
		content: content?.trim() || null,
		selectedDatasets,
		tempFiles,
	});

	chat.messages.push(userMsg._id);
	await chat.save();		return res.json({
			message: "User message saved.",
			chatId: chat._id,
		});
	} catch (err) {
		logger.error("chatHandler: Error processing chat message", {
			error: err.message,
			stack: err.stack?.slice(0, 300),
			projectId: req.body?.projectId,
			chatId: req.body?.chatId,
		});
		return res.status(500).json({ error: "Internal server error." });
	}
}
async function aiReplyHandler(req, res) {
	const startTime = Date.now();
	try {
		if (!FASTAPI_URL) {
			return res.status(500).json({
				error:
					"LLM service is not configured. Set FASTAPI_URL (or LLM_API_URL) to your deployed FastAPI endpoint.",
			});
		}

		const { chatId, projectId, content } = req.body;

		logger.info("aiReplyHandler: Processing AI reply request", {
			projectId,
			chatId,
			contentLength: content?.length || 0,
		});

		// 1. Validation
		if (!projectId || !chatId || !content?.trim()) {
			logger.warn("aiReplyHandler: Missing required fields", { projectId, chatId, hasContent: !!content });
			return res
				.status(400)
				.json({ error: "projectId, chatId, and content required." });
		}

		// 2. Load Context (Project, Team, Chat)
		const project = await Project.findById(projectId).populate({
			path: "team",
			populate: { path: "members.user", select: "_id role" },
		});
		if (!project) return res.status(404).json({ error: "Project not found." });

		const chat = await Chat.findById(chatId).populate("messages");
		if (!chat) return res.status(404).json({ error: "Chat not found." });

		const team = project.team;
		if (!team) return res.status(404).json({ error: "Team not found." });

		// 3. Access Control
		const { userId, organization, role: globalRole } = req.user;
		if (globalRole !== "superadmin") {
			if (team.organization.toString() !== organization.toString()) {
				return res.status(403).json({ error: "Not in this organization." });
			}
			const memberEntry = team.members.find(
				(m) => m.user._id.toString() === userId.toString()
			);
			if (!memberEntry) {
				return res.status(403).json({ error: "Not a member of this team." });
			}
		}

	// 4. Context Retrieval:
	//    a) Collect ALL datasets ever selected in this chat history
	//    b) Collect last 5 messages (User + AI) for conversation memory
	const allMessages = chat.messages || [];

	// a) Unique Dataset IDs from entire history
	const allDatasetIds = new Set();
	allMessages.forEach((msg) => {
		if (msg.selectedDatasets && msg.selectedDatasets.length > 0) {
			msg.selectedDatasets.forEach((dsId) => allDatasetIds.add(String(dsId)));
		}
	});		// b) Last 5 messages (excluding the one we are about to generate)
		const recentHistory = allMessages.slice(-5).map((msg) => ({
			role: msg.sender === "user" ? "user" : "assistant",
			content: msg.content,
		}));

		// 5. Prepare Data for FastAPI
		// Collect all uploaded CSV files from every user message in the chat
		const allUploadedFiles = [];
		allMessages.forEach((msg) => {
			if (msg.sender === "user" && Array.isArray(msg.tempFiles)) {
				msg.tempFiles.forEach((f) => {
					if (f && f.bufferBase64) {
						allUploadedFiles.push(f);
					}
				});
			}
		});

	// Resolve Dataset IDs to actual Dataset Objects (Name, URL)
	const datasetsContext = project.datasets
		.filter((d) => allDatasetIds.has(String(d._id)))
		.map((d) => ({
			name: d.name,
			url: d.url,
		}));
	
	// Include all uploaded files in datasets context with a descriptive label
	allUploadedFiles.forEach((file, index) => {
		datasetsContext.push({
			name: file.originalname || `Upload ${index + 1}`,
			url: "Current Upload",
		});
	});

	// FastAPI requires at least one dataset URL or an uploaded CSV file
	const datasetUrlCount = datasetsContext.filter(
		(d) => d && d.url && d.url !== "Current Upload"
	).length;
	const uploadedFileCount = allUploadedFiles.length;
	if (datasetUrlCount === 0 && uploadedFileCount === 0) {
		return res.status(400).json({
			error:
				"No datasets selected or uploaded for this chat. Please select a dataset for the chat (or upload a CSV) and try again.",
		});
	}

	// 6. Choose arm using per-chat bandit (Thompson Sampling)
	const chosenArm = await banditService.chooseArm(chat._id, "unified");
	logger.info("aiReplyHandler: Bandit arm chosen for chat", {
		chatId: String(chat._id),
		armId: chosenArm.armId,
		temperature: chosenArm.temperature,
	});

	// 7. Call FastAPI with arm configuration
	const analysisContext = {
		// Rename 'history' to 'messages' to match analyzer expectation
		messages: recentHistory,
		datasets: datasetsContext,
	};
	const contextString = JSON.stringify(analysisContext);

	logger.info("aiReplyHandler: Preparing FastAPI request", {
		userTextPreview: content.trim().substring(0, 100),
		datasetCount: datasetsContext.length,
		historyCount: recentHistory.length,
		uploadedFileCount: allUploadedFiles.length,
		armId: chosenArm.armId,
	});
	logger.debug("aiReplyHandler: Context details", {
		context: contextString.substring(0, 500),
		datasets: datasetsContext.map(d => d.name),
	});

	const FormData = require("form-data");
	const form = new FormData();
	form.append("user_text", content.trim());
	form.append("context", contextString);
	// Pass arm configuration to FastAPI so it uses the arm we selected
	form.append("arm_id", chosenArm.armId);
	form.append("arm_temperature", String(chosenArm.temperature));
	form.append("arm_model", chosenArm.modelName);
	// Attach all uploaded CSV files to the form
		allUploadedFiles.forEach((file) => {
			const buffer = Buffer.from(file.bufferBase64, "base64");
			const filename = file.originalname || "dataset.csv";
			// Use 'files' field name to match FastAPI list parameter
			form.append("files", buffer, { filename, contentType: "text/csv" });
		});

		const fastapiUrl = FASTAPI_URL;
		let urlObj;
		try {
			urlObj = new URL(fastapiUrl);
		} catch (e) {
			urlObj = new URL(`http://${fastapiUrl}`);
		}
		
		// Ensure we don't double-append /analyze if it's already in the env var
		if (!urlObj.pathname.endsWith("/analyze")) {
			urlObj.pathname = urlObj.pathname.replace(/\/+$/, "") + "/analyze";
		}
		const apiUrl = urlObj.toString();
		
		logger.info("aiReplyHandler: Calling FastAPI", { url: apiUrl });

		const response = await axios.post(apiUrl, form, {
			headers: {
				...form.getHeaders(),
			},
			maxBodyLength: Infinity,
			maxContentLength: Infinity,
			timeout: FASTAPI_TIMEOUT,
		});

		const analysis = response.data;

		// Ensure arm_id in response matches what we chose (backend is source of truth)
		analysis.arm_id = chosenArm.armId;

		// Log a concise summary of the FastAPI analysis response
		logger.info("aiReplyHandler: FastAPI response received", {
			arm_id: analysis?.arm_id,
			intent: analysis?.intent,
			graph_type: analysis?.graph_type,
			hasPlotly: !!analysis?.plotly,
			hasInsights: !!analysis?.insights,
			hasError: !!analysis?.error,
			durationMs: Date.now() - startTime,
		});
		
		if (analysis?.error) {
			logger.warn("aiReplyHandler: FastAPI returned error", {
				error: analysis.error?.substring(0, 300),
			});
		}

		// 8. Save Bot Message with armId for feedback tracking
		const botMsg = await Message.create({
			chat: chat._id,
			sender: "chatbot",
			content: JSON.stringify(analysis), // Save raw response
			armId: chosenArm.armId, // Store which arm generated this response
			feedback: null, // No feedback yet
		});
		chat.messages.push(botMsg._id);
		await chat.save();

		// Include message ID in response so frontend can reference it for feedback
		analysis.messageId = botMsg._id;

		return res.json(analysis);
	} catch (err) {
		const durationMs = Date.now() - startTime;
		const responseData = err.response?.data;
		const safeResponseData =
			typeof responseData === "string"
				? responseData.substring(0, 500)
				: responseData && typeof responseData === "object"
					? `[object keys: ${Object.keys(responseData).slice(0, 15).join(", ")}]`
					: responseData;
		logger.error("aiReplyHandler: Error processing AI reply", {
			error: err.message,
			stack: err.stack?.slice(0, 300),
			projectId: req.body?.projectId,
			chatId: req.body?.chatId,
			durationMs,
			responseStatus: err.response?.status,
			responseData: safeResponseData,
			code: err.code,
		});

		// If FastAPI responded, propagate its status/details to the client (helps debugging)
		if (err.response?.status) {
			const detail =
				err.response?.data?.detail ||
				err.response?.data?.error ||
				(typeof err.response?.data === "string" ? err.response.data : null) ||
				err.message ||
				"Upstream error";
			return res.status(err.response.status).json({ error: detail });
		}

		// Network/timeouts talking to FastAPI
		if (err.code === "ECONNABORTED") {
			return res.status(504).json({
				error: "LLM service timed out. Try again, or increase FASTAPI_TIMEOUT_MS.",
			});
		}
		if (err.code === "ENOTFOUND" || err.code === "ECONNREFUSED") {
			return res.status(502).json({
				error:
					"Unable to reach the LLM service. Check FASTAPI_URL and that the FastAPI service is running.",
			});
		}

		return res.status(500).json({ error: err.message || "Internal server error." });
	}
}

async function renameChat(req, res) {
	try {
		const { chatId, projectId, title } = req.body;
		if (!chatId || !projectId || !title || !title.trim()) {
			return res
				.status(400)
				.json({ error: "chatId, projectId and title are required." });
		}

		// Load project and verify access (same checks as other handlers)
		const project = await Project.findById(projectId).populate({
			path: "team",
			populate: { path: "members.user", select: "_id role" },
		});
		if (!project) return res.status(404).json({ error: "Project not found." });

		const team = project.team;
		if (!team) {
			return res.status(404).json({ error: "Team not found." });
		}

		const { userId, organization, role: globalRole } = req.user;
		if (globalRole !== "superadmin") {
			if (team.organization.toString() !== organization.toString()) {
				return res.status(403).json({ error: "Not in this organization." });
			}
			const memberEntry = team.members.find(
				(m) => m.user._id.toString() === userId.toString()
			);
			if (!memberEntry) {
				return res.status(403).json({ error: "Not a member of this team." });
			}
		}

		const updated = await Chat.findOneAndUpdate(
			{ _id: chatId, project: projectId },
			{ title: title.trim() },
			{ new: true }
		);
		if (!updated) return res.status(404).json({ error: "Chat not found." });

		return res.json({ success: true, chat: updated });
	} catch (err) {
		logger.error("renameChat: Error renaming chat", {
			error: err.message,
			chatId: req.body?.chatId,
			projectId: req.body?.projectId,
		});
		return res.status(500).json({ error: "Internal server error." });
	}
}

async function submitFeedback(req, res) {
	try {
		const { arm_id, reward, messageId, chatId } = req.body || {};

		const armIdStr = arm_id != null ? String(arm_id) : "";
		const rewardNum = Number(reward);
		if (!armIdStr || !Number.isFinite(rewardNum) || (rewardNum !== 0 && rewardNum !== 1)) {
			return res.status(400).json({
				error: "arm_id and reward (0 or 1) are required.",
			});
		}

		const { userId, organization, role: globalRole } = req.user;

		// Resolve effective chatId (bandit is per-chat)
		let effectiveChatId = chatId ? String(chatId) : null;
		let effectiveArmId = armIdStr;
		let message = null;

		if (messageId) {
			message = await Message.findById(messageId);
			if (!message) {
				return res.status(404).json({ error: "Message not found." });
			}
			if (message.sender !== "chatbot") {
				return res.status(400).json({
					error: "Feedback can only be submitted for chatbot messages.",
				});
			}
			effectiveChatId = String(message.chat);
			if (message.armId) {
				if (armIdStr && message.armId !== armIdStr) {
					logger.warn("submitFeedback: arm_id mismatch vs message.armId; using message.armId", {
						messageId: String(messageId),
						requestArmId: armIdStr,
						messageArmId: message.armId,
					});
				}
				effectiveArmId = message.armId;
			}
		}

		if (!effectiveChatId) {
			return res.status(400).json({
				error: "messageId (preferred) or chatId is required to update per-chat bandit state.",
			});
		}

		logger.info("submitFeedback: Received bandit feedback", {
			arm_id: effectiveArmId,
			reward: rewardNum,
			messageId,
			chatId: effectiveChatId,
			user_id: String(userId),
		});

		// Access control: ensure requester has access to the chat's project/team
		const chat = await Chat.findById(effectiveChatId);
		if (!chat) return res.status(404).json({ error: "Chat not found." });

		const project = await Project.findById(chat.project).populate({
			path: "team",
			populate: { path: "members.user", select: "_id role" },
		});
		if (!project) return res.status(404).json({ error: "Project not found." });

		const team = project.team;
		if (!team) return res.status(404).json({ error: "Team not found." });

		if (globalRole !== "superadmin") {
			if (team.organization.toString() !== organization.toString()) {
				return res.status(403).json({ error: "Not in this organization." });
			}
			const memberEntry = team.members.find(
				(m) => m.user._id.toString() === userId.toString()
			);
			if (!memberEntry) {
				return res.status(403).json({ error: "Not a member of this team." });
			}
		}

		// Update the message's feedback status in database (if messageId provided)
		if (messageId) {
			const nextFeedback = rewardNum === 1 ? "up" : "down";

			// Atomic: only set feedback if it is still null
			const updated = await Message.findOneAndUpdate(
				{ _id: messageId, feedback: null },
				{ $set: { feedback: nextFeedback } },
				{ new: true }
			);

			if (!updated) {
				// Either already rated or message missing
				const existing = await Message.findById(messageId);
				if (!existing) return res.status(404).json({ error: "Message not found." });
				if (existing.feedback) {
					logger.info("submitFeedback: Message already has feedback, skipping update", {
						messageId,
						existingFeedback: existing.feedback,
					});
					return res.json({
						status: "already_rated",
						arm_id: effectiveArmId,
						reward: rewardNum,
						existingFeedback: existing.feedback,
					});
				}
			} else {
				logger.info("submitFeedback: Message feedback status updated", {
					messageId,
					feedback: updated.feedback,
				});
			}
		}

		// Update bandit state in MongoDB (per-chat learning)
		const newStats = await banditService.updateArm(
			effectiveChatId,
			effectiveArmId,
			rewardNum
		);

		logger.info("submitFeedback: Bandit state updated in database", {
			arm_id: effectiveArmId,
			reward: rewardNum,
			chatId: effectiveChatId,
			new_stats: newStats,
		});

		return res.json({
			status: "success",
			arm_id: effectiveArmId,
			reward: rewardNum,
			chatId: effectiveChatId,
			new_stats: newStats,
		});
	} catch (err) {
		logger.error("submitFeedback: Error submitting feedback", {
			error: err.message,
			arm_id: req.body?.arm_id,
		});
		return res.status(500).json({ error: err.message || "Failed to submit feedback." });
	}
}

const getChatHistory = async (req, res) => {
	try {
		const { projectId, chatId } = req.params;
		const { userId, organization, role: globalRole } = req.user;

		const project = await Project.findById(projectId).populate({
			path: "team",
			populate: { path: "members.user", select: "_id role" },
		});
		if (!project) return res.status(404).json({ error: "Project not found." });

		const team = project.team;
		if (!team) {
			return res.status(404).json({ error: "Team not found." });
		}

		if (globalRole !== "superadmin") {
			if (team.organization.toString() !== organization.toString()) {
				return res.status(403).json({ error: "Not in this organization." });
			}
			const memberEntry = team.members.find(
				(m) => m.user._id.toString() === userId.toString()
			);
			if (!memberEntry)
				return res.status(403).json({ error: "Not a member of this team." });
		}

		const chat = await Chat.findOne({
			_id: chatId,
			project: project._id,
		}).populate({
			path: "messages",
			options: { sort: { createdAt: 1 } },
		});
		if (!chat) return res.status(404).json({ error: "Chat not found." });

		return res.json({ chat });
	} catch (err) {
		logger.error("getChatHistory: Error fetching chat history", {
			error: err.message,
			projectId: req.params?.projectId,
			chatId: req.params?.chatId,
		});
		return res.status(500).json({ error: "Server error." });
	}
};

const createChatManually = async (req, res) => {
	try {
		const { projectId } = req.body;
		if (!projectId)
			return res.status(400).json({ error: "projectId is required." });

		// Load project with team population for access check
		const project = await Project.findById(projectId).populate({
			path: "team",
			populate: { path: "members.user", select: "_id role" },
		});
		if (!project) return res.status(404).json({ error: "Project not found." });

		const team = project.team;
		if (!team) {
			return res.status(404).json({ error: "Team not found." });
		}

		// Access check
		const { userId, organization, role: globalRole } = req.user;
		if (globalRole !== "superadmin") {
			if (team.organization.toString() !== organization.toString()) {
				return res.status(403).json({ error: "Not in this organization." });
			}
			const memberEntry = team.members.find(
				(m) => m.user._id.toString() === userId.toString()
			);
			if (!memberEntry) {
				return res.status(403).json({ error: "Not a member of this team." });
			}
		}

		const newChat = await Chat.create({
			project: project._id,
			title: "New chat",
			messages: [],
		});
		project.chats.push(newChat._id);
		await project.save();

		return res
			.status(201)
			.json({ message: "New chat created for project.", chat: newChat });
	} catch (err) {
		logger.error("createChatManually: Error creating chat", {
			error: err.message,
			projectId: req.body?.projectId,
		});
		return res.status(500).json({ error: "Server error while creating chat." });
	}
};

/**
 * Get the current user's bandit stats (for debugging/inspection).
 */
async function getBanditStats(req, res) {
	try {
		const { chatId } = req.query || {};
		if (!chatId) {
			return res.status(400).json({ error: "chatId query param is required." });
		}

		const { userId, organization, role: globalRole } = req.user;

		// Access control: ensure requester has access to the chat's project/team
		const chat = await Chat.findById(chatId);
		if (!chat) return res.status(404).json({ error: "Chat not found." });

		const project = await Project.findById(chat.project).populate({
			path: "team",
			populate: { path: "members.user", select: "_id role" },
		});
		if (!project) return res.status(404).json({ error: "Project not found." });

		const team = project.team;
		if (!team) return res.status(404).json({ error: "Team not found." });

		if (globalRole !== "superadmin") {
			if (team.organization.toString() !== organization.toString()) {
				return res.status(403).json({ error: "Not in this organization." });
			}
			const memberEntry = team.members.find(
				(m) => m.user._id.toString() === userId.toString()
			);
			if (!memberEntry) {
				return res.status(403).json({ error: "Not a member of this team." });
			}
		}

		const stats = await banditService.getBanditStats(chatId);
		return res.json({
			chatId: String(chatId),
			arms: banditService.ARMS.map((a) => ({ armId: a.armId, notes: a.notes })),
			stats,
		});
	} catch (err) {
		logger.error("getBanditStats: Error fetching bandit stats", {
			error: err.message,
			userId: req.user?.userId,
			chatId: req.query?.chatId,
		});
		return res.status(500).json({ error: "Server error." });
	}
}

module.exports = {
	chatHandler,
	aiReplyHandler,
	getChatHistory,
	createChatManually,
	renameChat,
	submitFeedback,
	getBanditStats,
};