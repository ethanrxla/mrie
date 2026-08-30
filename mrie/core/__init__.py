"""MRE core orchestration and infrastructure."""

from typing import TYPE_CHECKING, Any

from mrie.core.capability_base import Capability, CapabilityRegistry, CapabilityResult
from mrie.core.ethics_guard import EthicsGuard, EthicsVerdict

if TYPE_CHECKING:
    from mrie.core.orchestrator import MRIEOrchestrator

__all__ = [
    "Capability",
    "CapabilityRegistry",
    "CapabilityResult",
    "EthicsGuard",
    "EthicsVerdict",
    "MRIEOrchestrator",
]


def __getattr__(name: str) -> Any:
    """Keep the convenience export without an eager capability/core cycle."""

    if name == "MRIEOrchestrator":
        from mrie.core.orchestrator import MRIEOrchestrator

        return MRIEOrchestrator
    raise AttributeError(name)
