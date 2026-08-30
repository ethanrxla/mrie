"""Capability package — factory for default registry."""

from __future__ import annotations

from pathlib import Path
from typing import Any

from mrie.capabilities.audio_input import AudioInputCapability
from mrie.capabilities.extensions import PluginCapability, SkillCapability
from mrie.capabilities.filesystem import FilesystemCapability
from mrie.capabilities.honeypot import HoneypotCapability
from mrie.capabilities.mcp_bridge import MCPCapability
from mrie.capabilities.networking import NetworkingCapability
from mrie.capabilities.news import NewsCapability
from mrie.capabilities.reddit import RedditCapability
from mrie.capabilities.social_feeds import InstagramCapability, YouTubeCapability
from mrie.capabilities.speech_log import SpeechLogCapability
from mrie.capabilities.tailscale import TailscaleCapability
from mrie.capabilities.voice import VoiceCapability
from mrie.capabilities.wazuh import WazuhCapability
from mrie.capabilities.web_scrape import WebScrapeCapability
from mrie.core.capability_base import CapabilityRegistry
from mrie.security.store import SecurityEventStore


def build_default_registry(config: dict[str, Any], project_root: Path) -> CapabilityRegistry:
    registry = CapabilityRegistry()
    event_store = SecurityEventStore(project_root / ".mrie" / "security-events.sqlite3")
    registry.register(NewsCapability(config.get("news", {})))
    registry.register(WebScrapeCapability(config.get("web", {})))
    registry.register(YouTubeCapability(config.get("youtube", {})))
    registry.register(InstagramCapability(config.get("instagram", {})))
    registry.register(RedditCapability(config.get("reddit", {})))
    registry.register(MCPCapability(config.get("mcp_servers", {}), project_root))
    registry.register(PluginCapability(config.get("plugins", {}), project_root))
    registry.register(SkillCapability(config.get("skills", {}), project_root))
    registry.register(FilesystemCapability(config.get("filesystem", {}), project_root))
    registry.register(TailscaleCapability(config.get("tailscale", {})))
    registry.register(NetworkingCapability(config.get("networking", {})))
    registry.register(VoiceCapability(config.get("voice", {}), project_root))
    registry.register(AudioInputCapability(config.get("audio_input", {})))
    registry.register(SpeechLogCapability(project_root))
    registry.register(WazuhCapability(config.get("wazuh", {}), event_store))
    registry.register(HoneypotCapability(config.get("honeypot", {}), event_store))
    return registry
