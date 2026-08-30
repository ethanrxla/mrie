"""Ethics guard — pre-action policy enforcement."""

from __future__ import annotations

import json
import re
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from mrie.core.capability_base import Capability, EthicsVerdict

SECRET_PATTERNS = [
    re.compile(r"api[_-]?key", re.I),
    re.compile(r"password", re.I),
    re.compile(r"secret", re.I),
    re.compile(r"token", re.I),
]

DESTRUCTIVE_METHODS = {"delete", "remove", "write_file", "ssh_exec", "rm", "unlink"}


class EthicsGuard:
    """Intercepts capability invocations against configurable policy."""

    def __init__(self, config: dict[str, Any], project_root: Path) -> None:
        self.config = config.get("ethics", {})
        self.project_root = project_root
        self.audit_dir = project_root / "logs" / "ethics"
        self.audit_dir.mkdir(parents=True, exist_ok=True)
        filesystem_config = config.get("filesystem", {})
        raw_roots = self.config.get(
            "allowed_roots", filesystem_config.get("allowed_roots", [])
        )
        self.allowed_roots = self._resolve_configured_roots(raw_roots)
        self.allow_all_filesystem_read = (
            self.config.get(
                "allow_all_filesystem_read", filesystem_config.get("allow_all_read", False)
            )
            is True
        )
        self.remote_write = bool(self.config.get("remote_write", False))
        self.require_confirmation_destructive = bool(
            self.config.get("require_confirmation_destructive", True)
        )

    def evaluate(self, capability: Capability, method: str, **kwargs: Any) -> EthicsVerdict:
        # Policy hard-denies are evaluated before capability-level confirmation
        # requests so a confirmation cannot bypass a disabled scope.
        if capability.name == "filesystem":
            path = kwargs.get("path") or kwargs.get("root")
            if path and not self._path_allowed(str(path)):
                verdict = EthicsVerdict.DENY
                self._audit(capability.name, method, verdict, kwargs, "path_not_allowed")
                return verdict

        if capability.name == "tailscale" and method in {"ssh_exec", "write_file"}:
            if not self.remote_write:
                verdict = EthicsVerdict.DENY
                self._audit(capability.name, method, verdict, kwargs, "remote_write_disabled")
                return verdict

        if self._contains_secret_exfiltration(kwargs):
            verdict = EthicsVerdict.DENY
            self._audit(capability.name, method, verdict, kwargs, "secret_exfiltration")
            return verdict

        cap_verdict = capability.ethics_check(method, **kwargs)
        if cap_verdict != EthicsVerdict.ALLOW:
            self._audit(capability.name, method, cap_verdict, kwargs, "capability_override")
            return cap_verdict

        if self._is_destructive(method):
            if self.require_confirmation_destructive:
                verdict = EthicsVerdict.REQUIRE_CONFIRMATION
            else:
                verdict = EthicsVerdict.ALLOW
            self._audit(capability.name, method, verdict, kwargs, "destructive_op")
            return verdict

        self._audit(capability.name, method, EthicsVerdict.ALLOW, kwargs, "allowed")
        return EthicsVerdict.ALLOW

    def _is_destructive(self, method: str) -> bool:
        method_lower = method.lower()
        return any(token in method_lower for token in DESTRUCTIVE_METHODS)

    def _path_allowed(self, path_str: str) -> bool:
        if self.allow_all_filesystem_read:
            return True
        if not self.allowed_roots:
            return False
        try:
            candidate = Path(path_str).expanduser()
            if not candidate.is_absolute():
                candidate = self.project_root / candidate
            resolved = candidate.resolve()
        except (OSError, RuntimeError, ValueError):
            return False
        return any(resolved == root or root in resolved.parents for root in self.allowed_roots)

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

    def _contains_secret_exfiltration(self, kwargs: Any) -> bool:
        payload = json.dumps(kwargs, default=str)
        return (
            any(pattern.search(payload) for pattern in SECRET_PATTERNS)
            and "read" not in payload.lower()
        )

    def _audit(
        self,
        capability: str,
        method: str,
        verdict: EthicsVerdict,
        kwargs: dict[str, Any],
        reason: str,
    ) -> None:
        entry = {
            "timestamp": datetime.now(UTC).isoformat(),
            "capability": capability,
            "method": method,
            "verdict": verdict.value,
            "reason": reason,
            "kwargs_keys": list(kwargs.keys()),
        }
        log_file = self.audit_dir / f"audit-{datetime.now(UTC).strftime('%Y%m%d')}.jsonl"
        with log_file.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(entry) + "\n")
