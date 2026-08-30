"""Bounded, operator-configurable storage for server-rendered speech artifacts."""

from __future__ import annotations

import json
import os
import re
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

_ENV_NAME = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
_EXTENSION = re.compile(r"^[a-z0-9]{1,10}$")
_OWNED_AUDIO = re.compile(
    r"^utterance-\d{6}-(?P<token>[0-9a-f]{8})\.(?P<extension>[a-z0-9]{1,10})$"
)


@dataclass(frozen=True, slots=True)
class SpeechRetentionPolicy:
    """Hard ceilings applied to generated audio, including queued artifacts."""

    max_files: int
    max_total_bytes: int
    max_age_days: float

    @classmethod
    def from_config(cls, config: dict[str, Any]) -> SpeechRetentionPolicy:
        raw = config.get("retention", {})
        if raw is None:
            raw = {}
        if not isinstance(raw, dict):
            raise ValueError("voice.retention must be a mapping")
        return cls(
            max_files=_integer_setting(raw, "max_files", 64, maximum=100_000),
            max_total_bytes=_integer_setting(
                raw,
                "max_total_bytes",
                128 * 1024 * 1024,
                maximum=100 * 1024 * 1024 * 1024,
            ),
            max_age_days=_float_setting(raw, "max_age_days", 14.0, maximum=3650.0),
        )

    def as_dict(self) -> dict[str, int | float]:
        return {
            "max_files": self.max_files,
            "max_total_bytes": self.max_total_bytes,
            "max_age_days": self.max_age_days,
        }


@dataclass(frozen=True, slots=True)
class PrunedSpeechArtifact:
    """An owned artifact removed under a named retention constraint."""

    utterance_id: str
    path: Path
    size_bytes: int
    reason: str
    previous_status: str
    audio_sha256: str | None
    provider: str | None
    voice_id: str | None
    model_id: str | None
    trigger: str | None
    severity: str | None
    text: str | None
    orphaned: bool


@dataclass(frozen=True, slots=True)
class PruneResult:
    """Result of enforcing retention, including reservation feasibility."""

    removed: tuple[PrunedSpeechArtifact, ...]
    fits: bool


@dataclass(frozen=True, slots=True)
class _StoredArtifact:
    path: Path
    size_bytes: int
    modified_at: float
    utterance_id: str
    previous_status: str
    audio_sha256: str | None
    provider: str | None
    voice_id: str | None
    model_id: str | None
    trigger: str | None
    severity: str | None
    text: str | None
    orphaned: bool


