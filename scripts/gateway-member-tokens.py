#!/usr/bin/env python3
"""Provision deterministic employee gateway consumers through the gateway authority.

Dry-run by default. --apply --render confirms/mints the gateway-owned Hermes
preset and projects only its vault reference. Conflicts refuse before minting.
No service activation, token rotation or fleet-base changes. A running process
is not proof it adopted a newly rendered credential.
"""
from __future__ import annotations

import argparse
import contextlib
import copy
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import re
import signal
import stat
import subprocess
import sys
import tempfile

import yaml

sys.dont_write_bytecode = True
HOME = Path.home()
ROOT = Path(__file__).resolve().parents[1]
HERMES = Path(os.environ.get("HERMES_FLEET_HOME", HOME / ".hermes"))
TOKENS_CLI = Path(os.environ.get("FLUME_GATEWAY_TOKENS_BIN", HOME / "code/client-portal/gateway/ops/gateway-tokens.py"))
RENDERER = ROOT / "templates/hermes-agent/scripts/hermes-profile-config.py"
ENV_NAME = "AUTOMATICAI_GATEWAY_KEY"
TOKENS_ITEM = "op://DeLoSecrets/yeurk5dpqkaarspvsn3cjtmkki"
MAX_CONSUMER = 26


class ProvisionError(RuntimeError):
    """Only authored, secret-free diagnostic codes cross the process boundary."""


def consumer_name(profile: str) -> str:
    name = f"hermes-{profile}"
    if len(name) <= MAX_CONSUMER:
        return name
    digest = hashlib.sha1(profile.encode()).hexdigest()[:4]
    keep = MAX_CONSUMER - len("hermes-") - 1 - len(digest)
    return f"hermes-{profile[:keep].rstrip('-_')}-{digest}"


def load_module(name, source):
    spec = importlib.util.spec_from_file_location(name, source)
    if spec is None or spec.loader is None:
        raise ProvisionError("authority-unavailable")
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


class UniqueLoader(yaml.SafeLoader):
    pass


def unique_mapping(loader, node, deep=False):
    result = {}
    for key_node, value_node in node.value:
        key = loader.construct_object(key_node, deep=deep)
        if key in result:
            raise ProvisionError("duplicate-delta-key")
        result[key] = loader.construct_object(value_node, deep=deep)
    return result


UniqueLoader.add_constructor(yaml.resolver.BaseResolver.DEFAULT_MAPPING_TAG, unique_mapping)


def mapping(text):
    value = yaml.load(text, Loader=UniqueLoader)
    if value is None:
        value = {}
    if not isinstance(value, dict):
        raise ProvisionError("delta-not-mapping")
    return value


