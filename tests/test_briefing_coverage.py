"""Deterministic coverage warnings for model-generated briefings."""

from mrie.scheduler.briefing_scheduler import BriefingScheduler


def test_coverage_warning_prevents_false_wazuh_negative() -> None:
    notice = BriefingScheduler._coverage_notice(  # noqa: SLF001
        {
            "sources": {
                "news": {"success": True, "data": {"headlines": []}},
                "youtube": {"success": False},
                "instagram": {"success": False},
                "reddit": {"success": False},
                "wazuh_sync": {"success": False},
                "security_events": {"success": True, "data": {"events": []}},
                "honeypot": {"success": True, "data": {"enabled": False}},
            }
        }
    )

    assert "empty local security cache is not proof" in notice
    assert "Honeypot coverage was unavailable or disabled" in notice
    assert "Unavailable personal feeds: YouTube, Instagram, Reddit" in notice


def test_coverage_warning_is_empty_when_collectors_are_available() -> None:
    notice = BriefingScheduler._coverage_notice(  # noqa: SLF001
        {
            "sources": {
                "news": {"success": True},
                "youtube": {"success": True},
                "instagram": {"success": True},
                "reddit": {"success": True},
                "wazuh_sync": {"success": True},
                "security_events": {"success": True},
                "honeypot": {"success": True, "data": {"enabled": True}},
            }
        }
    )

    assert notice == ""


def test_coverage_warning_reports_partial_reddit_collection() -> None:
    notice = BriefingScheduler._coverage_notice(  # noqa: SLF001
        {
            "sources": {
                "news": {"success": True},
                "youtube": {"success": True},
                "instagram": {"success": True},
                "reddit": {
                    "success": True,
                    "data": {"source_errors": [{"subreddit": "netsec"}]},
                },
                "wazuh_sync": {"success": True},
                "security_events": {"success": True},
                "honeypot": {"success": True, "data": {"enabled": True}},
            }
        }
    )

    assert "configured Reddit listings were unavailable" in notice
