"""Local audio playback adapters for unattended MRE speech."""

from __future__ import annotations

import asyncio
import os
import shutil
import sys
from abc import ABC, abstractmethod
from dataclasses import dataclass
from pathlib import Path
from typing import Any


@dataclass(frozen=True, slots=True)
class PlaybackResult:
    """Result of handing one complete audio file to a local player."""

    success: bool
    backend: str
    error_code: str | None = None


class AudioPlaybackAdapter(ABC):
    """Provider-neutral local playback boundary."""

    name: str

    @property
    @abstractmethod
    def available(self) -> bool:
        """Whether this adapter can attempt playback on the current host."""

    @abstractmethod
    async def play(self, audio_path: Path) -> PlaybackResult:
        """Block until playback completes or fails."""

    def status(self) -> dict[str, Any]:
        return {"provider": self.name, "available": self.available}


class DisabledPlaybackAdapter(AudioPlaybackAdapter):
    """Explicit no-player adapter that keeps rendered audio queued on disk."""

    name = "disabled"

    def __init__(self, reason: str = "playback_disabled") -> None:
        self.reason = reason

    @property
    def available(self) -> bool:
        return False

    async def play(self, audio_path: Path) -> PlaybackResult:
        del audio_path
        return PlaybackResult(False, self.name, self.reason)

    def status(self) -> dict[str, Any]:
        return {**super().status(), "reason": self.reason}


class FFplayPlaybackAdapter(AudioPlaybackAdapter):
    """Cross-platform playback through an operator-installed ffplay executable."""

    name = "ffplay"

    def __init__(self, executable: str, timeout_seconds: float = 180) -> None:
        self.executable = executable
        self.timeout_seconds = max(1.0, min(float(timeout_seconds), 900.0))

    @property
    def available(self) -> bool:
        return bool(self.executable)

    async def play(self, audio_path: Path) -> PlaybackResult:
        try:
            resolved = await asyncio.to_thread(audio_path.resolve, strict=True)
        except OSError:
            return PlaybackResult(False, self.name, "audio_file_missing")
        if not await asyncio.to_thread(resolved.is_file):
            return PlaybackResult(False, self.name, "audio_file_missing")
        if resolved.suffix.lower() not in {".mp3", ".wav", ".ogg", ".m4a", ".aac"}:
            return PlaybackResult(False, self.name, "audio_format_not_allowed")

        try:
            process = await asyncio.create_subprocess_exec(
                self.executable,
                "-nodisp",
                "-autoexit",
                "-loglevel",
                "error",
                "-i",
                str(resolved),
                stdin=asyncio.subprocess.DEVNULL,
                stdout=asyncio.subprocess.DEVNULL,
                stderr=asyncio.subprocess.DEVNULL,
            )
        except (FileNotFoundError, OSError):
            return PlaybackResult(False, self.name, "player_start_failed")

        try:
            return_code = await asyncio.wait_for(process.wait(), timeout=self.timeout_seconds)
        except asyncio.CancelledError:
            process.terminate()
            try:
                await asyncio.wait_for(process.wait(), timeout=2)
            except TimeoutError:
                process.kill()
                await process.wait()
            raise
        except TimeoutError:
            process.kill()
            await process.wait()
            return PlaybackResult(False, self.name, "player_timeout")

        if return_code != 0:
            return PlaybackResult(False, self.name, "player_exit_nonzero")
        return PlaybackResult(True, self.name)

    def status(self) -> dict[str, Any]:
        return {
            **super().status(),
            "executable": self.executable,
            "timeout_seconds": self.timeout_seconds,
        }


WINDOWS_MEDIA_SCRIPT = r"""
$ErrorActionPreference = 'Stop'
$player = $null
$exitCode = 24
try {
    $audioPath = [Environment]::GetEnvironmentVariable('MRE_AUDIO_PATH', 'Process')
    $timeoutValue = [Environment]::GetEnvironmentVariable('MRE_PLAYBACK_TIMEOUT', 'Process')
    if ([String]::IsNullOrWhiteSpace($audioPath) -or -not [IO.File]::Exists($audioPath)) {
        $exitCode = 20
    } else {
        $timeoutSeconds = 180
        if (-not [Int32]::TryParse($timeoutValue, [ref]$timeoutSeconds)) {
            $timeoutSeconds = 180
        }
        Add-Type -AssemblyName PresentationCore
        $player = New-Object System.Windows.Media.MediaPlayer
        $player.Open([Uri]$audioPath)
        $player.Play()
        $deadline = [DateTime]::UtcNow.AddSeconds($timeoutSeconds)
        $sawProgress = $false
        $endSamples = 0
        while ([DateTime]::UtcNow -lt $deadline) {
            if ($player.NaturalDuration.HasTimeSpan) {
                $duration = $player.NaturalDuration.TimeSpan.TotalMilliseconds
                $position = $player.Position.TotalMilliseconds
                if ($position -gt 25) {
                    $sawProgress = $true
                }
                $tolerance = [Math]::Max(25, [Math]::Min(250, $duration * 0.02))
                if ($sawProgress -and $duration -gt 0 -and $position -ge ($duration - $tolerance)) {
                    $endSamples += 1
                    if ($endSamples -ge 3) {
                        $exitCode = 0
                        break
                    }
                } else {
                    $endSamples = 0
                }
            }
            Start-Sleep -Milliseconds 100
        }
        if ($exitCode -eq 24) {
            if ($sawProgress) { $exitCode = 21 } else { $exitCode = 23 }
        }
    }
} catch {
    $exitCode = 24
} finally {
    if ($null -ne $player) {
        try { $player.Stop() } catch {}
        try { $player.Close() } catch {}
    }
}
exit $exitCode
""".strip()

