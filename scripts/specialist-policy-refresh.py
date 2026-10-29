#!/usr/bin/env python3
"""Policy-only projection using the owning template adapter's safety, lock and receipt APIs.

No config rendering, desk provisioning, identity edits, skill sync or service control.
A caught publication failure restores the original bytes; an abrupt termination
between SOUL and receipt publication requires owner inspection before retry.
"""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import re
import sys

ROOT = Path(__file__).absolute().parent.parent
spec = importlib.util.spec_from_file_location(
    "flume_specialist_adapter", ROOT / "templates/hermes-agent/scripts/hermes-specialist-profile.py")
assert spec is not None and spec.loader is not None
a = importlib.util.module_from_spec(spec)
spec.loader.exec_module(a)
START = "<!-- flume:scheduling-policy:start -->"
END = "<!-- flume:scheduling-policy:end -->"


def section(text):
    if text.count(START) != 1 or text.count(END) != 1 or text.index(END) < text.index(START):
        raise ValueError("ambiguous scheduling policy markers")
    return text[text.index(START):text.index(END) + len(END)]


def refresh(payload, check):
    request, purpose = payload["request"], payload["purpose"]
    employee = request["id"]
    if not re.fullmatch(r"[a-z0-9][a-z0-9_-]{0,57}", employee) or employee == "default":
        raise ValueError("unsafe employee")
    policy = section(request["charter"]["purpose"])
    if request["charter"]["purpose"] != purpose + "\n\n" + policy:
        raise ValueError("policy must come from the Flume projection input")
    profile = a.r.PROFILES / employee
    a.safe(profile, True)
    if not profile.is_dir():
        raise ValueError("missing specialist profile; no provisioning")
    with a.r.PROFILE_LOCK.ProfileConfigLock(profile):
        a.safe(profile, True)
        if (profile / a.PENDING).exists():
            raise ValueError("pending full specialist projection; recover through owner first")
        soul_path, receipt_path = profile / "SOUL.md", profile / "specialist-projection.json"
        a.safe(soul_path)
        a.safe(receipt_path)
        a.safe(Path(request["definition"]))
        if not Path(request["definition"]).is_file():
            raise ValueError("missing owning definition; restore it through Flume before refresh")
        for path in (soul_path, receipt_path, Path(request["definition"])):
            if path.stat().st_nlink != 1:
                raise ValueError(f"ambiguous hard-linked specialist ownership: {path}")
        before = soul_path.read_bytes().decode("utf-8")
        receipt_bytes = receipt_path.read_bytes().decode("utf-8")
        receipt = json.loads(receipt_bytes)
        if receipt.get("id") != employee or receipt.get("definition") != request["definition"]:
            raise ValueError("specialist receipt ownership conflict")
        if receipt.get("files", {}).get("SOUL.md") != a.digest(before):
            raise ValueError("handwritten specialist SOUL conflicts with adapter receipt")
        if START in before or END in before:
            old_policy = section(before)
            after = before.replace(old_policy, policy, 1)
        else:
            prefix = f"# {request['display_name']}\n\n{purpose}\n\n"
            if not before.startswith(prefix):
                raise ValueError("owning definition/purpose no longer matches profile projection")
            after = prefix + policy + "\n\n" + before[len(prefix):]
        old_hash, new_hash = a.digest(before), a.digest(after)
        pattern = r'("SOUL\.md"\s*:\s*")' + old_hash + r'(")'
        receipt_after, count = re.subn(pattern, lambda m: m[1] + new_hash + m[2], receipt_bytes)
        if count != 1:
            raise ValueError("ambiguous specialist receipt SOUL ownership")
        changed = [str(soul_path), str(receipt_path)] if after != before else []
        if changed and not check:
            # Same lock as onboarding. Preserve modes as well as all unrelated receipt bytes.
            soul_mode, receipt_mode = soul_path.stat().st_mode & 0o777, receipt_path.stat().st_mode & 0o777
            try:
                a.atomic(soul_path, after)
                os.chmod(soul_path, soul_mode)
                a.atomic(receipt_path, receipt_after)
                os.chmod(receipt_path, receipt_mode)
            except BaseException:
                a.atomic(soul_path, before)
                os.chmod(soul_path, soul_mode)
                a.atomic(receipt_path, receipt_bytes)
                os.chmod(receipt_path, receipt_mode)
                raise
        if not check and (soul_path.read_bytes().decode("utf-8") != after or receipt_path.read_bytes().decode("utf-8") != receipt_after):
            raise ValueError("specialist policy readback differs")
        return {"changed": changed, "owner_source": request["definition"],
                "profile_soul": str(soul_path), "adapter_receipt": str(receipt_path),
                "files": [{"path": str(path), "before_sha256": a.digest(old),
                           "after_sha256": a.digest(new),
                           "readback_sha256": a.digest(path.read_bytes().decode("utf-8")),
                           "nonpolicy_bytes_preserved": True}
                          for path, old, new in [(soul_path, before, after), (receipt_path, receipt_bytes, receipt_after)]]}


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    try:
        print(json.dumps(refresh(json.load(sys.stdin), args.check)))
    except (ValueError, OSError, KeyError, a.r.PROFILE_LOCK.ProfileConfigLockError) as exc:
        sys.exit(f"specialist policy refresh refused: {exc}")
