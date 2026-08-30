"""MRE operator CLI and daemon launcher."""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import shutil
import sys
from collections.abc import Sequence
from pathlib import Path
from typing import Any

from dotenv import load_dotenv

from mrie.core.ipc_server import IPCServer
from mrie.core.orchestrator import MRIEOrchestrator


class MRIECLI:
    """Parse operator commands and coordinate the application lifecycle."""

    def __init__(self) -> None:
        self.parser = self._build_parser()

    def _build_parser(self) -> argparse.ArgumentParser:
        parser = argparse.ArgumentParser(
            prog="mrie",
            description="MRE personal intelligence and sentinel agent",
        )
        subparsers = parser.add_subparsers(dest="command", required=True)

        subparsers.add_parser("status", help="Show runtime configuration and health")
        subparsers.add_parser("capabilities", help="List registered capability methods")
        subparsers.add_parser("doctor", help="Check local prerequisites without revealing secrets")

        ask = subparsers.add_parser("ask", help="Ask MRE one question")
        ask.add_argument("message", nargs="+", help="Question or instruction")
        ask.add_argument(
            "--provider",
            choices=["primary", "nvidia_nim", "codex_subscription", "claude_subscription"],
            default="primary",
        )
        ask.add_argument("--session", default="cli")

        chat = subparsers.add_parser("chat", help="Open a simple conversational terminal")
        chat.add_argument(
            "--provider",
            choices=["primary", "nvidia_nim", "codex_subscription", "claude_subscription"],
            default="primary",
        )
        chat.add_argument("--session", default="interactive")

        briefing = subparsers.add_parser("briefing", help="Run an intelligence loop now")
        briefing.add_argument("--dry-run", action="store_true")

        subparsers.add_parser("serve", help="Run the scheduler and local TUI IPC server")
        return parser

    def run(self, argv: Sequence[str] | None = None) -> int:
        args = self.parser.parse_args(argv)
        project_root = Path(__file__).resolve().parents[2]
        load_dotenv(project_root / ".env")
        if args.command == "doctor":
            self._print(self._doctor(project_root))
            return 0
        try:
            return asyncio.run(self._run_async(args, project_root))
        except KeyboardInterrupt:
            return 130
        except Exception as exc:  # noqa: BLE001 - CLI boundary
            print(f"MRE error: {exc}", file=sys.stderr)
            return 1

    async def _run_async(self, args: argparse.Namespace, project_root: Path) -> int:
        orchestrator = MRIEOrchestrator(project_root)
        if args.command == "status":
            self._print(orchestrator.get_status())
        elif args.command == "capabilities":
            self._print(
                {
                    capability.name: capability.list_methods()
                    for capability in orchestrator.registry.all_capabilities()
                }
            )
        elif args.command == "ask":
            response = await orchestrator.ask(
                " ".join(args.message),
                provider=args.provider,
                session_id=args.session,
            )
            print(response)
        elif args.command == "chat":
            await self._chat(orchestrator, args.provider, args.session)
        elif args.command == "briefing":
            self._print(await orchestrator.run_briefing(dry_run=args.dry_run))
        elif args.command == "serve":
            ipc_config = orchestrator.config.get("ipc", {})
            server = IPCServer(
                orchestrator,
                host=str(ipc_config.get("host", "127.0.0.1")),
                port=int(ipc_config.get("port", 17351)),
            )
            orchestrator.start_scheduler()
            try:
                await server.serve_forever()
            finally:
                await orchestrator.stop_scheduler()
                await server.stop()
        return 0

    async def _chat(
        self,
        orchestrator: MRIEOrchestrator,
        provider: str,
        session_id: str,
    ) -> None:
        print("MRE ready. Type /quit to exit.")
        while True:
            message = await asyncio.to_thread(input, "you> ")
            if message.strip().lower() in {"/quit", "/exit"}:
                return
            if not message.strip():
                continue
            response = await orchestrator.ask(
                message,
                provider=provider,
                session_id=session_id,
            )
            print(f"MRE> {response}")

    def _doctor(self, project_root: Path) -> dict[str, Any]:
        config_present = any(
            (project_root / "config" / name).exists() for name in ("mrie.yaml", "mrie.example.yaml")
        )
        return {
            "python": sys.version.split()[0],
            "config_present": config_present,
            "commands": {
                name: bool(shutil.which(name)) for name in ("cargo", "codex", "claude", "tailscale")
            },
            "credentials_configured": {
                name: bool(os.environ.get(name))
                for name in (
                    "NVIDIA_NIM_API_KEY",
                    "ELEVENLABS_API_KEY",
                    "NEWSAPI_KEY",
                    "BRAVE_SEARCH_API_KEY",
                    "YOUTUBE_API_KEY",
                    "YOUTUBE_OAUTH_TOKEN",
                    "INSTAGRAM_ACCESS_TOKEN",
                    "WAZUH_API_USERNAME",
                    "WAZUH_INDEXER_USERNAME",
                )
            },
        }

    @staticmethod
    def _print(value: Any) -> None:
        print(json.dumps(value, indent=2, default=str))


def main(argv: Sequence[str] | None = None) -> int:
    return MRIECLI().run(argv)


if __name__ == "__main__":
    raise SystemExit(main())
