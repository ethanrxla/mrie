"""Audio input capability — speech-to-text."""

from __future__ import annotations

from typing import Any

from mrie.core.capability_base import Capability, CapabilityResult, ToolDefinition


class AudioInputCapability(Capability):
    name = "audio_input"
    description = "Receive and transcribe audio input"

    def __init__(self, config: dict[str, Any]) -> None:
        self.config = config
        self.provider = config.get("provider", "whisper_local")
        self.elevenlabs_key_env = config.get("elevenlabs_key_env", "ELEVENLABS_API_KEY")

    def get_tools(self) -> list[ToolDefinition]:
        return [
            ToolDefinition(
                name="transcribe",
                description="Transcribe audio file to text",
                parameters={
                    "type": "object",
                    "properties": {"audio_path": {"type": "string"}},
                    "required": ["audio_path"],
                },
            ),
        ]

    async def invoke(self, method: str, **kwargs: Any) -> CapabilityResult:
        if method == "transcribe":
            return CapabilityResult(
                success=True,
                data={
                    "audio_path": kwargs.get("audio_path"),
                    "text": "",
                    "note": f"STT via {self.provider} — wire Whisper or ElevenLabs STT",
                },
            )
        return CapabilityResult(success=False, error=f"Unknown method: {method}")
