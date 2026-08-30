"""Filesystem capability — local file and directory access."""

from __future__ import annotations

import asyncio
from pathlib import Path
from typing import Any

from mrie.core.capability_base import Capability, CapabilityResult, EthicsVerdict, ToolDefinition


class FilesystemCapability(Capability):
    name = "filesystem"
    description = "Read and inspect local filesystem paths"

    def __init__(self, config: dict[str, Any], project_root: Path | None = None) -> None:
        self.config = config
        self.project_root = (project_root or Path.cwd()).resolve()
        self.allow_all_read = config.get("allow_all_read", False) is True
        configured_roots = config.get("allowed_roots", [])
        self.allowed_roots = self._resolve_configured_roots(configured_roots)
        self.max_read_bytes = int(config.get("max_read_bytes", 1_048_576))
        self.max_entries = int(config.get("max_entries", 1000))

    def get_tools(self) -> list[ToolDefinition]:
        return [
            ToolDefinition(
                name="list_dir",
                description="List directory contents",
                parameters={
                    "type": "object",
                    "properties": {"path": {"type": "string"}},
                    "required": ["path"],
                },
            ),
            ToolDefinition(
                name="read_file",
                description="Read file contents (text)",
                parameters={
                    "type": "object",
                    "properties": {
                        "path": {"type": "string"},
                        "max_bytes": {"type": "integer", "default": 65536},
                    },
                    "required": ["path"],
                },
            ),
            ToolDefinition(
                name="search_files",
                description="Search for files by glob pattern",
                parameters={
                    "type": "object",
                    "properties": {
                        "root": {"type": "string"},
                        "pattern": {"type": "string"},
                    },
                    "required": ["root", "pattern"],
                },
            ),
            ToolDefinition(
                name="stat",
                description="Get file/directory metadata",
                parameters={
                    "type": "object",
                    "properties": {"path": {"type": "string"}},
                    "required": ["path"],
                },
            ),
        ]

    def ethics_check(self, method: str, **kwargs: Any) -> EthicsVerdict:
        if method in {"write_file", "delete"}:
            return EthicsVerdict.REQUIRE_CONFIRMATION
        return EthicsVerdict.ALLOW

    async def invoke(self, method: str, **kwargs: Any) -> CapabilityResult:
        dispatch = {
            "list_dir": self.list_dir,
            "read_file": self.read_file,
            "search_files": self.search_files,
            "stat": self.stat,
        }
        handler = dispatch.get(method)
        if handler is None:
            return CapabilityResult(success=False, error=f"Unknown method: {method}")
        return await handler(**kwargs)

    async def list_dir(self, path: str) -> CapabilityResult:
        target, error = self._authorize_path(path)
        if error:
            return CapabilityResult(success=False, error=error)
        try:
            return await asyncio.to_thread(self._list_dir_sync, target)
        except OSError as exc:
            return CapabilityResult(success=False, error=str(exc))

    async def read_file(self, path: str, max_bytes: int = 65536) -> CapabilityResult:
        target, error = self._authorize_path(path)
        if error:
            return CapabilityResult(success=False, error=error)
        try:
            bounded = max(1, min(int(max_bytes), self.max_read_bytes))
            return await asyncio.to_thread(self._read_file_sync, target, bounded)
        except (OSError, ValueError) as exc:
            return CapabilityResult(success=False, error=str(exc))

    async def search_files(self, root: str, pattern: str) -> CapabilityResult:
        target, error = self._authorize_path(root)
        if error:
            return CapabilityResult(success=False, error=error)
        pattern_path = Path(pattern)
        if pattern_path.is_absolute() or ".." in pattern_path.parts:
            return CapabilityResult(
                success=False,
                error="Filesystem search pattern must be relative and cannot contain '..'",
            )
        try:
            return await asyncio.to_thread(self._search_files_sync, target, pattern)
        except (OSError, ValueError) as exc:
            return CapabilityResult(success=False, error=str(exc))

    async def stat(self, path: str) -> CapabilityResult:
        target, error = self._authorize_path(path)
        if error:
            return CapabilityResult(success=False, error=error)
        try:
            return await asyncio.to_thread(self._stat_sync, target)
        except OSError as exc:
            return CapabilityResult(success=False, error=str(exc))

    def _list_dir_sync(self, target: Path) -> CapabilityResult:
        entries = [
            {
                "name": entry.name,
                "is_dir": entry.is_dir() if not entry.is_symlink() else False,
                "is_symlink": entry.is_symlink(),
            }
            for entry in sorted(target.iterdir())[: self.max_entries]
        ]
        return CapabilityResult(success=True, data={"path": str(target), "entries": entries})

    @staticmethod
    def _read_file_sync(target: Path, max_bytes: int) -> CapabilityResult:
        with target.open("rb") as handle:
            content = handle.read(max_bytes).decode("utf-8", errors="replace")
        return CapabilityResult(success=True, data={"path": str(target), "content": content})

    def _search_files_sync(self, target: Path, pattern: str) -> CapabilityResult:
        matches: list[str] = []
        for path in target.glob(pattern):
            resolved, error = self._authorize_path(str(path))
            if not error and resolved is not None:
                matches.append(str(resolved))
            if len(matches) >= self.max_entries:
                break
        return CapabilityResult(success=True, data={"matches": matches})

    @staticmethod
    def _stat_sync(target: Path) -> CapabilityResult:
        metadata = target.stat()
        return CapabilityResult(
            success=True,
            data={
                "path": str(target),
                "size": metadata.st_size,
                "is_dir": target.is_dir(),
                "modified": metadata.st_mtime,
            },
        )

    def _resolve_configured_roots(self, raw_roots: Any) -> list[Path]:
        if not isinstance(raw_roots, list):
            return []
        roots: list[Path] = []
        for raw_root in raw_roots:
            if not isinstance(raw_root, str) or not raw_root.strip():
                continue
            candidate = Path(raw_root).expanduser()
            if not candidate.is_absolute():
                candidate = self.project_root / candidate
            try:
                roots.append(candidate.resolve())
            except (OSError, RuntimeError, ValueError):
                continue
        return roots

    def _authorize_path(self, path: str) -> tuple[Path | None, str | None]:
        if not isinstance(path, str) or not path.strip():
            return None, "Invalid filesystem path"
        if not self.allow_all_read and not self.allowed_roots:
            return (
                None,
                "Filesystem reads are disabled: configure filesystem.allowed_roots "
                "or explicitly set filesystem.allow_all_read=true",
            )
        try:
            candidate = Path(path).expanduser()
            if not candidate.is_absolute():
                candidate = self.project_root / candidate
            resolved = candidate.resolve()
        except (OSError, RuntimeError, ValueError):
            return None, "Filesystem path could not be resolved"
        if self.allow_all_read or any(
            resolved == root or root in resolved.parents for root in self.allowed_roots
        ):
            return resolved, None
        return None, f"Filesystem path is outside configured allowed_roots: {resolved}"
