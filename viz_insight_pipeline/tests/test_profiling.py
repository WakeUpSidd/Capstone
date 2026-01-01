import pandas as pd

from app import analyzer as analyzer_mod


def test_profile_intent_generates_report_id(monkeypatch, tmp_path):
    df = pd.DataFrame({"a": [1, 2, 3], "b": ["x", "y", "z"]})

    def fake_call_llm(system_prompt, user_prompt, *args, **kwargs):
        return '{"_reasoning":"ok","intent":"profile","dataset_name":"d.csv","graph_type":null}'

    monkeypatch.setattr(analyzer_mod, "call_llm", fake_call_llm)

    # Avoid importing ydata-profiling during unit test
    def fake_to_disk(df_in, report_id):
        assert report_id
        assert not df_in.empty
        return str(tmp_path / f"{report_id}.html")

    monkeypatch.setattr(analyzer_mod, "_generate_profile_report_html_to_disk", fake_to_disk)

    out = analyzer_mod.analyze(
        user_text="generate ydata profiling report",
        dfs={"d.csv": df},
        history_summary="",
    )

    assert out["intent"] == "profile"
    assert out["profile_report_id"]
    assert out["dataset_name"] == "d.csv"
    assert out["error"] is None
