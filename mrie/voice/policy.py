"""Deterministic speech-delivery policy, independent of any model."""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime, time
from typing import Any
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError


@dataclass(frozen=True, slots=True)
class SpeechDecision:
    allow_playback: bool
    reason: str


class QuietHoursPolicy:
    """Queue routine speech during an operator-configured local-time interval."""

    def __init__(
        self,
        config: dict[str, Any] | None = None,
        *,
        clock: Callable[[], datetime] | None = None,
    ) -> None:
        values = config or {}
        self.enabled = bool(values.get("enabled", False))
        timezone_name = str(values.get("timezone", "America/New_York"))
        try:
            self.timezone = ZoneInfo(timezone_name)
        except ZoneInfoNotFoundError as exc:
            raise ValueError(f"Unknown quiet-hours timezone: {timezone_name}") from exc
        self.start = self._parse_time(str(values.get("start", "22:00")))
        self.end = self._parse_time(str(values.get("end", "07:00")))
        self.critical_override = bool(values.get("critical_override", True))
        self.operator_override = bool(values.get("operator_override", True))
        self._clock = clock or (lambda: datetime.now(UTC))

    @staticmethod
    def _parse_time(value: str) -> time:
        try:
            parsed = datetime.strptime(value, "%H:%M")
        except ValueError as exc:
            raise ValueError(f"Quiet-hours time must be HH:MM, got {value!r}") from exc
        return parsed.time()

    def is_quiet_now(self) -> bool:
        if not self.enabled:
            return False
        local_time = self._clock().astimezone(self.timezone).time().replace(tzinfo=None)
        if self.start == self.end:
            return True
        if self.start < self.end:
            return self.start <= local_time < self.end
        return local_time >= self.start or local_time < self.end

    def evaluate(self, *, trigger: str, severity: str) -> SpeechDecision:
        if not self.is_quiet_now():
            return SpeechDecision(True, "outside_quiet_hours")
        normalized_trigger = trigger.strip().lower()
        normalized_severity = severity.strip().lower()
        if self.operator_override and normalized_trigger in {"manual", "operator", "verification"}:
            return SpeechDecision(True, "operator_override")
        if self.critical_override and normalized_severity == "critical":
            return SpeechDecision(True, "critical_override")
        return SpeechDecision(False, "quiet_hours")

    def status(self) -> dict[str, Any]:
        return {
            "enabled": self.enabled,
            "timezone": str(self.timezone),
            "start": self.start.strftime("%H:%M"),
            "end": self.end.strftime("%H:%M"),
            "active": self.is_quiet_now(),
            "critical_override": self.critical_override,
            "operator_override": self.operator_override,
        }
