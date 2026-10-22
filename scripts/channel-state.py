#!/usr/bin/env python3
"""flume channel-state: ONE locked, rollback-safe write of an employee's channel state.

`flume channel offline|online` plans in TypeScript and verifies against Telegram/Slack; this is
the only part that writes. It takes the registry flock, then the renderer's own per-profile
config lock (the same order the channel transaction uses), re-checks what the plan assumed,
writes the profile DELTA, renders that ONE profile through the canonical renderer
(`hermes-profile-config.py`, never an absorb), and writes the registry row last. A failure at
any step puts every file back byte for byte.

stdin  : one JSON request (see `apply`)
stdout : one JSON result. `ok: false` carries `code` and `error`; exit 1.

It never reads, resolves, or prints a credential: references are `op://` strings and are
written verbatim. Values never pass through here.
"""
from __future__ import annotations

import fcntl
import importlib.util
import json
import os
import re
import stat
import sys
import tempfile
import time
from pathlib import Path

try:
    import yaml
except ImportError:  # pragma: no cover
    print(json.dumps({"ok": False, "code": "no-yaml", "error": "PyYAML required"}))
    sys.exit(1)

OP_REF = re.compile(r"^op://[^/\s\"'`$\\]+/[^/\s\"'`$\\]+/[^\s\"'`$\\]+$")
PROFILE_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]*$")


