// Fail fast on CI/Render builds if required env vars are missing.
// This prevents deploying a frontend that points to the wrong backend.

const required = ["VITE_API_BASE_URL"];
const missing = required.filter((k) => !process.env[k] || String(process.env[k]).trim() === "");

if (missing.length) {
  // eslint-disable-next-line no-console
  console.error(
    `Missing required environment variables for build: ${missing.join(
      ", "
    )}\n` +
      "Set these in Render (Static Site -> Environment) before deploying.\n" +
      "Example: VITE_API_BASE_URL=https://your-backend.onrender.com/api"
  );
  process.exit(1);
}

// Optional guardrail: warn (but don't fail) if the value doesn't include `/api`.
// The runtime code will normalize it to end with `/api`, but this warning avoids confusion.
const raw = String(process.env.VITE_API_BASE_URL).trim();
const normalized = raw.replace(/\/+$/, "");
if (!normalized.endsWith("/api")) {
  // eslint-disable-next-line no-console
  console.warn(
    `Warning: VITE_API_BASE_URL does not end with '/api'. The app will append it automatically.\n` +
      `Current: ${raw}\n` +
      `Recommended: ${normalized}/api`
  );
}


