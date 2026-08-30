from __future__ import annotations

import asyncio
import json
from datetime import UTC, datetime
from pathlib import Path

import httpx
import pytest

from mrie.capabilities.voice import VoiceCapability
from mrie.voice import (
    AudioPlaybackAdapter,
    DisabledPlaybackAdapter,
    ElevenLabsVoiceProvider,
    PlaybackResult,
    SynthesizedAudio,
    VoiceProvider,
    VoiceProviderError,
    WindowsMediaPlaybackAdapter,
    build_playback_adapter,
)
from mrie.voice.providers import (
    DEFAULT_ELEVENLABS_MODEL_ID,
    DEFAULT_ELEVENLABS_VOICE_ID,
)


class FakeVoiceProvider(VoiceProvider):
    name = "fake_voice"
    model_id = "test-model"
    voice_id = "test-voice"

    def __init__(self, error: str | None = None) -> None:
        self.error = error
        self.calls: list[str] = []

    @property
    def configured(self) -> bool:
        return self.error != "provider_not_configured"

    async def synthesize(self, text: str) -> SynthesizedAudio:
        self.calls.append(text)
        if self.error:
            raise VoiceProviderError(self.error)
        return SynthesizedAudio(
            content=b"ID3-test-audio",
            extension="mp3",
            content_type="audio/mpeg",
            provider=self.name,
            model_id=self.model_id,
            voice_id=self.voice_id,
        )


class FakePlaybackAdapter(AudioPlaybackAdapter):
    name = "fake_player"

    def __init__(self, result: PlaybackResult | None = None) -> None:
        self.result = result or PlaybackResult(True, self.name)
        self.paths: list[Path] = []

    @property
    def available(self) -> bool:
        return True

    async def play(self, audio_path: Path) -> PlaybackResult:
        self.paths.append(audio_path)
        return self.result


class BlockingPlaybackAdapter(AudioPlaybackAdapter):
    name = "blocking_player"

    def __init__(self) -> None:
        self.started = asyncio.Event()
        self.release = asyncio.Event()
        self.path: Path | None = None

    @property
    def available(self) -> bool:
        return True

    async def play(self, audio_path: Path) -> PlaybackResult:
        self.path = audio_path
        assert await asyncio.to_thread(audio_path.exists)
        self.started.set()
        await self.release.wait()
        assert await asyncio.to_thread(audio_path.exists)
        return PlaybackResult(True, self.name)


def read_states(root: Path) -> list[dict[str, object]]:
    log_file = next((root / "logs" / "speech").glob("speech-*.jsonl"))
    return [json.loads(line) for line in log_file.read_text(encoding="utf-8").splitlines()]


@pytest.mark.asyncio
async def test_voice_records_full_success_lifecycle(tmp_path: Path) -> None:
    provider = FakeVoiceProvider()
    player = FakePlaybackAdapter()
    capability = VoiceCapability(
        {},
        tmp_path,
        provider=provider,
        playback_adapter=player,
    )

    result = await capability.speak(
        "MRE briefing ready.",
        trigger="operator",
        severity="informational",
    )

    assert result.success is True
    assert result.data["delivery_status"] == "played"
    assert result.data["rendered"] is True
    assert result.data["played"] is True
    assert len(player.paths) == 1
    assert player.paths[0].read_bytes() == b"ID3-test-audio"
    events = read_states(tmp_path)
    assert [event["status"] for event in events] == [
        "planned",
        "rendered",
        "queued",
        "played",
    ]
    assert all(event["provider"] == "fake_voice" for event in events)
    assert all(event["voice_id"] == "test-voice" for event in events)

    status = await capability.status()
    assert status.success is True
    assert status.data["delivery_counts"]["played"] == 1
    assert status.data["played_semantics"] == "local_player_completed"


