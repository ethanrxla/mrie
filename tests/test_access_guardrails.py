from __future__ import annotations

from pathlib import Path

import pytest

from mrie.capabilities.filesystem import FilesystemCapability
from mrie.capabilities.tailscale import TailscaleCapability
from mrie.core.capability_base import CapabilityRegistry
from mrie.core.ethics_guard import EthicsGuard


@pytest.mark.asyncio
async def test_empty_filesystem_allowlist_denies_reads(tmp_path: Path) -> None:
    target = tmp_path / "note.txt"
    target.write_text("private", encoding="utf-8")
    capability = FilesystemCapability({}, tmp_path)

    result = await capability.read_file(str(target))

    assert result.success is False
    assert result.error is not None
    assert "reads are disabled" in result.error


@pytest.mark.asyncio
async def test_filesystem_allows_only_resolved_configured_roots(tmp_path: Path) -> None:
    allowed = tmp_path / "allowed"
    allowed.mkdir()
    inside = allowed / "inside.txt"
    inside.write_text("inside", encoding="utf-8")
    outside = tmp_path / "outside.txt"
    outside.write_text("outside", encoding="utf-8")
    capability = FilesystemCapability({"allowed_roots": ["allowed"]}, tmp_path)

    inside_result = await capability.read_file(str(inside))
    outside_result = await capability.read_file(str(outside))
    traversal_result = await capability.search_files(str(allowed), "../*")

    assert inside_result.success is True
    assert inside_result.data["content"] == "inside"
    assert outside_result.success is False
    assert outside_result.error is not None
    assert "outside configured allowed_roots" in outside_result.error
    assert traversal_result.success is False


@pytest.mark.asyncio
async def test_filesystem_rejects_symlink_escape(tmp_path: Path) -> None:
    allowed = tmp_path / "allowed"
    allowed.mkdir()
    outside = tmp_path / "outside.txt"
    outside.write_text("outside", encoding="utf-8")
    link = allowed / "link.txt"
    try:
        link.symlink_to(outside)
    except OSError:
        pytest.skip("Creating symlinks is unavailable for this Windows account")
    capability = FilesystemCapability({"allowed_roots": ["allowed"]}, tmp_path)

    result = await capability.read_file(str(link))

    assert result.success is False
    assert result.error is not None
    assert "outside configured allowed_roots" in result.error


@pytest.mark.asyncio
async def test_explicit_broad_filesystem_read_is_supported(tmp_path: Path) -> None:
    target = tmp_path / "note.txt"
    target.write_text("allowed", encoding="utf-8")
    capability = FilesystemCapability({"allow_all_read": True}, tmp_path / "project")

    result = await capability.read_file(str(target))

    assert result.success is True
    assert result.data["content"] == "allowed"


def test_ethics_guard_inherits_filesystem_scope_and_fails_closed(tmp_path: Path) -> None:
    capability = FilesystemCapability({"allow_all_read": True}, tmp_path)
    target = tmp_path / "note.txt"

    denied = EthicsGuard({"ethics": {}}, tmp_path)
    scoped = EthicsGuard(
        {"filesystem": {"allowed_roots": ["."]}, "ethics": {}}, tmp_path
    )

    assert denied.evaluate(capability, "read_file", path=str(target)).value == "deny"
    assert scoped.evaluate(capability, "read_file", path=str(target)).value == "allow"


@pytest.mark.asyncio
async def test_empty_tailscale_allowlist_denies_remote_commands(tmp_path: Path) -> None:
    capability = TailscaleCapability({"allowed_devices": []})

    result = await capability.ssh_exec("workstation", "hostname")

    assert result.success is False
    assert result.error is not None
    assert "allowed_devices" in result.error


@pytest.mark.asyncio
async def test_tailscale_ping_remains_observational_without_allowlist(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    capability = TailscaleCapability({"allowed_devices": []})
    monkeypatch.setattr("mrie.capabilities.tailscale.shutil.which", lambda _: None)

    result = await capability.ping("workstation")

    assert result.success is False
    assert result.error == "tailscale CLI not found"


@pytest.mark.asyncio
async def test_ssh_exec_is_denied_or_confirmation_gated_by_policy(tmp_path: Path) -> None:
    registry = CapabilityRegistry()
    registry.register(TailscaleCapability({"allowed_devices": ["workstation"]}))

    disabled_guard = EthicsGuard({"ethics": {"remote_write": False}}, tmp_path)
    disabled = await registry.invoke(
        "tailscale",
        "ssh_exec",
        ethics_guard=disabled_guard,
        host="workstation",
        command="hostname",
    )

    enabled_guard = EthicsGuard({"ethics": {"remote_write": True}}, tmp_path)
    gated = await registry.invoke(
        "tailscale",
        "ssh_exec",
        ethics_guard=enabled_guard,
        host="workstation",
        command="hostname",
    )

    assert disabled.success is False
    assert disabled.error == "Ethics guard denied tailscale.ssh_exec"
    assert gated.success is False
    assert gated.error == "Confirmation required for tailscale.ssh_exec"


@pytest.mark.asyncio
async def test_empty_remote_command_is_rejected_before_process_launch(tmp_path: Path) -> None:
    capability = TailscaleCapability({"allowed_devices": ["workstation"]})

    result = await capability.ssh_exec("workstation", "  ")

    assert result.success is False
    assert result.error == "Remote command cannot be empty"
