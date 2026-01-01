"""
Core orchestration / pipeline.

Flow:
1. Receive inputs (user_text, dfs, history_summary)
2. Single LLM call that detects intent AND generates content:
   - For INSIGHT: Returns intent + insights text directly
   - For GRAPH: Returns intent + graph_type + Python code
3. For GRAPH only:
   a. Run the generated code on FULL dataset to get real aggregated values
   b. DETERMINISTICALLY convert values to Plotly configuration (no LLM needed)
4. Return formatted response
"""

import json
import os
import re
import tempfile
import subprocess
import logging
import uuid
import time
import random
import math
from typing import Dict, Any, Optional
import pandas as pd
from .llm_client import call_llm
from .rl import ThompsonBandit, Arm

# Configure module logger
logger = logging.getLogger(__name__)

# Configuration from environment
CODE_EXECUTION_TIMEOUT = int(os.getenv("CODE_EXECUTION_TIMEOUT", "15"))
MAX_CHART_ITEMS = int(os.getenv("MAX_CHART_ITEMS", "15"))
MAX_LLM_TOKENS = int(os.getenv("MAX_LLM_TOKENS", "4096"))

# Prompt-size / stability guardrails (important for production reliability)
MAX_SCHEMA_COLUMNS = int(os.getenv("MAX_SCHEMA_COLUMNS", "40"))
MAX_SAMPLE_ROWS = int(os.getenv("MAX_SAMPLE_ROWS", "3"))

# Optional retries (disabled by default to avoid extra cost)
LLM_MAX_RETRIES = int(os.getenv("LLM_MAX_RETRIES", "0"))  # retries on transient LLM errors
LLM_JSON_REPAIR_MAX = int(os.getenv("LLM_JSON_REPAIR_MAX", "0"))  # retries when model returns invalid JSON

# Prompt file paths
BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
UNIFIED_PROMPT_PATH = os.path.join(BASE_DIR, "prompts", "unified_system.txt")
UNIFIED_STRICT_SUFFIX_PATH = os.path.join(BASE_DIR, "prompts", "unified_strict_json_suffix.txt")

# Thompson bandit state (persisted to disk)
_BANDIT_STATE_PATH = os.path.join(BASE_DIR, "runs", "rl_state.json")
_BANDIT = ThompsonBandit(state_path=_BANDIT_STATE_PATH)

# Arms are prompt/parameter variants; avoid additional prompt files by varying constraints/temperature.
_UNIFIED_ARMS = [
    Arm(
        arm_id="unified_base",
        stage="unified",
        model_name=os.getenv("GEMINI_MODEL", "gemini-2.5-flash"),
        notes="Base unified prompt",
        temperature=0.1,
    ),
    Arm(
        arm_id="unified_strict_json",
        stage="unified",
        model_name=os.getenv("GEMINI_MODEL", "gemini-2.5-flash"),
        notes="Stricter JSON-only response",
        temperature=0.05,
    ),
]
_BANDIT.ensure_arms(_UNIFIED_ARMS)


_PROFILE_REPORTS_DIR = os.path.join(BASE_DIR, "runs", "profiles")
_PROFILE_STORAGE = os.getenv("PROFILE_STORAGE", "local").strip().lower()
_CLOUDINARY_PROFILE_FOLDER = os.getenv("CLOUDINARY_PROFILE_FOLDER", "capstone-profiles").strip() or "capstone-profiles"


def _generate_profile_report_id() -> str:
    return str(uuid.uuid4())


def _generate_profile_report_html_to_disk(df: pd.DataFrame, report_id: str) -> str:
    """Generate a ydata-profiling HTML report and write it to disk. Returns file path."""
    try:
        from ydata_profiling import ProfileReport
    except Exception as e:
        import sys
        py_ver = f"{sys.version_info.major}.{sys.version_info.minor}"
        raise RuntimeError(
            f"Profiling is not available (Python {py_ver}). "
            "ydata-profiling requires Python ≤3.13. "
            "Use a Python 3.13 venv, or skip the 'profile' feature. "
            f"Import error: {e}"
        )

    os.makedirs(_PROFILE_REPORTS_DIR, exist_ok=True)
    safe_name = f"{report_id}.html"
    out_path = os.path.join(_PROFILE_REPORTS_DIR, safe_name)

    # Keep the report reasonably lightweight for chat embedding.
    report = ProfileReport(
        df,
        title="YData Profiling Report",
        minimal=True,
        explorative=True,
        progress_bar=False,
    )

    report.to_file(out_path)
    return out_path


