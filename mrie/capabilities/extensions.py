"""Read-only catalogs for installed MRE/Hermes plugins and skills."""

from __future__ import annotations

import asyncio
import json
from pathlib import Path
from typing import Any

import yaml

from mrie.core.capability_base import Capability, CapabilityResult, EthicsVerdict, ToolDefinition


class _ExtensionCatalog:
    """Resolve extension metadata without importing or executing extension code."""

    def __init__(self, roots: list[Path], marker_names: tuple[str, ...]) -> None:
        self.roots = roots
        self.marker_names = marker_names

    def scan(self) -> list[dict[str, Any]]:
        items: list[dict[str, Any]] = []
        seen: set[tuple[str, str]] = set()
        for root in self.roots:
            if not root.is_dir():
                continue
            for directory in sorted(path for path in root.iterdir() if path.is_dir()):
                marker = self._marker(directory)
                if marker is None:
                    continue
                key = (directory.name, str(marker))
                if key in seen:
                    continue
                seen.add(key)
                metadata = self._metadata(marker)
                items.append(
                    {
                        "name": str(metadata.get("name") or directory.name),
                        "description": str(metadata.get("description") or ""),
                        "path": str(directory),
                        "manifest": str(marker),
                        "source": "hermes" if "hermes-agent" in directory.parts else "project",
                        "loaded": False,
                    }
                )
        return items

    def _marker(self, directory: Path) -> Path | None:
        for relative in self.marker_names:
            candidate = directory / relative
            if candidate.is_file():
                return candidate
        return None

    @staticmethod
    def _metadata(path: Path) -> dict[str, Any]:
        if path.suffix == ".json":
            try:
                data = json.loads(path.read_text(encoding="utf-8")[:100_000])
                return data if isinstance(data, dict) else {}
            except (OSError, json.JSONDecodeError):
                return {}
        try:
            text = path.read_text(encoding="utf-8")[:100_000]
        except OSError:
            return {}
        if not text.startswith("---"):
            return {"name": path.parent.name, "description": ""}
        _, _, remainder = text.partition("---")
        frontmatter, _, _ = remainder.partition("---")
        try:
            data = yaml.safe_load(frontmatter) or {}
            return data if isinstance(data, dict) else {}
        except yaml.YAMLError:
            return {}


class PluginCapability(Capability):
    name = "plugins"
    description = "List installed plugin manifests without loading plugin code"

    def __init__(self, config: dict[str, Any], project_root: Path) -> None:
        roots = [project_root / "plugins"]
        if config.get("include_hermes_catalog", True):
            roots.append(project_root / "vendor" / "hermes-agent" / "plugins")
        self.catalog = _ExtensionCatalog(
            roots,
            (".codex-plugin/plugin.json", "plugin.json", "manifest.json"),
        )

    def get_tools(self) -> list[ToolDefinition]:
        return [
            ToolDefinition(
                name="list_plugins",
                description="List discovered plugin manifests; discovery does not activate code",
                parameters={"type": "object", "properties": {}},
            )
        ]

    def ethics_check(self, method: str, **kwargs: Any) -> EthicsVerdict:
        return EthicsVerdict.ALLOW if method == "list_plugins" else EthicsVerdict.DENY

    async def invoke(self, method: str, **kwargs: Any) -> CapabilityResult:
        if method != "list_plugins":
            return CapabilityResult(success=False, error=f"Unknown method: {method}")
        plugins = await asyncio.to_thread(self.catalog.scan)
        return CapabilityResult(success=True, data={"plugins": plugins, "count": len(plugins)})


class SkillCapability(Capability):
    name = "skills"
    description = "List installed skill metadata without executing skill instructions"

    def __init__(self, config: dict[str, Any], project_root: Path) -> None:
        roots = [project_root / "skills"]
        if config.get("include_hermes_catalog", True):
            roots.append(project_root / "vendor" / "hermes-agent" / "optional-skills")
        self.catalog = _ExtensionCatalog(roots, ("SKILL.md",))

    def get_tools(self) -> list[ToolDefinition]:
        return [
            ToolDefinition(
                name="list_skills",
                description=(
                    "List discovered skill metadata; discovery does not execute instructions"
                ),
                parameters={"type": "object", "properties": {}},
            )
        ]

    def ethics_check(self, method: str, **kwargs: Any) -> EthicsVerdict:
        return EthicsVerdict.ALLOW if method == "list_skills" else EthicsVerdict.DENY

    async def invoke(self, method: str, **kwargs: Any) -> CapabilityResult:
        if method != "list_skills":
            return CapabilityResult(success=False, error=f"Unknown method: {method}")
        skills = await asyncio.to_thread(self.catalog.scan)
        return CapabilityResult(success=True, data={"skills": skills, "count": len(skills)})