class Refusal(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


def load_renderer(source: Path, fleet_home: Path, registry: Path):
    """Import THE renderer bound to this fleet home (it reads its env at import)."""
    if source.is_symlink() or not source.is_file():
        raise Refusal("renderer-missing", f"canonical profile renderer not found: {source}")
    os.environ["HERMES_FLEET_HOME"] = str(fleet_home)
    os.environ["HERMES_AGENTS_REGISTRY"] = str(registry)
    spec = importlib.util.spec_from_file_location("flume_channel_renderer", source)
    if spec is None or spec.loader is None:
        raise Refusal("renderer-unloadable", f"cannot load renderer: {source}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class RegistryLock:
    """The registry flock other writers take (`<registry>.lock`); acquired BEFORE the profile lock."""

    def __init__(self, registry: Path):
        self.registry = registry
        self.path = registry.with_name(registry.name + ".lock")
        self.fd: int | None = None

    def __enter__(self):
        if self.path.parent.is_symlink() or not self.path.parent.is_dir():
            raise Refusal("registry-lock", f"registry parent must be a real directory: {self.path.parent}")
        if self.path.is_symlink():
            raise Refusal("registry-lock", f"refusing registry lock symlink: {self.path}")
        flags = os.O_RDWR | os.O_CREAT | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0)
        fd = os.open(self.path, flags, 0o600)
        deadline = time.monotonic() + float(os.environ.get("HERMES_REGISTRY_LOCK_TIMEOUT_SECONDS", "30"))
        while True:
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                if time.monotonic() >= deadline:
                    os.close(fd)
                    raise Refusal("registry-lock", f"timed out waiting for registry lock: {self.path}")
                time.sleep(0.05)
        self.fd = fd
        return self

    def __exit__(self, *_exc):
        if self.fd is not None:
            try:
                fcntl.flock(self.fd, fcntl.LOCK_UN)
            finally:
                os.close(self.fd)
            self.fd = None


def read_bytes(path: Path) -> bytes | None:
    try:
        if path.is_symlink():
            raise Refusal("symlink", f"refusing symlink: {path}")
        return path.read_bytes()
    except FileNotFoundError:
        return None


def write_atomic(path: Path, content: bytes, mode: int) -> None:
    descriptor, name = tempfile.mkstemp(prefix=f".{path.name}.channel-", dir=path.parent)
    tmp = Path(name)
    try:
        os.fchmod(descriptor, mode)
        with os.fdopen(descriptor, "wb") as handle:
            handle.write(content)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(tmp, path)
    finally:
        tmp.unlink(missing_ok=True)


def file_mode(path: Path, default: int) -> int:
    try:
        return stat.S_IMODE(path.stat().st_mode)
    except FileNotFoundError:
        return default


def render_delta(delta: dict, original: bytes | None) -> bytes:
    """Keep the original's comment lines, then the mapping; same shape the channel transaction writes."""
    comments: list[str] = []
    for line in (original or b"").decode("utf-8").splitlines():
        if line.lstrip().startswith("#") and line not in comments:
            comments.append(line)
    head = ("\n".join(comments) + "\n") if comments else ""
    return (head + yaml.safe_dump(delta, sort_keys=False)).encode("utf-8")


def other_claims(agents: dict, agent_id: str, platform: str, fields: dict[str, str]):
    """Another agent whose `platform` block carries every one of `fields` (all non-empty)."""
    if not fields or any(not str(value) for value in fields.values()):
        return None
    for other_id, row in agents.items():
        if other_id == agent_id or not isinstance(row, dict):
            continue
        block = row.get(platform)
        if not isinstance(block, dict):
            continue
        if all(str(block.get(key) or "") == str(value) for key, value in fields.items()):
            return other_id
    return None


def edit_platform_block(text: str, agent_id: str, platform: str, block: dict) -> str | None:
    """Rewrite ONE `agents.<id>.<platform>` block in place and touch no other byte of the registry.

    A whole-file `yaml.safe_dump` re-indents every list and re-escapes every non-ASCII string in the
    fleet registry (73 lines of churn on the live one), and other agents write that file too. Returns
    None when the layout is not the plain block style this expects; the caller then verifies and falls
    back to a full dump.
    """
    lines = text.splitlines(keepends=True)

    def indent(line: str) -> int:
        return len(line) - len(line.lstrip(" "))

    def blank(line: str) -> bool:
        return not line.strip() or line.lstrip().startswith("#")

    start = next((i for i, line in enumerate(lines) if line.rstrip("\n") == "agents:"), None)
    if start is None:
        return None
    row = next((i for i in range(start + 1, len(lines)) if re.fullmatch(rf"  {re.escape(agent_id)}:\s*", lines[i].rstrip("\n"))), None)
    if row is None:
        return None
    row_end = len(lines)
    for i in range(row + 1, len(lines)):
        if not blank(lines[i]) and indent(lines[i]) <= 2:
            row_end = i
            break
    while row_end > row + 1 and blank(lines[row_end - 1]):
        row_end -= 1
    head = next((i for i in range(row + 1, row_end) if re.match(rf"    {re.escape(platform)}:", lines[i])), None)
    rendered = yaml.safe_dump(block, sort_keys=False, default_flow_style=False, allow_unicode=True)
    body = [f"      {line}\n" if line else "\n" for line in rendered.rstrip("\n").split("\n")]
    fresh = [f"    {platform}:\n", *body] if block else [f"    {platform}: {{}}\n"]
    if head is None:
        lines[row_end:row_end] = fresh
    else:
        end = head + 1
        while end < row_end and (blank(lines[end]) or indent(lines[end]) > 4):
            end += 1
        while end > head + 1 and blank(lines[end - 1]):
            end -= 1
        lines[head:end] = fresh
    return "".join(lines)


def apply(req: dict) -> dict:
    fleet = Path(req["fleet_home"])
    registry = Path(req["registry"])
    agent_id = req["employee"]
    platform = req["platform"]
    profile_name = req["profile_name"]
    if not PROFILE_NAME.fullmatch(profile_name or ""):
        raise Refusal("invalid-profile", f"invalid profile name: {profile_name!r}")
    for ref in (req.get("delta_refs") or {}).values():
        if not isinstance(ref, str) or not OP_REF.fullmatch(ref):
            raise Refusal("invalid-reference", "a credential reference must be op://<vault>/<item>/<field>")
    r = load_renderer(Path(req["renderer"]), fleet, registry)
    pdir = r.PROFILES / profile_name
    if pdir.is_symlink() or not pdir.is_dir():
        raise Refusal("desk", f"profile must be a real directory: {pdir}")
    delta_path = pdir / "config.delta.yaml"
    generated_path = pdir / "config.yaml"

    with RegistryLock(registry):
        with r.PROFILE_LOCK.ProfileConfigLock(pdir):
            reg_before = read_bytes(registry)
            delta_before = read_bytes(delta_path)
            gen_before = read_bytes(generated_path)
            if reg_before is None:
                raise Refusal("registry-missing", f"registry not found: {registry}")
            data = yaml.safe_load(reg_before.decode("utf-8")) or {}
            agents = data.get("agents") if isinstance(data, dict) else None
            row = agents.get(agent_id) if isinstance(agents, dict) else None
            if not isinstance(row, dict):
                raise Refusal("unknown-employee", f"{agent_id} has no registry row")
            if str(row.get("profile_name") or agent_id) != profile_name:
                raise Refusal("stale-plan", f"{agent_id} now maps to profile {row.get('profile_name')!r}, not {profile_name!r}")
            block = row.get(platform)
            if block is not None and not isinstance(block, dict):
                raise Refusal("registry-shape", f"{agent_id}.{platform} is not a mapping")
            block = dict(block or {})
            if "expect_status" in req and (block.get("provisioning_status") or None) != req["expect_status"]:
                raise Refusal("stale-plan", f"{agent_id}.{platform} status changed from "
                              f"{req['expect_status']!r} to {block.get('provisioning_status')!r} since the preview")
            for fields in req.get("unique") or []:
                owner = other_claims(agents, agent_id, platform, fields)
                if owner:
                    raise Refusal("duplicate-bot", f"{platform} bot identity is already assigned to {owner}")

            for key, value in (req.get("registry_set") or {}).items():
                block[key] = value
            for key in req.get("registry_unset") or []:
                block.pop(key, None)
            row[platform] = block
            # Touch only this row's block; keep a full dump as the verified fallback.
            edited = edit_platform_block(reg_before.decode("utf-8"), agent_id, platform, block)
            try:
                same = edited is not None and yaml.safe_load(edited) == data
            except yaml.YAMLError:
                same = False
            reg_after = edited.encode("utf-8") if same else yaml.safe_dump(data, sort_keys=False).encode("utf-8")

            try:
                delta = r.load_yaml(delta_path)
            except SystemExit as exc:
                raise Refusal("delta-unreadable", str(exc))
            if not isinstance(delta, dict):
                raise Refusal("delta-shape", "config.delta.yaml is not a mapping")
            plats = delta.setdefault("platforms", {})
            if not isinstance(plats, dict):
                raise Refusal("delta-shape", "platforms in the delta is not a mapping")
            plat = plats.setdefault(platform, {})
            if not isinstance(plat, dict):
                raise Refusal("delta-shape", f"platforms.{platform} in the delta is not a mapping")
            plat["enabled"] = bool(req["delta_enabled"])
            refs = req.get("delta_refs") or {}
            if refs:
                onepassword = delta.setdefault("secrets", {}).setdefault("onepassword", {})
                if not isinstance(onepassword, dict):
                    raise Refusal("delta-shape", "secrets.onepassword in the delta is not a mapping")
                onepassword.setdefault("enabled", True)
                env = onepassword.setdefault("env", {})
                if not isinstance(env, dict):
                    raise Refusal("delta-shape", "secrets.onepassword.env in the delta is not a mapping")
                env.update(refs)
            delta_after = render_delta(delta, delta_before)

            base = r.load_yaml(r.BASE)
            # THE expected config (merge + renderer pins) from the delta as it will be written.
            expected = r.expected_config(base, delta, pdir)
            # Each file joins `written` only AFTER it was replaced, so a failure restores exactly what changed.
            written: list[tuple[Path, bytes | None, int]] = []
            try:
                backup = r.backup([generated_path, delta_path], "channel")
                write_atomic(delta_path, delta_after, 0o600)
                written.append((delta_path, delta_before, file_mode(delta_path, 0o600)))
                r.write_generated(generated_path, expected)
                written.append((generated_path, gen_before, file_mode(generated_path, 0o600)))
                write_atomic(registry, reg_after, file_mode(registry, 0o600))
            except BaseException:
                for path, content, mode in reversed(written):
                    try:
                        if content is None:
                            path.unlink(missing_ok=True)
                        else:
                            write_atomic(path, content, mode)
                    except OSError:
                        pass  # keep restoring the rest; the error being raised is the original one
                raise
    return {
        "ok": True,
        "profile": profile_name,
        "delta": str(delta_path),
        "generated": str(generated_path),
        "registry": str(registry),
        "backup": str(backup) if backup else None,
    }


def main() -> int:
    try:
        request = json.load(sys.stdin)
        result = apply(request)
    except Refusal as exc:
        print(json.dumps({"ok": False, "code": exc.code, "error": str(exc)}))
        return 1
    except SystemExit as exc:
        print(json.dumps({"ok": False, "code": "renderer-exit", "error": str(exc)}))
        return 1
    except Exception as exc:  # the files were restored by apply(); say what failed, never a value
        print(json.dumps({"ok": False, "code": "internal", "error": f"{type(exc).__name__}: {exc}"}))
        return 1
    print(json.dumps(result))
    return 0


if __name__ == "__main__":
    sys.exit(main())