WINDOWS_PLAYER_ENV_ALLOWLIST = (
    "SystemRoot",
    "WINDIR",
    "PATH",
    "PATHEXT",
    "TEMP",
    "TMP",
)


class WindowsMediaPlaybackAdapter(AudioPlaybackAdapter):
    """Windows-only .NET media playback with verifiable media-clock completion."""

    name = "windows_media"
    _EXIT_ERRORS = {
        20: "audio_file_missing",
        21: "player_timeout",
        23: "playback_never_started",
        24: "player_backend_error",
    }

    def __init__(self, powershell_executable: str, timeout_seconds: float = 180) -> None:
        self.powershell_executable = powershell_executable
        self.timeout_seconds = max(1.0, min(float(timeout_seconds), 900.0))

    @property
    def available(self) -> bool:
        return bool(self.powershell_executable) and sys.platform == "win32"

    async def play(self, audio_path: Path) -> PlaybackResult:
        try:
            resolved = await asyncio.to_thread(audio_path.resolve, strict=True)
        except OSError:
            return PlaybackResult(False, self.name, "audio_file_missing")
        if not await asyncio.to_thread(resolved.is_file):
            return PlaybackResult(False, self.name, "audio_file_missing")
        if resolved.suffix.lower() not in {".mp3", ".wav", ".wma"}:
            return PlaybackResult(False, self.name, "audio_format_not_allowed")

        child_env = {
            name: os.environ[name]
            for name in WINDOWS_PLAYER_ENV_ALLOWLIST
            if name in os.environ
        }
        child_env["MRE_AUDIO_PATH"] = os.fspath(resolved)
        child_env["MRE_PLAYBACK_TIMEOUT"] = str(int(self.timeout_seconds))
        try:
            process = await asyncio.create_subprocess_exec(
                self.powershell_executable,
                "-NoLogo",
                "-NoProfile",
                "-NonInteractive",
                "-Sta",
                "-Command",
                WINDOWS_MEDIA_SCRIPT,
                stdin=asyncio.subprocess.DEVNULL,
                stdout=asyncio.subprocess.DEVNULL,
                stderr=asyncio.subprocess.DEVNULL,
                env=child_env,
            )
        except (FileNotFoundError, OSError):
            return PlaybackResult(False, self.name, "player_start_failed")

        try:
            return_code = await asyncio.wait_for(
                process.wait(),
                timeout=self.timeout_seconds + 10,
            )
        except asyncio.CancelledError:
            process.kill()
            await process.wait()
            raise
        except TimeoutError:
            process.kill()
            await process.wait()
            return PlaybackResult(False, self.name, "player_timeout")

        if return_code != 0:
            error = self._EXIT_ERRORS.get(return_code, "player_exit_nonzero")
            return PlaybackResult(False, self.name, error)
        return PlaybackResult(True, self.name)

    def status(self) -> dict[str, Any]:
        return {
            **super().status(),
            "powershell_executable": self.powershell_executable,
            "timeout_seconds": self.timeout_seconds,
            "completion_signal": "media_clock_reached_natural_duration",
            "runtime": "PresentationCore.MediaPlayer",
        }


def build_playback_adapter(config: dict[str, Any] | None) -> AudioPlaybackAdapter:
    """Build an allowlisted playback adapter without accepting shell commands."""

    playback = config or {}
    requested = str(playback.get("provider", "auto")).strip().lower()
    timeout_seconds = float(playback.get("timeout_seconds", 900))

    if requested == "disabled":
        return DisabledPlaybackAdapter()
    if requested not in {"auto", "ffplay", "windows_media"}:
        return DisabledPlaybackAdapter("unsupported_playback_provider")

    if requested in {"auto", "ffplay"}:
        configured_path = str(playback.get("ffplay_path", "")).strip()
        if configured_path:
            candidate = Path(configured_path).expanduser()
            allowed_names = {"ffplay", "ffplay.exe"}
            if candidate.name.lower() not in allowed_names:
                return DisabledPlaybackAdapter("invalid_ffplay_path")
            if not candidate.is_absolute() or not candidate.is_file():
                return DisabledPlaybackAdapter("ffplay_not_found")
            executable = os.fspath(candidate.resolve())
        else:
            executable = shutil.which("ffplay") or ""
        if executable:
            return FFplayPlaybackAdapter(executable, timeout_seconds=timeout_seconds)
        if requested == "ffplay":
            return DisabledPlaybackAdapter("ffplay_not_found")

    if requested in {"auto", "windows_media"} and sys.platform == "win32":
        powershell = shutil.which("powershell.exe") or shutil.which("powershell") or ""
        windows_dir = os.environ.get("WINDIR", r"C:\Windows")
        system_powershell = (
            Path(windows_dir)
            / "System32"
            / "WindowsPowerShell"
            / "v1.0"
            / "powershell.exe"
        )
        if not powershell and system_powershell.is_file():
            powershell = os.fspath(system_powershell)
        if powershell:
            return WindowsMediaPlaybackAdapter(
                powershell,
                timeout_seconds=timeout_seconds,
            )
        if requested == "windows_media":
            return DisabledPlaybackAdapter("windows_media_runtime_not_found")

    return DisabledPlaybackAdapter("no_supported_player")