def candidate(text, ref):
    """Insert one leaf without reserializing comments or unrelated settings.

    Unsupported flow/alias structures refuse, rather than rewriting operator
    formatting or guessing. Every insert is checked against the parsed tree.
    """
    before = mapping(text)
    node = before
    path = ["secrets", "onepassword", "env", ENV_NAME]
    for key in path[:-1]:
        if key not in node:
            break
        if not isinstance(node[key], dict):
            raise ProvisionError("delta-parent-not-mapping")
        node = node[key]
    else:
        if ENV_NAME in node:
            if node[ENV_NAME] != ref:
                raise ProvisionError("conflicting-reference")
            return text, "present"
    expected = copy.deepcopy(before)
    cursor = expected
    for key in path[:-1]:
        cursor = cursor.setdefault(key, {})
    cursor[ENV_NAME] = ref
    # Walk the syntax tree to the deepest existing parent.
    syntax = yaml.compose(text)
    depth = 0
    parent_indent = 0
    previous_indent = 0
    while isinstance(syntax, yaml.MappingNode) and depth < len(path):
        entry = next(((k, v) for k, v in syntax.value if k.value == path[depth]), None)
        if entry is None:
            break
        previous_indent, parent_indent = parent_indent, entry[0].start_mark.column
        syntax = entry[1]
        depth += 1
    # Use the existing parent's indentation, not an assumed two spaces.
    if depth and isinstance(syntax, yaml.MappingNode) and syntax.value:
        child_indent = syntax.value[0][0].start_mark.column
        step = child_indent - parent_indent
        if step <= 0:
            raise ProvisionError("unsupported-delta-layout")
    else:
        step = parent_indent - previous_indent if depth > 1 else 2
        child_indent = parent_indent + step if depth else 0
    block = ""
    for i, key in enumerate(path[depth:]):
        block += " " * (child_indent + i * step) + key + (f": {ref}\n" if depth + i == 3 else ":\n")
    if depth == 0:
        lines = text.splitlines(keepends=True)
        ordinary = [i for i, line in enumerate(lines) if line.strip() and not line.lstrip().startswith("#")]
        if ordinary and not before:
            # Only the root empty mapping is replaced; comments stay verbatim.
            if len(ordinary) != 1 or lines[ordinary[0]].strip() != "{}":
                raise ProvisionError("unsupported-delta-layout")
            lines[ordinary[0]] = block
            result = "".join(lines)
        else:
            result = text + ("\n" if text and not text.endswith("\n") else "") + block
    elif isinstance(syntax, yaml.MappingNode) and not syntax.flow_style:
        lines = text.splitlines(keepends=True)
        # A populated parent: place the new child after its first existing
        # child, not before the mapping declaration or its comments.
        if not syntax.value:
            raise ProvisionError("unsupported-delta-layout")
        at = syntax.value[0][0].start_mark.line
        lines[at:at] = block.splitlines(keepends=True)
        result = "".join(lines)
    elif isinstance(syntax, yaml.MappingNode) and not syntax.value:
        # `env: {}` (possibly with an inline comment).
        start, end = syntax.start_mark.index, syntax.end_mark.index
        result = text[:start] + "\n" + block.rstrip("\n") + text[end:]
    else:
        raise ProvisionError("unsupported-delta-layout")
    if mapping(result) != expected:
        raise ProvisionError("delta-semantic-check-failed")
    return result if result.endswith("\n") else result + "\n", "added"


