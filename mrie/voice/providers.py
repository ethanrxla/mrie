"""Replaceable server-side text-to-speech provider contracts."""

from __future__ import annotations

import os
from abc import ABC, abstractmethod
from dataclasses import dataclass
from typing import Any

import httpx

DEFAULT_ELEVENLABS_VOICE_ID = "XrExE9yKIg1WjnnlVkGX"
DEFAULT_ELEVENLABS_MODEL_ID = "eleven_flash_v2_5"
MAX_AUDIO_BYTES = 25 * 1024 * 1024


@dataclass(frozen=True, slots=True)
class SynthesizedAudio:
    """Audio returned by a voice provider, before local delivery."""

    content: bytes
    extension: str
    content_type: str
    provider: str
    model_id: str
    voice_id: str


class VoiceProviderError(RuntimeError):
    """A safe, stable voice-provider failure without response-body leakage."""

    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


class VoiceProvider(ABC):
    """Text-to-speech boundary used by the unattended Python runtime."""

    name: str
    model_id: str
    voice_id: str

    @property
    @abstractmethod
    def configured(self) -> bool:
        """Whether the provider has the credentials needed to run."""

    @abstractmethod
    async def synthesize(self, text: str) -> SynthesizedAudio:
        """Render text to an audio payload or raise ``VoiceProviderError``."""

    def status(self) -> dict[str, Any]:
        return {
            "provider": self.name,
            "configured": self.configured,
            "model_id": self.model_id,
            "voice_id": self.voice_id,
        }


class ElevenLabsVoiceProvider(VoiceProvider):
    """ElevenLabs REST adapter; credentials are read only at call time."""

    name = "elevenlabs"

    def __init__(
        self,
        *,
        api_key_env: str = "ELEVENLABS_API_KEY",
        voice_id: str = DEFAULT_ELEVENLABS_VOICE_ID,
        model_id: str = DEFAULT_ELEVENLABS_MODEL_ID,
        timeout_seconds: float = 60,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        self.api_key_env = api_key_env
        self.voice_id = voice_id
        self.model_id = model_id
        self.timeout_seconds = max(1.0, min(float(timeout_seconds), 180.0))
        self.transport = transport

    @property
    def configured(self) -> bool:
        return bool(os.environ.get(self.api_key_env))

    async def synthesize(self, text: str) -> SynthesizedAudio:
        api_key = os.environ.get(self.api_key_env)
        if not api_key:
            raise VoiceProviderError("provider_not_configured")

        try:
            async with httpx.AsyncClient(
                timeout=self.timeout_seconds,
                transport=self.transport,
            ) as client:
                response = await client.post(
                    f"https://api.elevenlabs.io/v1/text-to-speech/{self.voice_id}",
                    headers={
                        "xi-api-key": api_key,
                        "Content-Type": "application/json",
                        "Accept": "audio/mpeg",
                    },
                    json={"text": text, "model_id": self.model_id},
                )
        except httpx.TimeoutException as exc:
            raise VoiceProviderError("provider_timeout") from exc
        except httpx.HTTPError as exc:
            raise VoiceProviderError("provider_transport_error") from exc

        if response.status_code in {401, 403}:
            raise VoiceProviderError("provider_authentication_failed")
        if response.status_code == 429:
            raise VoiceProviderError("provider_rate_limited")
        if response.status_code < 200 or response.status_code >= 300:
            raise VoiceProviderError("provider_request_failed")
        if not response.content:
            raise VoiceProviderError("provider_returned_empty_audio")
        if len(response.content) > MAX_AUDIO_BYTES:
            raise VoiceProviderError("provider_audio_too_large")

        content_type = response.headers.get("content-type", "audio/mpeg").split(";", 1)[0]
        return SynthesizedAudio(
            content=response.content,
            extension="mp3",
            content_type=content_type,
            provider=self.name,
            model_id=self.model_id,
            voice_id=self.voice_id,
        )
