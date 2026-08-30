"""Auditable server-side speech synthesis and optional local playback."""

from __future__ import annotations

import asyncio
import hashlib
import json
import uuid
from collections.abc import Callable
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from mrie.core.capability_base import Capability, CapabilityResult, ToolDefinition
from mrie.voice import (
    AudioPlaybackAdapter,
    ElevenLabsVoiceProvider,
    QuietHoursPolicy,
    VoiceProvider,
    VoiceProviderError,
    build_playback_adapter,
)
from mrie.voice.storage import PrunedSpeechArtifact, SpeechArtifactStore


class VoiceCapability(Capability):
    """Render speech, enforce local delivery policy, and audit each state change."""

    name = "voice"
    description = "Render speech and optionally play it through an approved local adapter"

    def __init__(
        self,
        config: dict[str, Any],
        project_root: Path,
        *,
        provider: VoiceProvider | None = None,
        playback_adapter: AudioPlaybackAdapter | None = None,
        clock: Callable[[], datetime] | None = None,
    ) -> None:
        self.config = config
        self.api_key_env = str(config.get("api_key_env", "ELEVENLABS_API_KEY"))
        self.provider = provider or ElevenLabsVoiceProvider(
            api_key_env=self.api_key_env,
            voice_id=str(config.get("voice_id", "XrExE9yKIg1WjnnlVkGX")),
            model_id=str(config.get("model_id", "eleven_flash_v2_5")),
            timeout_seconds=float(config.get("timeout_seconds", 60)),
        )
        self.playback = playback_adapter or build_playback_adapter(config.get("playback"))
        self.quiet_hours = QuietHoursPolicy(config.get("quiet_hours"), clock=clock)
        self.max_text_characters = max(
            1,
            min(int(config.get("max_text_characters", 20_000)), 100_000),
        )
        self.log_dir = project_root / "logs" / "speech"
        self.log_dir.mkdir(parents=True, exist_ok=True)
        self.storage = SpeechArtifactStore(
            project_root=project_root,
            audit_dir=self.log_dir,
            config=config,
        )
        self._delivery_lock = asyncio.Lock()
        startup_retention = self.storage.prune()
        self._record_retention_events(startup_retention.removed)

    @property
    def voice_id(self) -> str:
        return self.provider.voice_id

    @property
    def model_id(self) -> str:
        return self.provider.model_id

    def get_tools(self) -> list[ToolDefinition]:
        return [
            ToolDefinition(
                name="speak",
                description="Render text and request policy-controlled local speech delivery",
                parameters={
                    "type": "object",
                    "properties": {
                        "text": {"type": "string"},
                        "trigger": {"type": "string", "default": "agent"},
                        "severity": {"type": "string", "default": "informational"},
                        "playback": {"type": "boolean", "default": True},
                    },
                    "required": ["text"],
                },
            ),
            ToolDefinition(
                name="status",
                description="Report TTS, playback, quiet-hours, and pending-delivery state",
                parameters={"type": "object", "properties": {}},
            ),
        ]

    async def invoke(self, method: str, **kwargs: Any) -> CapabilityResult:
        if method == "speak":
            return await self.speak(**kwargs)
        if method == "status":
            return await self.status()
        return CapabilityResult(success=False, error=f"Unknown method: {method}")

    async def status(self) -> CapabilityResult:
        counts, storage = await asyncio.gather(
            asyncio.to_thread(self._delivery_counts),
            asyncio.to_thread(self.storage.status),
        )
        return CapabilityResult(
            success=True,
            data={
                "synthesis": self.provider.status(),
                "playback": self.playback.status(),
                "quiet_hours": self.quiet_hours.status(),
                "delivery_counts": counts,
                "played_semantics": "local_player_completed",
                "storage": storage,
            },
        )

    async def speak(
        self,
        text: str,
        trigger: str = "agent",
        severity: str = "informational",
        playback: bool = True,
    ) -> CapabilityResult:
        normalized_text = text.strip()
        if not normalized_text:
            return CapabilityResult(success=False, error="Speech text cannot be empty")
        if len(normalized_text) > self.max_text_characters:
            return CapabilityResult(
                success=False,
                error=f"Speech text exceeds {self.max_text_characters} characters",
            )

        async with self._delivery_lock:
            return await self._speak_locked(
                normalized_text,
                trigger=trigger,
                severity=severity,
                playback_requested=playback,
            )

    async def _speak_locked(
        self,
        text: str,
        *,
        trigger: str,
        severity: str,
        playback_requested: bool,
    ) -> CapabilityResult:
        utterance_id = str(uuid.uuid4())
        log_file = self.log_dir / f"speech-{datetime.now(UTC).strftime('%Y%m%d')}.jsonl"
        base_event = {
            "utterance_id": utterance_id,
            "text": text,
            "provider": self.provider.name,
            "voice_id": self.voice_id,
            "model_id": self.model_id,
            "trigger": trigger,
            "severity": severity,
        }
        self._record(log_file, base_event, status="planned")

        try:
            audio = await self.provider.synthesize(text)
        except VoiceProviderError as exc:
            self._record(log_file, base_event, status="render_failed", reason=exc.code)
            return CapabilityResult(
                success=False,
                error=f"Speech rendering failed ({exc.code})",
                data=self._result_data(
                    utterance_id,
                    delivery_status="render_failed",
                    rendered=False,
                    queued=False,
                    played=False,
                    reason=exc.code,
                ),
            )
        except Exception as exc:  # noqa: BLE001 - isolate custom provider failures
            reason = f"provider_error_{type(exc).__name__}"
            self._record(log_file, base_event, status="render_failed", reason=reason)
            return CapabilityResult(
                success=False,
                error="Speech rendering failed (provider_error)",
                data=self._result_data(
                    utterance_id,
                    delivery_status="render_failed",
                    rendered=False,
                    queued=False,
                    played=False,
                    reason=reason,
                ),
            )

        try:
            audio_path = self.storage.audio_path(
                utterance_id=utterance_id,
                extension=audio.extension,
                now=datetime.now(UTC).strftime("%H%M%S"),
            )
        except ValueError:
            reason = "invalid_audio_extension"
            self._record(log_file, base_event, status="render_failed", reason=reason)
            return CapabilityResult(
                success=False,
                error="Speech rendering failed (invalid_audio_extension)",
                data=self._result_data(
                    utterance_id,
                    delivery_status="render_failed",
                    rendered=False,
                    queued=False,
                    played=False,
                    reason=reason,
                ),
            )

        if len(audio.content) > self.storage.policy.max_total_bytes:
            reason = "audio_exceeds_retention_limit"
            self._record(log_file, base_event, status="render_failed", reason=reason)
            return CapabilityResult(
                success=False,
                error="Speech rendering failed (audio_exceeds_retention_limit)",
                data=self._result_data(
                    utterance_id,
                    delivery_status="render_failed",
                    rendered=False,
                    queued=False,
                    played=False,
                    reason=reason,
                ),
            )

        self.storage.protect(audio_path)
        reservation = await asyncio.to_thread(
            self.storage.prune,
            reserve_files=1,
            reserve_bytes=len(audio.content),
        )
        self._record_retention_events(reservation.removed)
        if not reservation.fits:
            self.storage.release(audio_path)
            reason = "speech_storage_capacity_exhausted"
            self._record(log_file, base_event, status="render_failed", reason=reason)
            return CapabilityResult(
                success=False,
                error="Speech rendering failed (speech_storage_capacity_exhausted)",
                data=self._result_data(
                    utterance_id,
                    delivery_status="render_failed",
                    rendered=False,
                    queued=False,
                    played=False,
                    reason=reason,
                ),
            )

        try:
            try:
                await asyncio.to_thread(audio_path.write_bytes, audio.content)
            except OSError:
                reason = "speech_storage_write_failed"
                self._record(log_file, base_event, status="render_failed", reason=reason)
                return CapabilityResult(
                    success=False,
                    error="Speech rendering failed (speech_storage_write_failed)",
                    data=self._result_data(
                        utterance_id,
                        delivery_status="render_failed",
                        rendered=False,
                        queued=False,
                        played=False,
                        reason=reason,
                    ),
                )
            return await self._deliver_rendered(
                audio_path=audio_path,
                audio=audio.content,
                log_file=log_file,
                base_event=base_event,
                utterance_id=utterance_id,
                trigger=trigger,
                severity=severity,
                playback_requested=playback_requested,
            )
        finally:
            self.storage.release(audio_path)
            retention = await asyncio.to_thread(self.storage.prune)
            self._record_retention_events(retention.removed)

    async def _deliver_rendered(
        self,
        *,
        audio_path: Path,
        audio: bytes,
        log_file: Path,
        base_event: dict[str, Any],
        utterance_id: str,
        trigger: str,
        severity: str,
        playback_requested: bool,
    ) -> CapabilityResult:
        digest = hashlib.sha256(audio).hexdigest()
        audio_fields = {"audio_path": str(audio_path), "audio_sha256": digest}
        self._record(log_file, base_event, status="rendered", **audio_fields)

        if not playback_requested:
            return self._queue_result(
                log_file,
                base_event,
                utterance_id,
                audio_fields,
                reason="playback_not_requested",
            )

        decision = self.quiet_hours.evaluate(trigger=trigger, severity=severity)
        if not decision.allow_playback:
            return self._queue_result(
                log_file,
                base_event,
                utterance_id,
                audio_fields,
                reason=decision.reason,
            )
        if not self.playback.available:
            reason = str(self.playback.status().get("reason", "playback_unavailable"))
            return self._queue_result(
                log_file,
                base_event,
                utterance_id,
                audio_fields,
                reason=reason,
            )

        self._record(
            log_file,
            base_event,
            status="queued",
            reason="local_playback_pending",
            playback_provider=self.playback.name,
            **audio_fields,
        )
        playback_result = await self.playback.play(audio_path)
        if playback_result.success:
            self._record(
                log_file,
                base_event,
                status="played",
                playback_provider=playback_result.backend,
                **audio_fields,
            )
            return CapabilityResult(
                success=True,
                data=self._result_data(
                    utterance_id,
                    delivery_status="played",
                    rendered=True,
                    queued=False,
                    played=True,
                    audio_path=str(audio_path),
                    audio_sha256=digest,
                    playback_provider=playback_result.backend,
                ),
            )

        reason = playback_result.error_code or "playback_failed"
        self._record(
            log_file,
            base_event,
            status="play_failed",
            reason=reason,
            playback_provider=playback_result.backend,
            **audio_fields,
        )
        return CapabilityResult(
            success=False,
            error=f"Speech playback failed ({reason})",
            data=self._result_data(
                utterance_id,
                delivery_status="play_failed",
                rendered=True,
                queued=False,
                played=False,
                reason=reason,
                audio_path=str(audio_path),
                audio_sha256=digest,
                playback_provider=playback_result.backend,
            ),
        )

    def _record_retention_events(
        self, artifacts: tuple[PrunedSpeechArtifact, ...]
    ) -> None:
        if not artifacts:
            return
        log_file = self.log_dir / f"speech-{datetime.now(UTC).strftime('%Y%m%d')}.jsonl"
        policy = self.storage.policy.as_dict()
        for artifact in artifacts:
            base_event = {
                "utterance_id": artifact.utterance_id,
                "text": artifact.text or "",
                "provider": artifact.provider or "unknown",
                "voice_id": artifact.voice_id or "unknown",
                "model_id": artifact.model_id or "unknown",
                "trigger": artifact.trigger or "retention",
                "severity": artifact.severity or "informational",
            }
            audio_fields: dict[str, Any] = {
                "audio_path": str(artifact.path),
                "audio_bytes": artifact.size_bytes,
                "retention_reason": artifact.reason,
                "delivery_status_before_prune": artifact.previous_status,
                "retention_policy": policy,
                "orphaned_artifact": artifact.orphaned,
            }
            if artifact.audio_sha256:
                audio_fields["audio_sha256"] = artifact.audio_sha256
            self._record(
                log_file,
                base_event,
                status="retention_pruned",
                **audio_fields,
            )

    def _queue_result(
        self,
        log_file: Path,
        base_event: dict[str, Any],
        utterance_id: str,
        audio_fields: dict[str, str],
        *,
        reason: str,
    ) -> CapabilityResult:
        self._record(
            log_file,
            base_event,
            status="queued",
            reason=reason,
            playback_provider=self.playback.name,
            **audio_fields,
        )
        return CapabilityResult(
            success=True,
            data=self._result_data(
                utterance_id,
                delivery_status="queued",
                rendered=True,
                queued=True,
                played=False,
                reason=reason,
                playback_provider=self.playback.name,
                **audio_fields,
            ),
        )

    @staticmethod
    def _result_data(
        utterance_id: str,
        *,
        delivery_status: str,
        rendered: bool,
        queued: bool,
        played: bool,
        **extra: Any,
    ) -> dict[str, Any]:
        return {
            "utterance_id": utterance_id,
            "logged": True,
            "delivery_status": delivery_status,
            "rendered": rendered,
            "queued": queued,
            "played": played,
            **extra,
        }

    @staticmethod
    def _record(path: Path, base: dict[str, Any], *, status: str, **extra: Any) -> None:
        entry = {
            **base,
            "timestamp": datetime.now(UTC).isoformat(),
            "status": status,
            **extra,
        }
        with path.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(entry) + "\n")

    def _delivery_counts(self) -> dict[str, int]:
        latest: dict[str, str] = {}
        for log_file in sorted(self.log_dir.glob("speech-*.jsonl")):
            try:
                with log_file.open(encoding="utf-8") as handle:
                    for line in handle:
                        try:
                            entry = json.loads(line)
                        except json.JSONDecodeError:
                            continue
                        utterance_id = entry.get("utterance_id")
                        status = entry.get("status")
                        if isinstance(utterance_id, str) and isinstance(status, str):
                            latest[utterance_id] = status
            except OSError:
                continue
        counts = {
            "planned": 0,
            "rendered": 0,
            "queued": 0,
            "played": 0,
            "render_failed": 0,
            "play_failed": 0,
            "retention_pruned": 0,
        }
        for status in latest.values():
            if status in counts:
                counts[status] += 1
        return counts