def atomic_text(path, text):
    fd, name = tempfile.mkstemp(prefix=".member-reference-", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            stream.write(text)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(name, path)
    finally:
        Path(name).unlink(missing_ok=True)


def real_file(path):
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
        raise ProvisionError("unsafe-config-file")


def provision(profile, renderer, batch, *, apply, render, group, gateway_bin):
    ref = TOKENS_ITEM + "/" + consumer_name(profile)
    result = {"profile": profile, "consumer": consumer_name(profile), "reference": ref,
              "token": "not-attempted", "delta": "not-attempted", "render": "not-attempted", "ok": False}
    stage = "preflight"
    try:
        if not re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9_.-]{0,100}", profile) or profile in {"default", ".", ".."}:
            raise ProvisionError("invalid-profile")
        pdir = HERMES / "profiles" / profile
        if pdir.is_symlink() or not pdir.is_dir():
            raise ProvisionError("unsafe-profile")
        # The same lock as channel/voice/seed/render; no pre-lock snapshots.
        with renderer.PROFILE_LOCK.ProfileConfigLock(pdir):
            if pdir.is_symlink() or not pdir.is_dir():
                raise ProvisionError("unsafe-profile")
            delta, generated = pdir / "config.delta.yaml", pdir / "config.yaml"
            real_file(delta)
            real_file(generated)
            text, delta_state = candidate(delta.read_text(), ref)
            renderer.PROFILE_LOCK.test_snapshot_barrier("member-token")
            result["delta"] = "planned-" + delta_state
            if not apply:
                result.update(token="planned", render="planned" if render else "not-requested", ok=True)
                return result
            stage = "token"
            with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
                code, output = batch(result["consumer"], group, gateway_bin)
                if code:
                    raise ProvisionError("gateway-mint-or-confirm-failed")
                if ref not in output:
                    raise ProvisionError("gateway-reference-mismatch")
                read = subprocess.run(["op", "read", ref], capture_output=True, text=True, timeout=20,
                                      env={**os.environ, "OP_CACHE": "off"})
                if read.returncode or len(read.stdout.strip()) < 20:
                    raise ProvisionError("vault-readback-failed")
                del read
            result["token"] = "confirmed" if "existing token" in output else "minted"
            stage = "delta"
            if delta_state == "added":
                atomic_text(delta, text)
            result["delta"] = delta_state
            stage = "render"
            if render:
                # Import the maintained renderer: do not recursively acquire its
                # non-reentrant lock via `render --profile` in a subprocess.
                with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
                    expected = renderer.expected_config(renderer.load_yaml(renderer.BASE), mapping(text), profile)
                    rendered = renderer.GENERATED_HEADER + renderer.dump_yaml(expected)
                    if generated.read_text() != rendered:
                        renderer.write_generated(generated, expected)
                        result["render"] = "rendered"
                    else:
                        result["render"] = "unchanged"
                    actual = mapping(generated.read_text())
                    if not isinstance(actual, dict) or actual != expected or (((actual.get("secrets") or {}).get("onepassword") or {}).get("env") or {}).get(ENV_NAME) != ref:
                        raise ProvisionError("render-readback-failed")
            else:
                result["render"] = "not-requested"
            result["ok"] = True
    except (Exception, SystemExit) as error:
        result[stage if stage in {"token", "delta", "render"} else "delta"] = "failed"
        result["error"] = str(error) if isinstance(error, ProvisionError) else (
            "profile-lock-failed" if isinstance(error, renderer.PROFILE_LOCK.ProfileConfigLockError) else stage + "-failed")
    return result


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--apply", action="store_true")
    ap.add_argument("--render", action="store_true")
    ap.add_argument("--members", required=True, help="comma-separated resolved profiles; no implicit broad backfill")
    ap.add_argument("--group", default="aai-personal", help="gateway owner group (explicit; default aai-personal)")
    ap.add_argument("--gateway-bin", default=str(TOKENS_CLI), help=argparse.SUPPRESS)
    ap.add_argument("--json", action="store_true")
    ap.add_argument("--deadline", type=int, default=180, choices=range(1, 601))
    args = ap.parse_args()
    # Disable the host op wrapper's disk cache for ALL authority/readback calls.
    os.environ["OP_CACHE"] = "off"
    def deadline(*_):
        raise ProvisionError("provisioning-deadline")
    signal.signal(signal.SIGALRM, deadline)
    signal.alarm(args.deadline)
    results = []
    try:
        renderer = load_module("flume_member_renderer", RENDERER)
        def mint(consumer, group, gateway_bin):
            command = ["python3", str(gateway_bin), "mint", consumer, "--preset", "owner-no-anthropic",
                       "--group", group, "--days", "-1"]
            response = subprocess.run(command, capture_output=True, text=True, timeout=args.deadline,
                                      env={**os.environ, "OP_CACHE": "off"})
            return response.returncode, response.stdout
        for profile in dict.fromkeys(args.members.split(",")):
            results.append(provision(profile, renderer, mint, apply=args.apply, render=args.render,
                                     group=args.group, gateway_bin=Path(args.gateway_bin)))
        envelope = {"ok": all(r["ok"] for r in results), "members": results, "apply": args.apply}
    except (Exception, SystemExit):
        envelope = {"ok": False, "members": results, "error": "provisioning-authority-or-deadline-failed"}
    finally:
        signal.alarm(0)
    if args.json:
        print(json.dumps(envelope))
    else:
        for row in results:
            print(f"{row['profile']}: token={row['token']} delta={row['delta']} render={row['render']}" + (f" unresolved={row['error']}" if "error" in row else ""))
        if "error" in envelope:
            print(envelope["error"])
    return 0 if envelope["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
