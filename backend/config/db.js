/**
 * @file config/db.js
 * @description MongoDB connection logic using mongoose.
 */

const mongoose = require("mongoose");

/**
 * Connects to the MongoDB database using connection string from environment.
 */
const connectDB = async () => {
	try {
		const uri = process.env.CONNECTION_STRING;
		if (!uri) {
			console.error(
				"DB CONNECTION ERROR: CONNECTION_STRING env var is not set. Configure it in Render Environment."
			);
			process.exit(1);
		}

		const connect = await mongoose.connect(uri);
		console.log(
			"DATABASE CONNECTED:",
			connect.connection.host,
			connect.connection.name
		);
	} catch (err) {
		console.error("DB CONNECTION ERROR:", err.message);
		process.exit(1);
	}
};

module.exports = connectDB;
