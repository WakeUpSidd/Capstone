import pandas as pd

from app import analyzer as analyzer_mod


def test_recommendation_request_returns_insights_markdown(monkeypatch):
    df = pd.DataFrame({
        "date": ["2025-01-01", "2025-01-02"],
        "sales": [10, 20],
        "region": ["A", "B"],
    })

    def fake_call_llm(system_prompt, user_prompt, *args, **kwargs):
        assert "OUTPUT FORMAT" in system_prompt
        assert "Available Datasets" in user_prompt
        return '{"_reasoning":"ok","intent":"recommend","dataset_name":"mydata.csv","graph_type":null,"num_recommendations":5,"insights":"## 1. Time Trends\\n### Sales over time (Line)\\n**Business Insight:** Trend\\n**Tool Command:**\\n```text\\nCreate a Line Chart of date vs sales\\n```"}'

    monkeypatch.setattr(analyzer_mod, "call_llm", fake_call_llm)

    out = analyzer_mod.analyze(
        user_text="recommend me some charts (10)",
        dfs={"mydata.csv": df},
        history_summary="",
    )

    assert out["intent"] == "recommend"
    assert out["chartjs"] is None
    assert out["insights"]
    assert "Chart Recommendations" in out["insights"]
    assert "## 1." in out["insights"]


def test_non_recommendation_still_uses_unified_json(monkeypatch):
    df = pd.DataFrame({"x": [1, 2, 3], "y": [4, 5, 6]})

    def fake_call_llm(system_prompt, user_prompt, *args, **kwargs):
        # Unified path requires JSON output
        return '{"_reasoning":"ok","intent":"insight","dataset_name":"d.csv","graph_type":null,"insights":"hello"}'

    monkeypatch.setattr(analyzer_mod, "call_llm", fake_call_llm)

    out = analyzer_mod.analyze(
        user_text="analyze this dataset",
        dfs={"d.csv": df},
        history_summary="",
    )

    assert out["intent"] == "insight"
    assert out["insights"] == "hello"
