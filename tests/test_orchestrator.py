from __future__ import annotations

from pathlib import Path

from mrie.core.orchestrator import MRIEOrchestrator


def test_orchestrator_boots_from_example_config() -> None:
    project_root = Path(__file__).resolve().parents[1]
    orchestrator = MRIEOrchestrator(project_root)
    status = orchestrator.get_status()

    assert status["agent"] == "MRE"
    assert "wazuh" in status["capabilities"]
    assert status["scheduler"]["crons"] == [
        "0 5 * * *",
        "0 13 * * *",
        "0 21 * * *",
    ]
    assert status["provider"]["primary"] == "nvidia_nim"