def _upload_profile_report_to_cloudinary(html_path: str) -> str:
    """
    Upload the generated HTML report to Cloudinary as a raw asset.

    Why: Render's local filesystem is ephemeral (reports disappear on redeploy/restart),
    so persistent storage is needed for stable profile URLs.

    Requires env vars:
      - CLOUDINARY_CLOUD_NAME
      - CLOUDINARY_API_KEY
      - CLOUDINARY_API_SECRET
    Optional:
      - CLOUDINARY_PROFILE_FOLDER
    """
    cloud_name = os.getenv("CLOUDINARY_CLOUD_NAME")
    api_key = os.getenv("CLOUDINARY_API_KEY")
    api_secret = os.getenv("CLOUDINARY_API_SECRET")
    if not cloud_name or not api_key or not api_secret:
        raise RuntimeError("Cloudinary env vars missing (CLOUDINARY_CLOUD_NAME/API_KEY/API_SECRET)")

    try:
        import cloudinary  # type: ignore
        import cloudinary.uploader  # type: ignore
    except Exception as e:  # pragma: no cover
        raise RuntimeError(f"Cloudinary dependency missing: {e}")

    cloudinary.config(
        cloud_name=cloud_name,
        api_key=api_key,
        api_secret=api_secret,
        secure=True,
    )

    filename = os.path.basename(html_path)
    report_id = filename.replace(".html", "")

    # Upload as a raw file; Cloudinary returns a stable secure_url.
    result = cloudinary.uploader.upload(
        html_path,
        resource_type="raw",
        folder=_CLOUDINARY_PROFILE_FOLDER,
        public_id=report_id,
        overwrite=True,
        use_filename=False,
        unique_filename=False,
    )

    url = result.get("secure_url") or result.get("url")
    if not url:
        raise RuntimeError("Cloudinary upload succeeded but returned no URL")
    return str(url)


def update_bandit_feedback(arm_id: str, reward: int):
    return _BANDIT.update(arm_id, reward)


def _read_prompt(path: str) -> str:
    """Read a prompt text file."""
    with open(path, "r", encoding="utf-8") as f:
        return f.read()


def _extract_unified_response(text: str) -> Dict[str, Any]:
    """
    Extract JSON object from unified LLM response.
    Handles markdown code blocks and raw JSON with nested braces.
    """
    text = text.strip()
    
    # Remove markdown code blocks if present
    if "```" in text:
        # Try to find JSON block first
        match = re.search(r"```json\s*([\s\S]*?)\s*```", text, re.IGNORECASE)
        if match:
            text = match.group(1).strip()
        else:
            # Fallback: remove all fences
            text = re.sub(r"```\w*\s*", "", text)
            text = text.replace("```", "")
    
    # Find the outermost JSON object by matching braces
    start = text.find("{")
    if start == -1:
        raise json.JSONDecodeError("No JSON object found", text, 0)
    
    # Count braces to find matching closing brace
    # Must properly handle escape sequences within strings
    depth = 0
    in_string = False
    i = start
    end = -1
    
    while i < len(text):
        char = text[i]
        
        if in_string:
            if char == '\\' and i + 1 < len(text):
                # Skip the next character (it's escaped)
                i += 2
                continue
            elif char == '"':
                in_string = False
        else:
            if char == '"':
                in_string = True
            elif char == '{':
                depth += 1
            elif char == '}':
                depth -= 1
                if depth == 0:
                    end = i
                    break
        i += 1
    
    if end == -1:
        raise json.JSONDecodeError("Unmatched braces in JSON", text, start)
    
    json_str = text[start:end + 1]
    return json.loads(json_str)


def _format_datasets_info(dfs: Dict[str, pd.DataFrame]) -> str:
    """
    Format ALL datasets into a comprehensive string for LLM context.
    Includes: dataset name, shape, column info with types, sample rows, and basic stats.
    This rich context enables more accurate insights.
    """
    parts = []
    for name, df in dfs.items():
        # Basic info
        num_rows, num_cols = df.shape
        columns = df.columns.tolist()

        # Limit schema size to reduce token bloat + JSON truncation issues in production
        display_cols = columns[:MAX_SCHEMA_COLUMNS] if MAX_SCHEMA_COLUMNS > 0 else columns
        omitted_cols = max(0, len(columns) - len(display_cols))
        
        # Column types and info
        col_info = []
        for col in display_cols:
            dtype = str(df[col].dtype)
            non_null = df[col].notna().sum()
            unique_count = df[col].nunique()
            col_info.append(f"  - {col} ({dtype}): {non_null} non-null, {unique_count} unique values")
        if omitted_cols:
            col_info.append(f"  - ... ({omitted_cols} more columns omitted)")
        
        # Sample rows
        try:
            sample_rows = df[display_cols].head(MAX_SAMPLE_ROWS).to_string(index=False)
        except Exception:
            sample_rows = df.head(MAX_SAMPLE_ROWS).to_string(index=False)
        
        # Basic statistics for numeric columns
        numeric_cols = df[display_cols].select_dtypes(include=['int64', 'float64', 'int32', 'float32']).columns.tolist()
        stats_info = ""
        if numeric_cols:
            stats_parts = []
            for col in numeric_cols[:5]:  # Limit to first 5 numeric columns
                try:
                    col_min = df[col].min()
                    col_max = df[col].max()
                    col_mean = df[col].mean()
                    stats_parts.append(f"  - {col}: min={col_min:.2f}, max={col_max:.2f}, mean={col_mean:.2f}")
                except Exception:
                    pass
            if stats_parts:
                stats_info = "\nNumeric Column Statistics:\n" + "\n".join(stats_parts)
        
        # Categorical column value counts (for top categories)
        cat_cols = df[display_cols].select_dtypes(include=['object', 'category']).columns.tolist()
        cat_info = ""
        if cat_cols:
            cat_parts = []
            for col in cat_cols[:3]:  # Limit to first 3 categorical columns
                try:
                    top_values = df[col].value_counts().head(5)
                    top_str = ", ".join([f"{v}({c})" for v, c in zip(top_values.index, top_values.values)])
                    cat_parts.append(f"  - {col} top values: {top_str}")
                except Exception:
                    pass
            if cat_parts:
                cat_info = "\nCategorical Column Summaries:\n" + "\n".join(cat_parts)
        
        parts.append(
            f"Dataset: {name}\n"
            f"Shape: {num_rows} rows × {num_cols} columns\n"
            f"Columns:\n" + "\n".join(col_info) + "\n"
            f"Sample Data (first 5 rows):\n{sample_rows}"
            f"{stats_info}"
            f"{cat_info}"
        )
    return "\n\n" + "="*50 + "\n\n".join(parts)