@pytest.mark.asyncio
async def test_rendered_audio_is_queued_when_no_player_exists(tmp_path: Path) -> None:
    capability = VoiceCapability(
        {},
        tmp_path,
        provider=FakeVoiceProvider(),
        playback_adapter=DisabledPlaybackAdapter("no_supported_player"),
    )

    result = await capability.speak("Keep this for later.")

    assert result.success is True
    assert result.data["delivery_status"] == "queued"
    assert result.data["rendered"] is True
    assert result.data["queued"] is True
    assert result.data["played"] is False
    assert result.data["reason"] == "no_supported_player"
    assert [event["status"] for event in read_states(tmp_path)] == [
        "planned",
        "rendered",
        "queued",
    ]


@pytest.mark.asyncio
async def test_storage_environment_override_keeps_private_audit_separate(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    audio_dir = tmp_path / "data-volume" / "speech"
    monkeypatch.setenv("TEST_MRE_SPEECH_DIR", str(audio_dir))
    capability = VoiceCapability(
        {"storage_dir_env": "TEST_MRE_SPEECH_DIR"},
        tmp_path,
        provider=FakeVoiceProvider(),
        playback_adapter=DisabledPlaybackAdapter("text_only"),
    )

    result = await capability.speak("Stored away from the audit directory.")

    audio_path = Path(result.data["audio_path"])
    assert audio_path.parent == audio_dir.resolve()
    assert await asyncio.to_thread(audio_path.exists)
    assert next((tmp_path / "logs" / "speech").glob("speech-*.jsonl")).exists()
    status = await capability.status()
    assert status.data["storage"]["directory_configured"] is True
    assert str(audio_dir.resolve()) not in json.dumps(status.data)


def test_storage_rejects_a_filesystem_root(tmp_path: Path) -> None:
    with pytest.raises(ValueError, match="dedicated directory"):
        VoiceCapability(
            {"storage_dir": tmp_path.anchor},
            tmp_path,
            provider=FakeVoiceProvider(),
            playback_adapter=DisabledPlaybackAdapter("text_only"),
        )


@pytest.mark.asyncio
async def test_retention_prunes_oldest_queued_audio_and_audits_truth(
    tmp_path: Path,
) -> None:
    audio_dir = tmp_path / "bounded-audio"
    unrelated = audio_dir / "operator-note.txt"
    audio_dir.mkdir()
    unrelated.write_text("not owned by MRE", encoding="utf-8")
    capability = VoiceCapability(
        {
            "storage_dir": str(audio_dir),
            "retention": {
                "max_files": 1,
                "max_total_bytes": 1024,
                "max_age_days": 14,
            },
        },
        tmp_path,
        provider=FakeVoiceProvider(),
        playback_adapter=DisabledPlaybackAdapter("no_supported_player"),
    )

    first = await capability.speak("First queued utterance")
    second = await capability.speak("Second queued utterance")

    assert not await asyncio.to_thread(Path(first.data["audio_path"]).exists)
    assert await asyncio.to_thread(Path(second.data["audio_path"]).exists)
    assert unrelated.read_text(encoding="utf-8") == "not owned by MRE"
    retention_event = next(
        event for event in read_states(tmp_path) if event["status"] == "retention_pruned"
    )
    assert retention_event["utterance_id"] == first.data["utterance_id"]
    assert retention_event["delivery_status_before_prune"] == "queued"
    assert retention_event["retention_reason"] == "max_files"
    status = await capability.status()
    assert status.data["storage"]["stored_files"] == 1
    assert status.data["delivery_counts"]["retention_pruned"] == 1


@pytest.mark.asyncio
async def test_retention_never_removes_audio_during_active_playback(tmp_path: Path) -> None:
    player = BlockingPlaybackAdapter()
    capability = VoiceCapability(
        {
            "storage_dir": str(tmp_path / "active-audio"),
            "retention": {
                "max_files": 1,
                "max_total_bytes": len(b"ID3-test-audio"),
                "max_age_days": 14,
            },
        },
        tmp_path,
        provider=FakeVoiceProvider(),
        playback_adapter=player,
    )

    delivery = asyncio.create_task(capability.speak("Do not prune during playback"))
    await asyncio.wait_for(player.started.wait(), timeout=1)
    assert player.path is not None

    reservation = await asyncio.to_thread(
        capability.storage.prune,
        reserve_files=1,
        reserve_bytes=1,
    )
    assert reservation.fits is False
    assert reservation.removed == ()
    assert player.path.exists()

    player.release.set()
    result = await asyncio.wait_for(delivery, timeout=1)
    assert result.data["delivery_status"] == "played"


@pytest.mark.asyncio
async def test_quiet_hours_queue_routine_speech_but_allow_critical(tmp_path: Path) -> None:
    def now() -> datetime:
        return datetime(2026, 8, 13, 3, 0, tzinfo=UTC)  # 23:00 in New York

    player = FakePlaybackAdapter()
    config = {
        "quiet_hours": {
            "enabled": True,
            "timezone": "America/New_York",
            "start": "22:00",
            "end": "07:00",
            "critical_override": True,
            "operator_override": False,
        }
    }
    capability = VoiceCapability(
        config,
        tmp_path,
        provider=FakeVoiceProvider(),
        playback_adapter=player,
        clock=now,
    )

    routine = await capability.speak("Routine briefing", trigger="briefing")
    critical = await capability.speak(
        "Critical security alert",
        trigger="security",
        severity="critical",
    )

    assert routine.data["delivery_status"] == "queued"
    assert routine.data["reason"] == "quiet_hours"
    assert routine.data["played"] is False
    assert critical.data["delivery_status"] == "played"
    assert critical.data["played"] is True
    assert len(player.paths) == 1


@pytest.mark.asyncio
async def test_playback_failure_is_not_reported_as_played(tmp_path: Path) -> None:
    player = FakePlaybackAdapter(
        PlaybackResult(False, "fake_player", "player_exit_nonzero")
    )
    capability = VoiceCapability(
        {},
        tmp_path,
        provider=FakeVoiceProvider(),
        playback_adapter=player,
    )

    result = await capability.speak("This player will fail.")

    assert result.success is False
    assert result.data["delivery_status"] == "play_failed"
    assert result.data["rendered"] is True
    assert result.data["played"] is False
    assert read_states(tmp_path)[-1]["status"] == "play_failed"


@pytest.mark.asyncio
async def test_render_failure_is_safe_and_audited(tmp_path: Path) -> None:
    capability = VoiceCapability(
        {},
        tmp_path,
        provider=FakeVoiceProvider("provider_authentication_failed"),
        playback_adapter=FakePlaybackAdapter(),
    )

    result = await capability.speak("Provider failure")

    assert result.success is False
    assert result.data["delivery_status"] == "render_failed"
    assert result.data["rendered"] is False
    assert result.data["played"] is False
    assert [event["status"] for event in read_states(tmp_path)] == [
        "planned",
        "render_failed",
    ]
    assert "provider_authentication_failed" in result.error


def test_elevenlabs_defaults_remain_matilda(tmp_path: Path) -> None:
    capability = VoiceCapability({}, tmp_path)

    assert capability.voice_id == DEFAULT_ELEVENLABS_VOICE_ID
    assert capability.voice_id == "XrExE9yKIg1WjnnlVkGX"
    assert capability.model_id == DEFAULT_ELEVENLABS_MODEL_ID
    assert capability.model_id == "eleven_flash_v2_5"


@pytest.mark.asyncio
async def test_elevenlabs_provider_uses_server_credential_and_bounded_shape(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("TEST_ELEVENLABS_KEY", "server-secret")

    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url == (
            "https://api.elevenlabs.io/v1/text-to-speech/XrExE9yKIg1WjnnlVkGX"
        )
        assert request.headers["xi-api-key"] == "server-secret"
        assert request.headers["accept"] == "audio/mpeg"
        assert json.loads(request.content) == {
            "text": "Provider adapter test",
            "model_id": "eleven_flash_v2_5",
        }
        return httpx.Response(
            200,
            content=b"ID3-provider-audio",
            headers={"content-type": "audio/mpeg"},
        )

    provider = ElevenLabsVoiceProvider(
        api_key_env="TEST_ELEVENLABS_KEY",
        transport=httpx.MockTransport(handler),
    )
    result = await provider.synthesize("Provider adapter test")

    assert result.content == b"ID3-provider-audio"
    assert result.provider == "elevenlabs"
    assert result.voice_id == DEFAULT_ELEVENLABS_VOICE_ID


@pytest.mark.asyncio
async def test_elevenlabs_provider_fails_explicitly_without_key(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("TEST_MISSING_ELEVENLABS_KEY", raising=False)
    provider = ElevenLabsVoiceProvider(api_key_env="TEST_MISSING_ELEVENLABS_KEY")

    with pytest.raises(VoiceProviderError, match="provider_not_configured"):
        await provider.synthesize("No network request should be attempted")


def test_playback_builder_rejects_arbitrary_executable_path(tmp_path: Path) -> None:
    arbitrary = tmp_path / "not-a-player.exe"
    arbitrary.write_bytes(b"not executable")

    adapter = build_playback_adapter(
        {"provider": "ffplay", "ffplay_path": str(arbitrary)}
    )

    assert adapter.available is False
    assert adapter.status()["reason"] == "invalid_ffplay_path"


@pytest.mark.asyncio
async def test_windows_media_requires_completion_exit_and_avoids_path_in_command(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    audio = tmp_path / "audio with spaces & punctuation.mp3"
    audio.write_bytes(b"ID3-test")
    monkeypatch.setenv("MRE_TEST_SECRET_MUST_NOT_REACH_PLAYER", "sensitive-value")
    captured: dict[str, object] = {}

    class FakeProcess:
        async def wait(self) -> int:
            return 0

        def kill(self) -> None:
            raise AssertionError("successful playback must not be killed")

    async def fake_create_subprocess_exec(*args: object, **kwargs: object) -> FakeProcess:
        captured["args"] = args
        captured["env"] = kwargs["env"]
        return FakeProcess()

    monkeypatch.setattr(asyncio, "create_subprocess_exec", fake_create_subprocess_exec)
    adapter = WindowsMediaPlaybackAdapter(
        r"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe",
        timeout_seconds=30,
    )

    result = await adapter.play(audio)

    assert result == PlaybackResult(True, "windows_media")
    command_args = captured["args"]
    assert isinstance(command_args, tuple)
    assert str(audio.resolve()) not in command_args
    child_env = captured["env"]
    assert isinstance(child_env, dict)
    assert child_env["MRE_AUDIO_PATH"] == str(audio.resolve())
    assert child_env["MRE_PLAYBACK_TIMEOUT"] == "30"
    assert "MRE_TEST_SECRET_MUST_NOT_REACH_PLAYER" not in child_env


@pytest.mark.asyncio
async def test_windows_media_nonterminal_result_is_failure(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    audio = tmp_path / "audio.mp3"
    audio.write_bytes(b"ID3-test")

    class FakeProcess:
        async def wait(self) -> int:
            return 23

        def kill(self) -> None:
            raise AssertionError("completed player process must not be killed")

    async def fake_create_subprocess_exec(*args: object, **kwargs: object) -> FakeProcess:
        del args, kwargs
        return FakeProcess()

    monkeypatch.setattr(asyncio, "create_subprocess_exec", fake_create_subprocess_exec)
    adapter = WindowsMediaPlaybackAdapter("powershell.exe", timeout_seconds=30)

    result = await adapter.play(audio)

    assert result.success is False
    assert result.error_code == "playback_never_started"