class SpeechArtifactStore:
    """Own generated audio without treating a broad operator path as disposable."""

    def __init__(
        self,
        *,
        project_root: Path,
        audit_dir: Path,
        config: dict[str, Any],
    ) -> None:
        self.project_root = project_root.resolve()
        self.audit_dir = audit_dir.resolve()
        self.policy = SpeechRetentionPolicy.from_config(config)
        self.storage_dir_env = str(
            config.get("storage_dir_env", "MRE_SPEECH_STORAGE_DIR")
        ).strip()
        if not _ENV_NAME.fullmatch(self.storage_dir_env):
            raise ValueError("voice.storage_dir_env must be a valid environment variable name")

        environment_value = os.environ.get(self.storage_dir_env, "").strip()
        configured_value = config.get("storage_dir", "")
        configured_text = str(configured_value).strip() if configured_value is not None else ""
        raw_path = environment_value or configured_text
        self.externally_configured = bool(raw_path)
        self.directory = self._resolve_directory(raw_path or str(self.audit_dir))
        self.directory.mkdir(parents=True, exist_ok=True)
        if not self.directory.is_dir():
            raise ValueError("Configured speech storage location is not a directory")

        self._active_paths: set[str] = set()
        self._lock = threading.RLock()

    def _resolve_directory(self, raw_path: str) -> Path:
        try:
            candidate = Path(raw_path).expanduser()
            if not candidate.is_absolute():
                candidate = self.project_root / candidate
            candidate = candidate.resolve(strict=False)
        except (OSError, RuntimeError, ValueError) as exc:
            raise ValueError("Configured speech storage directory is invalid") from exc

        home = Path.home().resolve(strict=False)
        if (
            candidate.parent == candidate
            or _same_path(candidate, self.project_root)
            or _same_path(candidate, home)
        ):
            raise ValueError(
                "Speech storage must be a dedicated directory, not a filesystem, home, "
                "or project root"
            )
        return candidate

    @staticmethod
    def validate_extension(extension: str) -> str:
        normalized = extension.strip().lower()
        if not _EXTENSION.fullmatch(normalized):
            raise ValueError("Speech provider returned an unsupported audio extension")
        return normalized

    def audio_path(self, *, utterance_id: str, extension: str, now: str) -> Path:
        safe_extension = self.validate_extension(extension)
        return self.directory / f"utterance-{now}-{utterance_id[:8]}.{safe_extension}"

    def protect(self, path: Path) -> None:
        with self._lock:
            self._active_paths.add(_path_key(path))

    def release(self, path: Path) -> None:
        with self._lock:
            self._active_paths.discard(_path_key(path))

    def prune(self, *, reserve_files: int = 0, reserve_bytes: int = 0) -> PruneResult:
        """Apply age/count/byte limits without removing an active playback file."""

        if reserve_files < 0 or reserve_bytes < 0:
            raise ValueError("Speech storage reservations cannot be negative")
        with self._lock:
            artifacts = self._artifacts()
            removed: list[PrunedSpeechArtifact] = []
            cutoff = time.time() - (self.policy.max_age_days * 86_400)

            for artifact in sorted(artifacts, key=lambda item: item.modified_at):
                if artifact.modified_at >= cutoff or self._is_active(artifact.path):
                    continue
                if self._remove(artifact, reason="max_age"):
                    artifacts.remove(artifact)
                    removed.append(_pruned(artifact, "max_age"))

            while len(artifacts) + reserve_files > self.policy.max_files:
                candidate = self._oldest_removable(artifacts)
                if candidate is None or not self._remove(candidate, reason="max_files"):
                    break
                artifacts.remove(candidate)
                removed.append(_pruned(candidate, "max_files"))

            total_bytes = sum(item.size_bytes for item in artifacts)
            while total_bytes + reserve_bytes > self.policy.max_total_bytes:
                candidate = self._oldest_removable(artifacts)
                if candidate is None or not self._remove(candidate, reason="max_total_bytes"):
                    break
                artifacts.remove(candidate)
                total_bytes -= candidate.size_bytes
                removed.append(_pruned(candidate, "max_total_bytes"))

            fits = (
                len(artifacts) + reserve_files <= self.policy.max_files
                and total_bytes + reserve_bytes <= self.policy.max_total_bytes
            )
            return PruneResult(removed=tuple(removed), fits=fits)

    def status(self) -> dict[str, Any]:
        with self._lock:
            artifacts = self._artifacts()
            return {
                "directory_configured": self.externally_configured,
                "stored_files": len(artifacts),
                "stored_bytes": sum(item.size_bytes for item in artifacts),
                "active_files": sum(
                    1 for artifact in artifacts if self._is_active(artifact.path)
                ),
                "policy": self.policy.as_dict(),
                "queued_files_are_retention_bounded": True,
            }

    def _artifacts(self) -> list[_StoredArtifact]:
        audit = self._latest_audit_by_path()
        artifacts: list[_StoredArtifact] = []
        try:
            entries = tuple(self.directory.iterdir())
        except OSError:
            return artifacts
        for path in entries:
            match = _OWNED_AUDIO.fullmatch(path.name)
            if match is None or path.is_symlink():
                continue
            try:
                stat = path.stat()
            except OSError:
                continue
            if not path.is_file():
                continue
            event = audit.get(_path_key(path))
            utterance_id = _string_field(event, "utterance_id")
            artifacts.append(
                _StoredArtifact(
                    path=path,
                    size_bytes=stat.st_size,
                    modified_at=stat.st_mtime,
                    utterance_id=utterance_id or match.group("token"),
                    previous_status=_string_field(event, "status") or "unknown",
                    audio_sha256=_string_field(event, "audio_sha256"),
                    provider=_string_field(event, "provider"),
                    voice_id=_string_field(event, "voice_id"),
                    model_id=_string_field(event, "model_id"),
                    trigger=_string_field(event, "trigger"),
                    severity=_string_field(event, "severity"),
                    text=_string_field(event, "text"),
                    orphaned=event is None,
                )
            )
        return artifacts

    def _latest_audit_by_path(self) -> dict[str, dict[str, Any]]:
        latest: dict[str, dict[str, Any]] = {}
        for log_file in sorted(self.audit_dir.glob("speech-*.jsonl")):
            try:
                with log_file.open(encoding="utf-8") as handle:
                    for line in handle:
                        try:
                            entry = json.loads(line)
                        except (json.JSONDecodeError, TypeError):
                            continue
                        if not isinstance(entry, dict):
                            continue
                        raw_path = entry.get("audio_path")
                        if not isinstance(raw_path, str) or not raw_path:
                            continue
                        try:
                            path = Path(raw_path).resolve(strict=False)
                        except (OSError, RuntimeError, ValueError):
                            continue
                        if _same_path(path.parent, self.directory):
                            latest[_path_key(path)] = entry
            except OSError:
                continue
        return latest

    def _oldest_removable(
        self, artifacts: list[_StoredArtifact]
    ) -> _StoredArtifact | None:
        candidates = [item for item in artifacts if not self._is_active(item.path)]
        if not candidates:
            return None
        return min(candidates, key=lambda item: (_retention_priority(item), item.modified_at))

    def _is_active(self, path: Path) -> bool:
        return _path_key(path) in self._active_paths

    @staticmethod
    def _remove(artifact: _StoredArtifact, *, reason: str) -> bool:
        del reason
        try:
            artifact.path.unlink()
        except OSError:
            return False
        return True