def _should_retry_llm_error(e: Exception) -> bool:
    msg = str(e).lower()
    # Best-effort detection of transient errors (rate limits / temporary failures)
    transient_markers = ["429", "rate", "quota", "timeout", "temporar", "unavailable", "503", "500"]
    return any(m in msg for m in transient_markers)


def _call_llm_with_retries(
    system_prompt: str,
    user_prompt: str,
    *,
    model_name: str,
    temperature: float,
    max_tokens: int,
) -> str:
    attempts = max(1, 1 + max(0, int(LLM_MAX_RETRIES)))
    last_err: Exception | None = None

    for attempt in range(attempts):
        try:
            return call_llm(
                system_prompt,
                user_prompt,
                max_tokens=max_tokens,
                model_name=model_name,
                temperature=temperature,
            )
        except Exception as e:
            last_err = e
            if attempt >= attempts - 1 or not _should_retry_llm_error(e):
                raise

            # Exponential backoff + jitter
            sleep_s = min(5.0, (0.6 * (2 ** attempt)) + random.random() * 0.25)
            logger.warning(
                "LLM call failed; retrying attempt=%d/%d sleep=%.2fs err=%s",
                attempt + 1,
                attempts,
                sleep_s,
                str(e)[:200],
            )
            time.sleep(sleep_s)

    # Should never reach here
    if last_err:
        raise last_err
    raise RuntimeError("LLM call failed")


def _save_dataset_to_temp(df: pd.DataFrame) -> str:
    """Save DataFrame to a temporary CSV file and return the path."""
    tmp = tempfile.NamedTemporaryFile(delete=False, suffix=".csv", mode="w", encoding="utf-8")
    df.to_csv(tmp.name, index=False)
    tmp.close()
    return tmp.name


def _extract_code(text: str) -> str:
    """
    Extract and unescape Python code from LLM response.
    Handles:
    - Markdown code blocks
    - JSON-escaped strings (literal \\n, \\", etc.)
    """
    # First handle markdown code blocks if present
    if "```" in text:
        pattern = re.compile(r"```(?:python|py)?\s*(.*?)```", re.IGNORECASE | re.DOTALL)
        match = pattern.search(text)
        if match:
            text = match.group(1).strip()
        else:
            # Fallback: remove all fences
            text = text.replace("```python", "").replace("```py", "").replace("```", "")
            text = text.strip()
    
    # Unescape JSON string escapes (literal \n, \", \\, \t)
    # This handles code that was returned as a JSON-escaped string
    if "\\n" in text or "\\\"" in text or "\\\\" in text:
        # Replace escaped sequences with actual characters
        text = text.replace("\\n", "\n")
        text = text.replace("\\t", "\t")
        text = text.replace("\\\"", "\"")
        text = text.replace("\\'", "'")
        text = text.replace("\\\\", "\\")
    
    return text.strip()


def _wrap_transformation_code(transformation: str) -> str:
    """
    Wrap the LLM's transformation code with the required boilerplate.
    This removes the burden of JSON escaping from the LLM.
    """
    # Clean up the transformation code
    transformation = _extract_code(transformation)
    
    # Build the complete script with boilerplate
    full_script = f'''import sys
import json
import pandas as pd

try:
    df = pd.read_csv(sys.argv[1])
    df.columns = df.columns.str.strip()
    
    # LLM-generated transformation code
{_indent_code(transformation, spaces=4)}
    
    print(json.dumps({{"values": values, "summary": summary}}))
except Exception as e:
    print(json.dumps({{"values": None, "summary": {{"error": str(e)}}}}))
'''
    return full_script


def _indent_code(code: str, spaces: int = 4) -> str:
    """Indent each line of code by the specified number of spaces."""
    indent = " " * spaces
    lines = code.split("\n")
    return "\n".join(indent + line if line.strip() else line for line in lines)


