"""Provider-neutral speech synthesis, delivery policy, and playback adapters."""

from mrie.voice.playback import (
    AudioPlaybackAdapter,
    DisabledPlaybackAdapter,
    FFplayPlaybackAdapter,
    PlaybackResult,
    WindowsMediaPlaybackAdapter,
    build_playback_adapter,
)
from mrie.voice.policy import QuietHoursPolicy, SpeechDecision
from mrie.voice.providers import (
    ElevenLabsVoiceProvider,
    SynthesizedAudio,
    VoiceProvider,
    VoiceProviderError,
)

__all__ = [
    "AudioPlaybackAdapter",
    "DisabledPlaybackAdapter",
    "ElevenLabsVoiceProvider",
    "FFplayPlaybackAdapter",
    "PlaybackResult",
    "QuietHoursPolicy",
    "SpeechDecision",
    "SynthesizedAudio",
    "VoiceProvider",
    "VoiceProviderError",
    "WindowsMediaPlaybackAdapter",
    "build_playback_adapter",
]
