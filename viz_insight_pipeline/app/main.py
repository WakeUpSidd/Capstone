"""
FastAPI entrypoint with a single /analyze route.

Consolidates all input parsing and data formatting:
- Parses JSON context for datasets and history
- Loads CSV files from uploads and URLs
- Formats conversation history as context summary
- Passes processed data to analyzer
"""

import os
import re
import logging
import sys
from dotenv import load_dotenv, find_dotenv

# Load environment variables from .env file (optional).
# In Render (and other hosts), secrets should be provided via environment variables, not committed .env files.
# For local Windows dev, some editors save .env as UTF-16 — support both UTF-8 and UTF-16 gracefully.
_dotenv_path = find_dotenv(usecwd=True) or None
if _dotenv_path:
    try:
        load_dotenv(_dotenv_path)
    except UnicodeError:
        load_dotenv(_dotenv_path, encoding="utf-16")
else:
    # No .env found; rely on process env
    load_dotenv()

# Configure logging with environment-based level
LOG_LEVEL = os.getenv("LOG_LEVEL", "INFO").upper()
logging.basicConfig(
    level=getattr(logging, LOG_LEVEL, logging.INFO),
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s',
    datefmt='%Y-%m-%d %H:%M:%S'
)
logger = logging.getLogger(__name__)
logger.info("Pipeline starting with LOG_LEVEL=%s", LOG_LEVEL)

from fastapi import FastAPI, UploadFile, File, Form, HTTPException
from fastapi import Request
from fastapi.responses import HTMLResponse, Response
from pydantic import BaseModel
from typing import List, Optional, Dict, Any
import json
import httpx
import io
import pandas as pd

from .schemas import AnalysisResponse
from .analyzer import analyze, update_bandit_feedback

# Configuration from environment with sensible defaults
ROW_LIMIT = int(os.getenv("ROW_LIMIT", "5000"))
ALLOWED_FILE_TYPES = os.getenv("ALLOWED_FILE_TYPES", ".csv").split(",")
MAX_FILE_SIZE_MB = int(os.getenv("MAX_FILE_SIZE_MB", "50"))

app = FastAPI(title="Minimal Analysis Pipeline")

@app.get("/")
def root():
    # Render default health checks may hit "/".
    return {"ok": True, "service": "viz_insight_pipeline"}


@app.get("/healthz")
def healthz():
    return {"ok": True}


_PROFILE_REPORTS_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "runs", "profiles")


def _is_safe_report_id(report_id: str) -> bool:
    # UUID (we use uuid4) format
    return bool(report_id) and bool(re.match(r"^[a-f0-9\-]{36}$", report_id))


@app.get("/profile/{report_id}", response_class=HTMLResponse)
def get_profile_report(report_id: str):
    if not _is_safe_report_id(report_id):
        raise HTTPException(status_code=400, detail="Invalid report_id")

    path = os.path.join(_PROFILE_REPORTS_DIR, f"{report_id}.html")
    if not os.path.exists(path):
        raise HTTPException(
            status_code=404,
            detail=(
                "Report not found. On Render, profile reports stored on local disk may disappear after a restart/redeploy. "
                "Please regenerate the report, or enable PROFILE_STORAGE=cloudinary for persistent links."
            ),
        )

    try:
        with open(path, "r", encoding="utf-8") as f:
            html = f.read()
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

    return HTMLResponse(content=html)