def _run_code(code: str, csv_path: str, timeout: Optional[int] = None) -> Dict[str, Any]:
    """
    Execute the generated Python code with the CSV path as argument.
    Returns parsed JSON with 'values' and 'summary' keys.
    """
    if not code.strip():
        logger.error("_run_code: Generated code is empty")
        raise RuntimeError("Generated code is empty")

    effective_timeout = timeout or CODE_EXECUTION_TIMEOUT
    logger.debug("_run_code: Executing code with timeout=%ds, csv_path=%s", effective_timeout, csv_path)

    # Write code to temp file
    script_file = tempfile.NamedTemporaryFile(delete=False, suffix=".py", mode="w", encoding="utf-8")
    script_file.write(code)
    script_file.flush()
    script_file.close()
    
    logger.debug("_run_code: Script written to %s", script_file.name)

    try:
        proc = subprocess.run(
            ["python", script_file.name, csv_path],
            capture_output=True,
            text=True,
            timeout=effective_timeout,
        )
    except subprocess.TimeoutExpired:
        logger.error("_run_code: Code execution timed out after %ds", effective_timeout)
        raise RuntimeError(f"Code execution timed out after {effective_timeout} seconds")
    finally:
        try:
            os.unlink(script_file.name)
        except Exception:
            pass

    if proc.returncode != 0:
        logger.error("_run_code: Code execution failed. stderr=%s", proc.stderr.strip()[:500])
        raise RuntimeError(f"Code execution failed: {proc.stderr.strip()[:500]}")

    stdout = proc.stdout.strip()
    logger.debug("_run_code: stdout length=%d", len(stdout))
    
    try:
        data = json.loads(stdout)
    except json.JSONDecodeError as e:
        logger.error("_run_code: Invalid JSON output. error=%s, output=%s", str(e), stdout[:500])
        raise RuntimeError(f"Invalid JSON output: {e}. Output: {stdout[:500]}")

    if "values" not in data or "summary" not in data:
        logger.error("_run_code: Output missing required keys. keys=%s", list(data.keys()))
        raise RuntimeError("Output must contain 'values' and 'summary' keys")

    logger.info("_run_code: Success. values_type=%s, summary_keys=%s", 
                type(data['values']).__name__, list(data.get('summary', {}).keys()))
    return data


