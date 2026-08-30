"""Tailscale capability — remote device access."""

from __future__ import annotations

import asyncio
import json
import re
import shutil
from typing import Any

from mrie.core.capability_base import Capability, CapabilityResult, EthicsVerdict, ToolDefinition


class TailscaleCapability(Capability):
    name = "tailscale"
    description = "Inspect and interact with Tailscale-linked devices"

    def __init__(self, config: dict[str, Any]) -> None:
        self.config = config
        configured_devices = config.get("allowed_devices", [])
        if not isinstance(configured_devices, list):
            configured_devices = []
        self.allowed_devices = {
            str(item).strip().lower() for item in configured_devices if str(item).strip()
        }
        self.ssh_user = str(config.get("ssh_user", "")).strip()
        self.timeout_seconds = max(1, min(int(config.get("command_timeout_seconds", 30)), 300))
        self.max_command_chars = max(1, min(int(config.get("max_command_chars", 8192)), 65536))

    def get_tools(self) -> list[ToolDefinition]:
        return [
            ToolDefinition(
                name="list_devices",
                description="List devices on the Tailscale network",
                parameters={"type": "object", "properties": {}},
            ),
            ToolDefinition(
                name="ping",
                description="Ping a Tailscale device by hostname or IP",
                parameters={
                    "type": "object",
                    "properties": {"host": {"type": "string"}},
                    "required": ["host"],
                },
            ),
            ToolDefinition(
                name="ssh_exec",
                description="Execute a command on a remote device via SSH over Tailscale",
                parameters={
                    "type": "object",
                    "properties": {
                        "host": {"type": "string"},
                        "command": {"type": "string"},
                    },
                    "required": ["host", "command"],
                },
            ),
        ]

    def ethics_check(self, method: str, **kwargs: Any) -> EthicsVerdict:
        if method == "ssh_exec":
            return EthicsVerdict.REQUIRE_CONFIRMATION
        return EthicsVerdict.ALLOW

    async def invoke(self, method: str, **kwargs: Any) -> CapabilityResult:
        if method == "list_devices":
            return await self.list_devices()
        if method == "ping":
            return await self.ping(**kwargs)
        if method == "ssh_exec":
            return await self.ssh_exec(**kwargs)
        return CapabilityResult(success=False, error=f"Unknown method: {method}")

    async def list_devices(self) -> CapabilityResult:
        tailscale = shutil.which("tailscale")
        if not tailscale:
            return CapabilityResult(success=False, error="tailscale CLI not found in PATH")
        proc = await asyncio.create_subprocess_exec(
            tailscale,
            "status",
            "--json",
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, stderr = await proc.communicate()
        if proc.returncode != 0:
            return CapabilityResult(success=False, error=stderr.decode())
        try:
            data = json.loads(stdout.decode())
            return CapabilityResult(success=True, data=data)
        except json.JSONDecodeError as exc:
            return CapabilityResult(success=False, error=str(exc))

    async def ping(self, host: str) -> CapabilityResult:
        # Ping is observational. With no device allowlist it may probe a valid
        # tailnet address, while configured allowlists still constrain it.
        validation = self._validate_host(host, require_allowlisted=False)
        if validation:
            return CapabilityResult(success=False, error=validation)
        tailscale = shutil.which("tailscale")
        if not tailscale:
            return CapabilityResult(success=False, error="tailscale CLI not found")
        proc = await asyncio.create_subprocess_exec(
            tailscale,
            "ping",
            host,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        try:
            stdout, stderr = await asyncio.wait_for(
                proc.communicate(), timeout=self.timeout_seconds
            )
        except TimeoutError:
            proc.kill()
            await proc.wait()
            return CapabilityResult(success=False, error="Tailscale ping timed out")
        return CapabilityResult(
            success=proc.returncode == 0,
            data={"host": host, "output": stdout.decode()},
            error=stderr.decode() if proc.returncode != 0 else None,
        )

    async def ssh_exec(self, host: str, command: str) -> CapabilityResult:
        validation = self._validate_host(host, require_allowlisted=True)
        if validation:
            return CapabilityResult(success=False, error=validation)
        command_validation = self._validate_command(command)
        if command_validation:
            return CapabilityResult(success=False, error=command_validation)
        if self.ssh_user and (
            self.ssh_user.startswith("-")
            or not re.fullmatch(r"[a-zA-Z0-9._-]{1,64}", self.ssh_user)
        ):
            return CapabilityResult(success=False, error="Invalid tailscale.ssh_user configuration")
        ssh = shutil.which("ssh")
        if not ssh:
            return CapabilityResult(success=False, error="ssh not found in PATH")
        destination = f"{self.ssh_user}@{host}" if self.ssh_user else host
        proc = await asyncio.create_subprocess_exec(
            ssh,
            "-o",
            "BatchMode=yes",
            "-T",
            "-o",
            f"ConnectTimeout={self.timeout_seconds}",
            destination,
            command,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        try:
            stdout, stderr = await asyncio.wait_for(
                proc.communicate(), timeout=self.timeout_seconds
            )
        except TimeoutError:
            proc.kill()
            await proc.wait()
            return CapabilityResult(success=False, error="Remote command timed out")
        return CapabilityResult(
            success=proc.returncode == 0,
            data={"host": host, "stdout": stdout.decode(), "stderr": stderr.decode()},
            error=stderr.decode() if proc.returncode != 0 else None,
        )

    def _validate_host(self, host: str, *, require_allowlisted: bool) -> str | None:
        if not isinstance(host, str):
            return "Invalid Tailscale host"
        candidate = host.strip().lower()
        if not candidate or candidate.startswith("-"):
            return "Invalid Tailscale host"
        if not re.fullmatch(r"[a-z0-9][a-z0-9.:-]{0,252}", candidate):
            return "Invalid Tailscale host"
        if require_allowlisted and not self.allowed_devices:
            return (
                "Remote command execution is disabled: configure "
                "tailscale.allowed_devices explicitly"
            )
        if self.allowed_devices and candidate not in self.allowed_devices:
            return f"Tailscale host is not allowlisted: {host}"
        return None

    def _validate_command(self, command: str) -> str | None:
        if not isinstance(command, str) or not command.strip():
            return "Remote command cannot be empty"
        if "\x00" in command or len(command) > self.max_command_chars:
            return f"Remote command exceeds the safe limit of {self.max_command_chars} characters"
        return None