@app.get("/profile/{report_id}/pdf")
def get_profile_report_pdf(report_id: str):
    """Download a profiling report as PDF.

    Uses Playwright (headless Chromium) to print the HTML to PDF.
    This avoids WeasyPrint's native GTK/Pango dependencies on Windows.
    """
    if not _is_safe_report_id(report_id):
        raise HTTPException(status_code=400, detail="Invalid report_id")

    path = os.path.join(_PROFILE_REPORTS_DIR, f"{report_id}.html")
    if not os.path.exists(path):
        raise HTTPException(status_code=404, detail="Report not found")

    try:
        with open(path, "r", encoding="utf-8") as f:
            html = f.read()

        pdf_bytes: bytes | None = None

        # You can force Playwright explicitly with PDF_ENGINE=playwright.
        # ("auto" currently behaves the same as "playwright".)
        pdf_engine = os.getenv("PDF_ENGINE", "auto").strip().lower()
        if pdf_engine not in ("auto", "playwright"):
            pdf_engine = "auto"

        try:
            from playwright.sync_api import sync_playwright  # type: ignore

            with sync_playwright() as p:
                browser = p.chromium.launch(headless=True)
                page = browser.new_page()
                page.set_content(html, wait_until="load")
                pdf_bytes = page.pdf(print_background=True, format="A4")
                browser.close()
            logger.info("PDF generated with Playwright report_id=%s bytes=%d", report_id, len(pdf_bytes))
        except Exception as e:
            logger.error("Playwright PDF generation failed", exc_info=True)
            raise HTTPException(
                status_code=501,
                detail=(
                    "PDF export is not available in this environment. "
                    "Install Playwright and its Chromium browser: `python -m pip install playwright` then `python -m playwright install chromium`. "
                    f"Error: {e}"
                ),
            )

        filename = f"profile_{report_id}.pdf"
        return Response(
            content=pdf_bytes,
            media_type="application/pdf",
            headers={"Content-Disposition": f"attachment; filename=\"{filename}\""},
        )
    except HTTPException:
        raise
    except Exception as e:
        logger.error("Failed to generate PDF", exc_info=True)
        raise HTTPException(status_code=500, detail=f"Failed to generate PDF: {e}")


class FeedbackRequest(BaseModel):
    arm_id: str
    reward: int


def _load_csv_from_file(file: UploadFile) -> pd.DataFrame:
    """Load a single uploaded file into a DataFrame with row limit."""
    df = pd.read_csv(file.file)
    if len(df) > ROW_LIMIT:
        df = df.head(ROW_LIMIT)
    return df


async def _load_csv_from_url(url: str, client: httpx.AsyncClient) -> Optional[pd.DataFrame]:
    """Download and load a CSV from URL into a DataFrame with row limit."""
    try:
        response = await client.get(url)
        response.raise_for_status()
        df = pd.read_csv(io.BytesIO(response.content))
        if len(df) > ROW_LIMIT:
            df = df.head(ROW_LIMIT)
        return df
    except Exception:
        return None


def _extract_filename_from_url(url: str, index: int) -> str:
    """Extract filename from URL or generate a default name."""
    filename = url.split("/")[-1].split("?")[0]
    if not filename.endswith(".csv"):
        filename = f"dataset_{index}.csv"
    return filename


def _parse_datasets(ctx: Dict[str, Any]) -> List[str]:
    """Extract dataset URLs from context, excluding 'Current Upload' placeholders."""
    if not ctx or "datasets" not in ctx:
        return []
    return [
        d["url"] for d in ctx["datasets"]
        if "url" in d and d["url"] != "Current Upload"
    ]


def _parse_history(ctx: Dict[str, Any]) -> str:
    """Extract and format conversation history from context as a string summary."""
    if not ctx or "messages" not in ctx:
        return ""
    return "\n".join(
        m.get("content", "") for m in ctx["messages"]
    )