def _values_to_plotly(values: Dict[str, Any], graph_type: str) -> Dict[str, Any]:
    """
    DETERMINISTICALLY convert standardized values to Plotly configuration.
    
    Input formats supported:
    1. Single series: {"labels": [...], "data": [...]}
    2. Multi series:  {"labels": [...], "datasets": [{"label": "X", "data": [...]}, ...]}
    3. Scatter/Bubble: {"datasets": [{"label": "X", "data": [{"x": 1, "y": 2}, ...]}]}
    4. Heatmap: {"z": [[...]], "x": [...], "y": [...]}
    5. Pie: {"labels": [...], "data": [...]} or {"labels": [...], "values": [...]}
    
    Output: Complete Plotly figure configuration (data + layout)
    """
    logger.debug("_values_to_plotly: Converting values to Plotly. graph_type=%s, values_keys=%s", 
                 graph_type, list(values.keys()) if values else [])
    
    fig_data = []
    # Improved default layout with full-width styling
    layout = {
        "title": {"text": "", "font": {"size": 16}},
        "autosize": True,
        "margin": {"l": 60, "r": 40, "t": 60, "b": 60, "pad": 4},
        "showlegend": True,
        "legend": {"orientation": "h", "yanchor": "bottom", "y": -0.2, "xanchor": "center", "x": 0.5},
        "paper_bgcolor": "rgba(0,0,0,0)",
        "plot_bgcolor": "rgba(248,249,250,1)",
        "font": {"family": "system-ui, -apple-system, sans-serif", "size": 12},
        "xaxis": {"gridcolor": "rgba(0,0,0,0.1)", "zerolinecolor": "rgba(0,0,0,0.2)"},
        "yaxis": {"gridcolor": "rgba(0,0,0,0.1)", "zerolinecolor": "rgba(0,0,0,0.2)"},
    }
    
    # Handle pie chart format (special case - uses labels and values, not x/y)
    if graph_type == "pie":
        labels = values.get("labels", [])
        # Pie charts can have "data" or "values" field
        pie_values = values.get("values", values.get("data", []))
        
        if not labels or not pie_values:
            # Fallback: if we have datasets, use first dataset
            if "datasets" in values and isinstance(values["datasets"], list) and len(values["datasets"]) > 0:
                ds = values["datasets"][0]
                labels = values.get("labels", [])
                pie_values = ds.get("data", ds.get("values", []))
        
        fig_data.append({
            "type": "pie",
            "labels": labels,
            "values": pie_values,
            "textinfo": "label+percent",
            "hoverinfo": "label+percent+value",
        })
        
        # Add title if provided
        if "title" in values:
            layout["title"]["text"] = values["title"]
        
        return {"data": fig_data, "layout": layout}
    
    # Handle heatmap format
    if graph_type == "heatmap":
        def _coerce_num(v: Any) -> Optional[float]:
            if v is None:
                return None
            if isinstance(v, bool):
                return float(v)
            if isinstance(v, (int, float)):
                if math.isnan(v) or math.isinf(v):
                    return None
                return float(v)
            if isinstance(v, str):
                try:
                    f = float(v)
                    if math.isnan(f) or math.isinf(f):
                        return None
                    return f
                except Exception:
                    return None
            return None

        def _normalize_heatmap_matrix(val: Dict[str, Any]):
            z_raw = val.get("z")
            x_raw = val.get("x")
            y_raw = val.get("y")

            # 1) Preferred format: z is list-of-lists
            if isinstance(z_raw, list):
                # If z is 1D, wrap as single row
                if z_raw and not isinstance(z_raw[0], list) and not isinstance(z_raw[0], dict):
                    z_raw = [z_raw]

                # If z is list-of-dicts, expand to matrix
                if z_raw and isinstance(z_raw[0], dict):
                    # union keys in stable order
                    col_keys = list(z_raw[0].keys())
                    z_mat = []
                    for row_obj in z_raw:
                        if not isinstance(row_obj, dict):
                            continue
                        z_mat.append([row_obj.get(k) for k in col_keys])
                    return z_mat, col_keys, y_raw or list(range(len(z_mat)))

                return z_raw, x_raw, y_raw

            # 2) dict-of-dicts (common for corr.to_dict())
            if isinstance(z_raw, dict):
                row_keys = list(z_raw.keys())
                # pick columns from first dict row
                col_keys = None
                for rk in row_keys:
                    rv = z_raw.get(rk)
                    if isinstance(rv, dict):
                        col_keys = list(rv.keys())
                        break
                if not col_keys:
                    col_keys = x_raw or []

                z_mat = []
                for rk in row_keys:
                    rv = z_raw.get(rk)
                    if isinstance(rv, dict):
                        z_mat.append([rv.get(ck) for ck in col_keys])
                    elif isinstance(rv, list):
                        z_mat.append(rv)
                    else:
                        z_mat.append([])

                return z_mat, col_keys, row_keys

            # 3) {labels, datasets} where each dataset row is a list
            if "datasets" in val and isinstance(val.get("datasets"), list) and isinstance(val.get("labels"), list):
                x = val.get("labels", [])
                ds_list = val.get("datasets") or []
                y = [ds.get("label", f"Row {i+1}") for i, ds in enumerate(ds_list) if isinstance(ds, dict)]
                z = [ds.get("data", []) for ds in ds_list if isinstance(ds, dict)]
                return z, x, y

            return None, None, None

        z_mat, x_labels, y_labels = _normalize_heatmap_matrix(values)

        # Clean/convert values to numbers / None and drop empty rows/cols
        if isinstance(z_mat, list) and z_mat:
            cleaned = [[_coerce_num(v) for v in (row if isinstance(row, list) else [])] for row in z_mat]

            # Determine shape
            row_count = len(cleaned)
            col_count = max((len(r) for r in cleaned), default=0)
            if col_count == 0:
                cleaned = []

            # Pad ragged rows
            if cleaned and col_count:
                cleaned = [r + [None] * (col_count - len(r)) for r in cleaned]

            # Build default labels if missing
            if not isinstance(x_labels, list) or len(x_labels) != col_count:
                x_labels = list(range(col_count))
            if not isinstance(y_labels, list) or len(y_labels) != row_count:
                y_labels = list(range(row_count))

            # Drop all-null rows
            keep_row = [any(v is not None for v in row) for row in cleaned]
            cleaned = [row for row, keep in zip(cleaned, keep_row) if keep]
            y_labels = [y for y, keep in zip(y_labels, keep_row) if keep]

            # Drop all-null cols
            if cleaned:
                keep_col = [any(cleaned[r][c] is not None for r in range(len(cleaned))) for c in range(col_count)]
                cleaned = [[row[c] for c in range(col_count) if keep_col[c]] for row in cleaned]
                x_labels = [x for x, keep in zip(x_labels, keep_col) if keep]

            # Compute z range
            flat = [v for row in cleaned for v in row if v is not None]
            if not flat:
                # Nothing to render
                return {"data": [], "layout": layout}

            zmin = min(flat)
            zmax = max(flat)

            # Correlation matrices should be within [-1, 1]; clamp if close
            if -1.05 <= zmin <= 0 and 0 <= zmax <= 1.05:
                zmin, zmax = -1.0, 1.0

            logger.info(
                "_values_to_plotly: heatmap ready rows=%d cols=%d non_null=%d zmin=%.3f zmax=%.3f",
                len(cleaned),
                len(cleaned[0]) if cleaned else 0,
                len(flat),
                float(zmin),
                float(zmax),
            )

            trace = {
                "type": "heatmap",
                "z": cleaned,
                "colorscale": values.get("colorscale", "Viridis"),
                "colorbar": {"title": values.get("colorbar_title", "")},
                "zmin": zmin,
                "zmax": zmax,
            }
            # Only set x/y if lengths match; otherwise let Plotly auto-index.
            if isinstance(x_labels, list) and cleaned and len(x_labels) == len(cleaned[0]):
                trace["x"] = x_labels
            if isinstance(y_labels, list) and len(y_labels) == len(cleaned):
                trace["y"] = y_labels

            fig_data.append(trace)
            layout["xaxis"] = {"title": values.get("xaxis_title", ""), "automargin": True, "tickangle": -45}
            layout["yaxis"] = {"title": values.get("yaxis_title", ""), "automargin": True}
            if "title" in values:
                layout["title"]["text"] = values["title"]

            return {"data": fig_data, "layout": layout}

        # If we couldn't normalize, fall through to generic handling (likely blank otherwise)
    
    # Extract labels if present
    labels = values.get("labels", [])
    
    # Handle different input formats
    if "datasets" in values and isinstance(values["datasets"], list):
        # Multi-series format or scatter/bubble format
        for ds in values["datasets"]:
            dataset_label = ds.get("label", "Series")
            dataset_data = ds.get("data", [])
            
            if graph_type in ["scatter", "bubble"]:
                # Scatter/Bubble: data is array of {x, y} objects
                if dataset_data and isinstance(dataset_data[0], dict):
                    x_vals = [d.get("x") for d in dataset_data]
                    y_vals = [d.get("y") for d in dataset_data]
                    trace = {
                        "type": "scatter",
                        "mode": "markers",
                        "name": dataset_label,
                        "x": x_vals,
                        "y": y_vals,
                    }
                    if graph_type == "bubble" and "size" in dataset_data[0]:
                        trace["marker"] = {
                            "size": [d.get("size", 10) for d in dataset_data],
                            "sizemode": "diameter",
                            "sizeref": 1
                        }
                    fig_data.append(trace)
            else:
                # Line, bar, etc. with multiple series
                trace = {
                    "type": graph_type,
                    "name": dataset_label,
                    "x": labels if labels else list(range(len(dataset_data))),
                    "y": dataset_data,
                }
                fig_data.append(trace)
    
    elif "data" in values:
        # Single series format: {"labels": [...], "data": [...]}
        trace = {
            "type": graph_type,
            "name": values.get("label", "Series"),
            "x": labels if labels else list(range(len(values["data"]))),
            "y": values["data"],
        }
        fig_data.append(trace)
    
    # Set axis labels if provided
    if "xaxis_title" in values:
        layout["xaxis"] = {"title": values.get("xaxis_title", "")}
    if "yaxis_title" in values:
        layout["yaxis"] = {"title": values.get("yaxis_title", "")}
    
    # Add title if provided
    if "title" in values:
        layout["title"]["text"] = values["title"]
    
    return {"data": fig_data, "layout": layout}


