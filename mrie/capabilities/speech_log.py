"""Speech log capability — persistent record of agent utterances."""

from __future__ import annotations

import asyncio
import json
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from mrie.core.capability_base import (
    Capability,
    CapabilityResult,
    EthicsVerdict,
    ToolDefinition,
)


class SpeechLogCapability(Capability):
    name = "speech_log"
    description = "Log and query agent speech history"

    def __init__(self, project_root: Path) -> None:
        self.log_dir = project_root / "logs" / "speech"
        self.log_dir.mkdir(parents=True, exist_ok=True)

    def get_tools(self) -> list[ToolDefinition]:
        return [
            ToolDefinition(
                name="append",
                description="Append an utterance to the speech log",
                parameters={
                    "type": "object",
                    "properties": {
                        "text": {"type": "string"},
                        "source": {"type": "string", "default": "agent"},
                    },
                    "required": ["text"],
                },
            ),
            ToolDefinition(
                name="query_since",
                description="Query speech entries since a timestamp",
                parameters={
                    "type": "object",
                    "properties": {"since": {"type": "string"}},
                    "required": ["since"],
                },
            ),
            ToolDefinition(
                name="export",
                description="Export speech log entries to a file",
                parameters={
                    "type": "object",
                    "properties": {"output_path": {"type": "string"}},
                    "required": ["output_path"],
                },
            ),
        ]

    async def invoke(self, method: str, **kwargs: Any) -> CapabilityResult:
        if method == "append":
            return await self.append(**kwargs)
        if method == "query_since":
            return await self.query_since(**kwargs)
        if method == "export":
            return await self.export(**kwargs)
        return CapabilityResult(success=False, error=f"Unknown method: {method}")

    def ethics_check(self, method: str, **kwargs: Any) -> EthicsVerdict:
        if method == "export":
            return EthicsVerdict.REQUIRE_CONFIRMATION
        return EthicsVerdict.ALLOW

    async def append(self, text: str, source: str = "agent") -> CapabilityResult:
        return await asyncio.to_thread(self._append_sync, text, source)

    def _append_sync(self, text: str, source: str) -> CapabilityResult:
        entry = {
            "timestamp": datetime.now(UTC).isoformat(),
            "text": text,
            "source": source,
        }
        log_file = self.log_dir / f"speech-{datetime.now(UTC).strftime('%Y%m%d')}.jsonl"
        with log_file.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(entry) + "\n")
        return CapabilityResult(success=True, data=entry)

    async def query_since(self, since: str) -> CapabilityResult:
        return await asyncio.to_thread(self._query_since_sync, since)

    def _query_since_sync(self, since: str) -> CapabilityResult:
        since_dt = datetime.fromisoformat(since.replace("Z", "+00:00"))
        entries: list[dict[str, Any]] = []
        for log_file in sorted(self.log_dir.glob("speech-*.jsonl")):
            with log_file.open(encoding="utf-8") as handle:
                for line in handle:
                    entry = json.loads(line)
                    entry_dt = datetime.fromisoformat(entry["timestamp"].replace("Z", "+00:00"))
                    if entry_dt >= since_dt:
                        entries.append(entry)
        return CapabilityResult(success=True, data={"entries": entries, "count": len(entries)})

    async def export(self, output_path: str) -> CapabilityResult:
        return await asyncio.to_thread(self._export_sync, output_path)

    def _export_sync(self, output_path: str) -> CapabilityResult:
        all_entries: list[dict[str, Any]] = []
        for log_file in sorted(self.log_dir.glob("speech-*.jsonl")):
            with log_file.open(encoding="utf-8") as handle:
                for line in handle:
                    all_entries.append(json.loads(line))
        out = Path(output_path)
        out.write_text(json.dumps(all_entries, indent=2), encoding="utf-8")
        return CapabilityResult(success=True, data={"exported": len(all_entries), "path": str(out)})
