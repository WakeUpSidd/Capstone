"""
Pydantic request/response models.

Rationale:
- Define simple, explicit input/output contracts for the API.
- Keep models minimal so the frontend knows exactly what to send and expect.
"""

from typing import Dict, List, Optional, Any
from pydantic import BaseModel


class AnalysisResponse(BaseModel):
    intent: Optional[str] = None
    dataset_name: Optional[str] = None
    graph_type: Optional[str] = None
    plotly: Optional[Dict[str, Any]] = None
    insights: Optional[str] = None
    num_recommendations: Optional[int] = None
    profile_report_id: Optional[str] = None
    profile_url: Optional[str] = None
    profile_pdf_url: Optional[str] = None
    summary: Optional[Dict[str, Any]] = None
    values: Optional[Any] = None
    code: Optional[str] = None
    arm_id: Optional[str] = None
    error: Optional[str] = None
