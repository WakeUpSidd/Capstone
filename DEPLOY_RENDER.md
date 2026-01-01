## Render redeploy guide (this repo)

This project has **3 deployable components**:
- **Frontend**: `frontend/` (Vite/React static site)
- **Backend**: `backend/` (Node/Express API)
- **FastAPI**: `viz_insight_pipeline/` (Python FastAPI service called by backend)

---

## 1) Backend (Node/Express) – Render Web Service

- **Root Directory**: `backend`
- **Build Command**: `npm ci`
- **Start Command**: `npm start`
- **Health Check Path**: `/healthz` *(returns 200 without auth)*

### Required environment variables
- **`CONNECTION_STRING`**: MongoDB connection string (MongoDB Atlas recommended)
- **`JWT_SECRET`**: JWT signing secret (long random string)
- **`FASTAPI_URL`**: Base URL of your FastAPI service (example: `https://<fastapi>.onrender.com`)

### Recommended environment variables
- **`CLIENT_ORIGINS`**: Comma-separated list of allowed frontend origins (especially if using a custom domain)
- **`SESSION_SECRET`**: Session secret (if you rely on `express-session`)
- **`LOG_LEVEL`**: `INFO` / `DEBUG`
- **`FASTAPI_TIMEOUT_MS`**: Default `180000`

### Optional (only if you use these features)
- **Email verification**: `EMAIL_USER`, `EMAIL_PASS`
- **Cloudinary uploads**: `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET`

See `backend/env.example`.

---

## 2) FastAPI (Python) – Render Web Service

- **Root Directory**: `viz_insight_pipeline`
- **Build Command**: `pip install -r requirements.txt`
- **Start Command**: `uvicorn app.main:app --host 0.0.0.0 --port $PORT`
- **Health Check Path**: `/healthz` *(or `/`)* *(both return 200)*

### Required environment variables
- **`GEMINI_API_KEY`** (or `LLM_API_KEY`): Gemini API key
- **`GEMINI_MODEL`**: model name (example: `gemini-2.5-flash`)

See `viz_insight_pipeline/env.example`.

---

## 3) Frontend (Vite/React) – Render Static Site

- **Root Directory**: `frontend`
- **Build Command**: `npm ci && npm run build`
- **Publish Directory**: `dist`

### Required environment variables (build-time)
- **`VITE_API_BASE_URL`**: must point to your backend `/api` base  
  Example: `https://<backend>.onrender.com/api`

The frontend build **fails fast** if this isn’t set (see `frontend/scripts/validate-env.mjs`).

See `frontend/env.example`.

---

## Wiring checklist (most common redeploy mistakes)

- **Backend → FastAPI**: set `FASTAPI_URL=https://<fastapi>.onrender.com` on the backend service
- **Frontend → Backend**: set `VITE_API_BASE_URL=https://<backend>.onrender.com/api` on the frontend static site
- **CORS**: if you use custom domains, set `CLIENT_ORIGINS=https://<your-frontend-domain>` on the backend

---

## What NOT to commit

- Any real secrets (`.env`, API keys, passwords)
- `node_modules/`, `venv/`, `runs/`, `dist/`, `build/` (already covered by `.gitignore`)