def _safe_serialize(obj: Any) -> Any:
    """Convert pandas/numpy types to native Python types for JSON serialization."""
    if isinstance(obj, (int, float, str, bool)) or obj is None:
        return obj
    try:
        import numpy as np
        if isinstance(obj, (np.integer, np.floating, np.bool_)):
            return obj.item()
    except Exception:
        pass
    if isinstance(obj, dict):
        return {_safe_serialize(k): _safe_serialize(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [_safe_serialize(x) for x in obj]
    return str(obj)


def analyze(
    user_text: str,
    dfs: Dict[str, pd.DataFrame],
    history_summary: str = "",
    arm_config: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """
    Main analysis pipeline with single LLM call.
    
    Args:
        user_text: User's request
        dfs: Dictionary of dataset_name -> DataFrame
        history_summary: Formatted conversation history
        arm_config: Optional arm configuration from backend (arm_id, temperature, model_name).
                    If provided, uses these settings instead of local bandit selection.
    
    Returns:
        Response dict with intent, graph_type, plotly/insights, etc.
    """
    datasets_info = _format_datasets_info(dfs)

    # Use arm config from backend if provided, otherwise fall back to local bandit
    if arm_config:
        # Backend has already chosen the arm (per-chat bandit stored in MongoDB)
        arm_id = arm_config.get("arm_id", "unified_base")
        arm_temperature = arm_config.get("temperature", 0.1)
        arm_model_name = arm_config.get("model_name", os.getenv("GEMINI_MODEL", "gemini-2.5-flash"))
        logger.info(
            "analyze: Using arm config from backend arm_id=%s temp=%s model=%s",
            arm_id, arm_temperature, arm_model_name,
        )
    else:
        # Fallback: use local bandit (for backward compatibility or direct API calls)
        arm = _BANDIT.choose("unified", _UNIFIED_ARMS)
        arm_id = arm.arm_id
        arm_temperature = arm.temperature
        arm_model_name = arm.model_name
        logger.info(
            "analyze: Using local bandit arm_id=%s temp=%s model=%s",
            arm_id, arm_temperature, arm_model_name,
        )

    def _ret(payload: Dict[str, Any]) -> Dict[str, Any]:
        payload["arm_id"] = arm_id
        return _safe_serialize(payload)

    # Single LLM call for intent detection + content generation
    try:
        system_prompt = _read_prompt(UNIFIED_PROMPT_PATH)
    except FileNotFoundError as e:
        logger.error(f"Unified prompt file not found: {UNIFIED_PROMPT_PATH}")
        return _ret({
            "intent": None,
            "dataset_name": None,
            "graph_type": None,
            "insights": None,
            "plotly": None,
            "summary": None,
            "values": None,
            "code": None,
            "error": f"Unified prompt file not found: {e}",
        })

    if arm_id == "unified_strict_json":
        try:
            strict_suffix = _read_prompt(UNIFIED_STRICT_SUFFIX_PATH)
            system_prompt = system_prompt + "\n\n" + strict_suffix.strip() + "\n"
        except FileNotFoundError:
            logger.warning(
                "Strict JSON suffix prompt missing: %s (continuing with base prompt)",
                UNIFIED_STRICT_SUFFIX_PATH,
            )

    user_prompt = (
        f"User Request: {user_text}\n\n"
        f"Conversation History:\n{history_summary if history_summary else '(No previous conversation)'}\n\n"
        f"Available Datasets:\n{datasets_info}\n\n"
        "Analyze the request and respond with the appropriate JSON."
    )

    try:
        response = _call_llm_with_retries(
            system_prompt,
            user_prompt,
            max_tokens=MAX_LLM_TOKENS,
            model_name=arm_model_name,
            temperature=arm_temperature,
        )
        logger.debug(f"LLM raw response: {response}")
    except Exception as e:
        logger.error(f"LLM call failed: {e}")
        return _ret({
            "intent": None,
            "dataset_name": None,
            "graph_type": None,
            "insights": None,
            "plotly": None,
            "summary": None,
            "values": None,
            "code": None,
            "error": f"LLM call failed: {e}",
        })

    # Parse unified response (optionally retry once if the model returns invalid JSON)
    unified_result = None
    parse_error: Exception | None = None

    for attempt in range(1 + max(0, int(LLM_JSON_REPAIR_MAX))):
        try:
            unified_result = _extract_unified_response(response)
            parse_error = None
            break
        except (json.JSONDecodeError, Exception) as e:
            parse_error = e
            logger.error(f"Failed to parse LLM response as JSON: {e}")
            logger.error(f"Raw response was: {response[:1000]}...")

            if attempt >= int(LLM_JSON_REPAIR_MAX):
                break

            # Ask the model to output ONLY valid JSON (same prompt; lower temp)
            repair_prompt = (
                user_prompt
                + "\n\nIMPORTANT: Your previous output was invalid JSON. Output ONLY a valid JSON object that matches the required schema. No extra text."
            )
            try:
                response = _call_llm_with_retries(
                    system_prompt,
                    repair_prompt,
                    max_tokens=MAX_LLM_TOKENS,
                    model_name=arm_model_name,
                    temperature=0.0,
                )
            except Exception as e2:
                parse_error = e2
                break

    if unified_result is None:
        return _ret({
            "intent": None,
            "dataset_name": None,
            "graph_type": None,
            "insights": None,
            "plotly": None,
            "summary": None,
            "values": None,
            "code": None,
            "error": f"Invalid JSON in LLM response: {parse_error}",
        })

    reasoning = unified_result.get("_reasoning", "")
    if reasoning:
        logger.info(f"LLM reasoning: {reasoning[:200]}...")

    intent_type = unified_result.get("intent")
    if intent_type not in ["graph", "insight", "recommend", "profile"]:
        logger.error(f"Invalid or missing intent in response: {unified_result}")
        return _ret({
            "intent": None,
            "dataset_name": None,
            "graph_type": None,
            "insights": None,
            "plotly": None,
            "summary": None,
            "values": None,
            "code": None,
            "error": f"Invalid intent in LLM response: {intent_type}",
        })

    dataset_name = unified_result.get("dataset_name")
    if not dataset_name or dataset_name not in dfs:
        # Common production failure mode: model slightly misspells dataset_name (or drops .csv).
        # If there is exactly one dataset, we can safely override to improve stability.
        if len(dfs) == 1:
            dataset_name = next(iter(dfs.keys()))
            logger.warning("Overriding dataset_name to the only loaded dataset: %s", dataset_name)
        else:
            return _ret({
                "intent": intent_type,
                "dataset_name": dataset_name if dataset_name else None,
                "graph_type": unified_result.get("graph_type") if intent_type == "graph" else None,
                "insights": None,
                "plotly": None,
                "summary": None,
                "values": None,
                "code": None,
                "error": "LLM response missing/invalid dataset_name",
            })

    logger.info("Intent detected: %s dataset_name=%s", intent_type, dataset_name)

    # ========== RECOMMEND FLOW ==========
    if intent_type == "recommend":
        insights_text = unified_result.get("insights", "")
        num_recommendations = unified_result.get("num_recommendations")
        header_bits = ["**📈 Chart Recommendations**", f"- Selected dataset: **{dataset_name}**"]
        if num_recommendations is not None:
            header_bits.append(f"- Total recommendations: **{num_recommendations}**")
        header = "\n".join(header_bits) + "\n\n"

        return _ret({
            "intent": "recommend",
            "dataset_name": dataset_name,
            "graph_type": None,
            "insights": header + (insights_text or ""),
            "plotly": None,
            "num_recommendations": num_recommendations,
            "summary": {"selected_dataset": dataset_name, "num_recommendations": num_recommendations},
            "values": None,
            "code": None,
            "error": None,
        })

    # ========== PROFILE FLOW ==========
    if intent_type == "profile":
        selected_df = dfs[dataset_name]
        try:
            report_id = _generate_profile_report_id()
            html_path = _generate_profile_report_html_to_disk(selected_df, report_id)

            # If configured, persist report externally so the link survives Render restarts/redeploys.
            profile_url = None
            if _PROFILE_STORAGE == "cloudinary":
                try:
                    profile_url = _upload_profile_report_to_cloudinary(html_path)
                    logger.info("profile.uploaded cloudinary report_id=%s", report_id)
                except Exception as e:
                    # Fall back to local URL (may expire on restart)
                    logger.warning("profile.upload_failed report_id=%s err=%s", report_id, str(e)[:200])
        except Exception as e:
            return _ret({
                "intent": "profile",
                "dataset_name": dataset_name,
                "graph_type": None,
                "insights": None,
                "plotly": None,
                "profile_report_id": None,
                "profile_url": None,
                "summary": None,
                "values": None,
                "code": None,
                "error": f"Profiling failed: {e}",
            })

        return _ret({
            "intent": "profile",
            "dataset_name": dataset_name,
            "graph_type": None,
            "insights": None,
            "plotly": None,
            "profile_report_id": report_id,
            # If uploaded, this is a persistent URL; otherwise FastAPI will attach a local /profile/{id} URL.
            "profile_url": profile_url,
            "summary": {"selected_dataset": dataset_name},
            "values": None,
            "code": None,
            "error": None,
        })

    # ========== INSIGHT FLOW ==========
    if intent_type == "insight":
        insights_text = unified_result.get("insights", "")
        if not insights_text:
            logger.warning("Insight response missing 'insights' field")

        return _ret({
            "intent": "insight",
            "dataset_name": dataset_name,
            "graph_type": None,
            "insights": insights_text,
            "plotly": None,
            "summary": None,
            "values": None,
            "code": None,
            "error": None,
        })

    # ========== GRAPH FLOW ==========
    graph_type = unified_result.get("graph_type")
    transformation = unified_result.get("transformation") or unified_result.get("code", "")

    if not graph_type:
        logger.error("Graph response missing 'graph_type' field")
        return _ret({
            "intent": "graph",
            "dataset_name": dataset_name,
            "graph_type": None,
            "insights": None,
            "plotly": None,
            "summary": None,
            "values": None,
            "code": transformation,
            "error": "Graph response missing 'graph_type' field",
        })

    if not transformation:
        logger.error("Graph response missing 'transformation' field")
        return _ret({
            "intent": "graph",
            "dataset_name": dataset_name,
            "graph_type": graph_type,
            "insights": None,
            "plotly": None,
            "summary": None,
            "values": None,
            "code": None,
            "error": "Graph response missing 'transformation' field",
        })

    selected_df = dfs[dataset_name]
    full_code = _wrap_transformation_code(transformation)

    csv_path = _save_dataset_to_temp(selected_df)
    try:
        # Use env-configured timeout (Render can be slower than local)
        runner_output = _run_code(full_code, csv_path, timeout=None)
        values = runner_output["values"]
        summary = runner_output["summary"]
    except Exception as e:
        return _ret({
            "intent": "graph",
            "dataset_name": dataset_name,
            "graph_type": graph_type,
            "insights": None,
            "plotly": None,
            "summary": None,
            "values": None,
            "code": full_code,
            "error": f"Code execution failed: {str(e)}",
        })
    finally:
        try:
            os.unlink(csv_path)
        except Exception:
            pass

    try:
        plotly_config = _values_to_plotly(values, graph_type)
        return _ret({
            "intent": "graph",
            "dataset_name": dataset_name,
            "graph_type": graph_type,
            "insights": None,
            "plotly": plotly_config,
            "summary": summary,
            "values": values,
            "code": full_code,
            "error": None,
        })
    except Exception as e:
        return _ret({
            "intent": "graph",
            "dataset_name": dataset_name,
            "graph_type": graph_type,
            "insights": None,
            "plotly": None,
            "summary": summary,
            "values": values,
            "code": full_code,
            "error": f"Failed to convert to Plotly: {str(e)}",
        })
