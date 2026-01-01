const axios = require('axios');
const FormData = require('form-data');

function resolveFastApiBase() {
	// Prefer explicit env vars; allow multiple names for flexibility
	const base =
		process.env.FASTAPI_URL ||
		process.env.LLM_API_URL ||
		process.env.LLM_URL ||
		null;

	if (base) return base;

	// In development, fall back to localhost; in production, force configuration
	if (process.env.NODE_ENV !== 'production') {
		console.warn('FASTAPI_URL not set; falling back to http://localhost:8000');
		return 'http://localhost:8000';
	}

	throw new Error('FASTAPI_URL is not configured. Set FASTAPI_URL to your deployed LLM/FastAPI endpoint.');
}

function buildFastApiUrl(endpointPath) {
	const raw = resolveFastApiBase();
	let urlObj;
	try {
		urlObj = new URL(raw);
	} catch (e) {
		try {
			urlObj = new URL(`http://${raw}`);
		} catch (e2) {
			const msg = `Invalid FASTAPI_URL: ${raw}`;
			console.error(msg);
			throw new Error(msg);
		}
	}

	const wanted = String(endpointPath || '').startsWith('/') ? String(endpointPath) : `/${endpointPath}`;
	let normalizedPath = urlObj.pathname.replace(/\/+$/, '');
	// If FASTAPI_URL already includes a known endpoint, strip it.
	if (normalizedPath.endsWith('/analyze')) normalizedPath = normalizedPath.slice(0, -('/analyze'.length));
	if (normalizedPath.endsWith('/feedback')) normalizedPath = normalizedPath.slice(0, -('/feedback'.length));
	if (!normalizedPath.endsWith(wanted)) {
		normalizedPath = normalizedPath.replace(/\/+$/, '') + wanted;
	}
	urlObj.pathname = normalizedPath;
	return urlObj.toString();
}

function isReadableStream(obj) {
	return obj && typeof obj.pipe === 'function' && (typeof obj.read === 'function' || typeof obj._read === 'function');
}

function truncateString(s, n = 200) {
	if (typeof s !== 'string') return s;
	return s.length > n ? `${s.slice(0, n)}... [truncated ${s.length - n} chars]` : s;
}

async function callFastAPIAnalyze(userQuery, fileBuffer, fileName, sessionId) {
	const FASTAPI_URL = buildFastApiUrl('/analyze');

	const isBuffer = Buffer.isBuffer(fileBuffer);
	const isStream = isReadableStream(fileBuffer);
	if (!isBuffer && !isStream) throw new Error('fileBuffer must be a Buffer or readable stream');

	const name = (fileName || 'dataset.csv').toLowerCase();
	if (!name.endsWith('.csv')) throw new Error('fileName must have a .csv extension');

	const form = new FormData();
	// Align field names with FastAPI endpoint expecting 'user_text' and 'files'
	form.append('user_text', userQuery);
	form.append('files', fileBuffer, { filename: fileName || 'dataset.csv', contentType: 'text/csv' });

	const headers = { ...form.getHeaders() };
	if (sessionId) headers['X-Session-ID'] = sessionId;

	try {
		const resp = await axios.post(FASTAPI_URL, form, {
			headers,
			maxBodyLength: Infinity,
			maxContentLength: Infinity,
			timeout: Number(process.env.FASTAPI_TIMEOUT_MS || 180000),
		});
		return resp.data;
	} catch (err) {
		const respData = err.response?.data;
		const safeRespData = typeof respData === 'string'
			? truncateString(respData, 500)
			: (respData && typeof respData === 'object')
				? Object.keys(respData).length > 0 ? `[object with keys: ${Object.keys(respData).slice(0, 10).join(', ')}]` : '{}'
				: respData;

		console.error('FastAPI call failed:', {
			message: err.message,
			code: err.code,
			status: err.response?.status,
			url: FASTAPI_URL,
			responseData: safeRespData,
		});

		const clientMsg = err.response?.data?.detail || err.response?.data?.error || err.message || 'Error calling FastAPI';
		const e = new Error(clientMsg);
		e.status = err.response?.status;
		e.code = err.code;
		e.cause = err;
		throw e;
	}
}

async function callFastAPIFeedback(armId, reward, sessionId) {
	const FASTAPI_URL = buildFastApiUrl('/feedback');
	const headers = { 'Content-Type': 'application/json' };
	if (sessionId) headers['X-Session-ID'] = sessionId;

	try {
		const resp = await axios.post(FASTAPI_URL, { arm_id: armId, reward }, { headers, timeout: 30000 });
		return resp.data;
	} catch (err) {
		console.error('FastAPI feedback call failed:', {
			message: err.message,
			code: err.code,
			status: err.response?.status,
			url: FASTAPI_URL,
		});
		const clientMsg = err.response?.data?.detail || err.response?.data?.error || err.message || 'Error calling FastAPI feedback';
		const e = new Error(clientMsg);
		e.status = err.response?.status;
		e.code = err.code;
		e.cause = err;
		throw e;
	}
}

module.exports = { callFastAPIAnalyze, callFastAPIFeedback };