def _integer_setting(
    config: dict[str, Any], name: str, default: int, *, maximum: int
) -> int:
    value = config.get(name, default)
    if isinstance(value, bool):
        raise ValueError(f"voice.retention.{name} must be an integer")
    try:
        parsed = int(value)
    except (TypeError, ValueError) as exc:
        raise ValueError(f"voice.retention.{name} must be an integer") from exc
    if parsed < 1 or parsed > maximum:
        raise ValueError(f"voice.retention.{name} must be between 1 and {maximum}")
    return parsed


def _float_setting(
    config: dict[str, Any], name: str, default: float, *, maximum: float
) -> float:
    value = config.get(name, default)
    if isinstance(value, bool):
        raise ValueError(f"voice.retention.{name} must be a number")
    try:
        parsed = float(value)
    except (TypeError, ValueError) as exc:
        raise ValueError(f"voice.retention.{name} must be a number") from exc
    if parsed <= 0 or parsed > maximum:
        raise ValueError(f"voice.retention.{name} must be greater than 0 and at most {maximum}")
    return parsed


def _string_field(event: dict[str, Any] | None, field: str) -> str | None:
    if event is None:
        return None
    value = event.get(field)
    return value if isinstance(value, str) else None


def _path_key(path: Path) -> str:
    return os.path.normcase(str(path.resolve(strict=False)))


def _same_path(left: Path, right: Path) -> bool:
    return _path_key(left) == _path_key(right)


def _retention_priority(artifact: _StoredArtifact) -> int:
    if artifact.previous_status in {"played", "play_failed", "retention_pruned"}:
        return 0
    if artifact.orphaned:
        return 1
    if artifact.previous_status == "queued":
        return 3
    return 2


def _pruned(artifact: _StoredArtifact, reason: str) -> PrunedSpeechArtifact:
    return PrunedSpeechArtifact(
        utterance_id=artifact.utterance_id,
        path=artifact.path,
        size_bytes=artifact.size_bytes,
        reason=reason,
        previous_status=artifact.previous_status,
        audio_sha256=artifact.audio_sha256,
        provider=artifact.provider,
        voice_id=artifact.voice_id,
        model_id=artifact.model_id,
        trigger=artifact.trigger,
        severity=artifact.severity,
        text=artifact.text,
        orphaned=artifact.orphaned,
    )