@app.post("/analyze", response_model=AnalysisResponse)
async def analyze_endpoint(
    request: Request,
    user_text: str = Form(...),
    context: Optional[str] = Form(None),
    files: Optional[List[UploadFile]] = File(None),
    arm_id: Optional[str] = Form(None),
    arm_temperature: Optional[str] = Form(None),
    arm_model: Optional[str] = Form(None),
):
    session_id = request.headers.get("x-session-id")
    logger.info(
        "analyze.request session_id=%s has_context=%s files=%s arm_id=%s",
        session_id,
        bool(context),
        len(files) if files else 0,
        arm_id,
    )
    # 1) Keep user_text as string (already a string from Form)
    
    # 2) Parse the JSON context
    ctx: Dict[str, Any] = {}
    if context:
        try:
            ctx = json.loads(context)
        except json.JSONDecodeError as e:
            raise HTTPException(status_code=400, detail=f"context must be valid JSON: {e}")

    # 3) Parse datasets from context
    dataset_urls = _parse_datasets(ctx)

    # 4) Parse history from context
    history_summary = _parse_history(ctx)

    # 5) Check: require at least one CSV file OR dataset URL
    has_files = files and len(files) > 0
    has_urls = len(dataset_urls) > 0
    if not has_files and not has_urls:
        raise HTTPException(
            status_code=400,
            detail="At least one CSV file must be uploaded or a dataset URL provided."
        )

    # 6) Load CSV files into DataFrames
    dfs: Dict[str, pd.DataFrame] = {}

    # Load directly uploaded files
    if has_files:
        try:
            for f in files:
                name = getattr(f, "filename", "uploaded.csv")
                dfs[name] = _load_csv_from_file(f)
        except Exception as e:
            raise HTTPException(status_code=400, detail=f"Error reading uploaded CSV files: {e}")

    # Download and load files from URLs
    if has_urls:
        try:
            async with httpx.AsyncClient(timeout=30.0) as client:
                for idx, url in enumerate(dataset_urls):
                    df = await _load_csv_from_url(url, client)
                    if df is not None:
                        filename = _extract_filename_from_url(url, idx)
                        dfs[filename] = df
        except Exception as e:
            raise HTTPException(status_code=400, detail=f"Error loading CSV from URL: {e}")

    # 7) Verify we have at least one DataFrame loaded
    if not dfs:
        raise HTTPException(
            status_code=400,
            detail="No valid CSV data could be loaded from files or URLs."
        )

    # 8) Build arm config from request (sent by backend) or use defaults
    arm_config = None
    if arm_id:
        arm_config = {
            "arm_id": arm_id,
            "temperature": float(arm_temperature) if arm_temperature else 0.1,
            "model_name": arm_model or os.getenv("GEMINI_MODEL", "gemini-2.5-flash"),
        }
        logger.info("analyze: Using arm config from backend arm_id=%s temp=%s model=%s",
                    arm_id, arm_config["temperature"], arm_config["model_name"])

    # 9) Call analyzer with processed data and arm config
    try:
        result = analyze(
            user_text=user_text,
            dfs=dfs,
            history_summary=history_summary,
            arm_config=arm_config,
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

    # If analyzer created a profiling report, attach absolute URLs for the frontend.
    try:
        if isinstance(result, dict) and result.get("profile_report_id") and not result.get("profile_url"):
            rid = result.get("profile_report_id")
            result["profile_url"] = str(request.base_url) + f"profile/{rid}"
            result["profile_pdf_url"] = str(request.base_url) + f"profile/{rid}/pdf"
        elif isinstance(result, dict) and result.get("profile_report_id") and result.get("profile_url") and not result.get("profile_pdf_url"):
            rid = result.get("profile_report_id")
            result["profile_pdf_url"] = str(request.base_url) + f"profile/{rid}/pdf"
    except Exception:
        logger.debug("Failed to attach profile_url", exc_info=True)

    try:
        logger.info(
            "analyze.response session_id=%s arm_id=%s intent=%s graph_type=%s error=%s",
            session_id,
            result.get("arm_id") if isinstance(result, dict) else None,
            result.get("intent") if isinstance(result, dict) else None,
            result.get("graph_type") if isinstance(result, dict) else None,
            bool(result.get("error")) if isinstance(result, dict) else None,
        )
    except Exception:
        logger.debug("analyze.response log failed", exc_info=True)

    return result


@app.post("/feedback", deprecated=True)
def feedback_endpoint(request: Request, req: FeedbackRequest):
    """
    DEPRECATED: Feedback is now handled by the Node backend with per-chat MongoDB storage.
    This endpoint remains for backward compatibility but updates a local file-based bandit
    which is no longer the source of truth.
    """
    session_id = request.headers.get("x-session-id")
    logger.warning(
        "feedback.deprecated_endpoint session_id=%s arm_id=%s reward=%d - Use Node backend /api/chat/feedback instead",
        session_id,
        req.arm_id,
        int(req.reward),
    )
    if req.reward not in (0, 1):
        raise HTTPException(status_code=400, detail="reward must be 0 or 1")
    new_stats = update_bandit_feedback(req.arm_id, req.reward)
    logger.info(
        "feedback.updated session_id=%s arm_id=%s new_stats=%s",
        session_id,
        req.arm_id,
        json.dumps(new_stats, ensure_ascii=False) if new_stats else None,
    )
    return {"status": "success", "arm_id": req.arm_id, "reward": req.reward, "new_stats": new_stats}
