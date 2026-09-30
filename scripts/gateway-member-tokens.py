#!/usr/bin/env python3
"""Give each registered fleet member its own AutomaticAI gateway token.

Policy: all agent inference goes through api.automaticai.io (skills
`automaticai-provider-gateway` and `automaticai-provider-gateway-lazy-migration-strategy`).
The fleet base (~/.hermes/config.yaml) maps AUTOMATICAI_GATEWAY_KEY to the FLEET token
(`hermes-fleet-workers`), so a desk with no override of its own inherits it. This script
adds per-member tracking: for each fleet member it mints a consumer token named
`hermes-<profile>` (shortened with a hash when the profile name is long) (scoped to the routes in --models) and overrides that one variable in
the member's config.delta.yaml with its own `op://` reference.

Only references are ever written. Token values are never read into this process's output.
Idempotent: a member that already has a token or an override is left alone. Dry run by
default; --apply mints tokens and edits deltas; --render also re-renders each edited desk.
It never restarts a gateway: a running gateway holds the old key until it is restarted.

The delta edit is a text-level insert (deltas carry comments), verified semantically: the
file is parsed before and after and nothing is written unless the ONLY difference is the
one added key.
"""
from __future__ import annotations

import argparse
import copy
import hashlib
import re
import subprocess
import sys
import time
from pathlib import Path

import yaml

HOME = Path.home()
HERMES = HOME / ".hermes"
NEWAPI = HOME / "docker" / "stacks" / "ai" / "newapi"
TOKENS_CLI = NEWAPI / "ops" / "gateway-tokens.py"
RENDERER = HOME / "code" / "33GOD" / "hermes-agent-template" / "scripts" / "hermes-profile-config.py"
ENV_NAME = "AUTOMATICAI_GATEWAY_KEY"
# One shared 1Password item ("AutomaticAI Gateway Tokens"); each consumer's token is a
# field named after the consumer. gateway-tokens.py prints the same reference on mint.
TOKENS_ITEM = "op://DeLoSecrets/yeurk5dpqkaarspvsn3cjtmkki"
DEFAULT_MODELS = ["automaticai/personal/kimi-2.8", "automaticai/personal/kimi-k3"]
REF_RE = re.compile(r"op://\S+")
COMMENT = (
    "# Per-member AutomaticAI gateway token (tracking). Overrides the fleet token the base maps\n"
    f"# to {ENV_NAME}; delete this line to fall back to the fleet key. Reference only.\n"
)


# The gateway names a token `aai:<consumer>:<19-digit id>` and refuses names over 50 characters
# (POST /api/token/ answers "gateway refused operation"), so a consumer name may not exceed
# 26 characters even though gateway-tokens.py itself allows 40.
MAX_CONSUMER = 26


def consumer_name(profile: str) -> str:
    """`hermes-<profile>`, shortened deterministically (with a hash suffix) when too long."""
    name = f"hermes-{profile}"
    if len(name) <= MAX_CONSUMER:
        return name
    digest = hashlib.sha1(profile.encode()).hexdigest()[:4]
    keep = MAX_CONSUMER - len("hermes-") - 1 - len(digest)
    return f"hermes-{profile[:keep].rstrip('-_')}-{digest}"


def members() -> list[str]:
    """Registered fleet members that have a desk under base+delta inheritance."""
    agents = (yaml.safe_load((HERMES / "agents-registry.yaml").read_text()) or {}).get("agents", {})
    out = []
    for agent_id, row in agents.items():
        if not isinstance(row, dict):
            continue
        profile = str(row.get("profile_name") or agent_id)
        if (HERMES / "profiles" / profile / "config.delta.yaml").exists():
            out.append(profile)
    return sorted(set(out))


def run(cmd: list[str], **kw) -> subprocess.CompletedProcess:
    return subprocess.run(cmd, capture_output=True, text=True, **kw)


def mint(consumer: str, models: list[str]) -> tuple[str, str]:
    """Mint (or confirm) a consumer token; returns (op:// reference, 'minted'|'existing').

    gateway-tokens.py is idempotent and logs in to the gateway on EVERY invocation, and the
    gateway rate-limits that login (HTTP 429, about 20 per 20 minutes; a 409 burst can follow a success). So this is one call per
    member, and a 429 waits for the window instead of failing the member. A contended
    tokens-vault lock is retried briefly.
    """
    deadline = time.time() + 45 * 60
    contention = 0
    while True:
        r = run(["python3", str(TOKENS_CLI), "mint", consumer, "--models", *models])
        out = (r.stdout + r.stderr).strip()
        m = REF_RE.search(r.stdout)
        if r.returncode == 0 and m:
            return m.group(0), ("existing" if "existing token" in r.stdout else "minted")
        # 429 = the login limiter is full; 409 = the login endpoint refusing a request that
        # follows a success too closely (seen as a burst of 409s right after a mint). Both are
        # transient: wait out the window rather than failing the member.
        if ("429" in out or "409" in out) and time.time() < deadline:
            print(f"  ... gateway login throttled ({'429' if '429' in out else '409'}); waiting 60s ({consumer})", flush=True)
            time.sleep(60)
            continue
        if ("lock" in out.lower() or "contend" in out.lower()) and contention < 5:
            contention += 1
            time.sleep(3 * contention)
            continue
        raise RuntimeError(f"mint {consumer} failed: {out[:200]}")


def readable(ref: str) -> bool:
    r = run(["op", "read", ref])
    return r.returncode == 0 and len(r.stdout.strip()) > 20


def add_env_line(text: str, ref: str) -> str:
    """Insert `ENV_NAME: ref` into secrets.onepassword.env of a delta (text-level)."""
    lines = text.split("\n")
    entry_comment = COMMENT
    # An empty delta is a literal `{}` (plus comments): replace it with the block.
    if [l for l in lines if l.strip() and not l.lstrip().startswith("#")] == ["{}"]:
        i = next(i for i, l in enumerate(lines) if l.strip() == "{}")
        block = entry_comment + f"secrets:\n  onepassword:\n    env:\n      {ENV_NAME}: {ref}\n"
        return "\n".join(lines[:i] + block.rstrip("\n").split("\n") + lines[i + 1:])
    top = next((i for i, l in enumerate(lines) if re.match(r"^secrets:\s*$", l)), None)
    if top is None:
        tail = text if text.endswith("\n") else text + "\n"
        return tail + "\n" + entry_comment + f"secrets:\n  onepassword:\n    env:\n      {ENV_NAME}: {ref}\n"

    def child(start: int, indent: int, key: str) -> int | None:
        for j in range(start + 1, len(lines)):
            l = lines[j]
            if not l.strip() or l.lstrip().startswith("#"):
                continue
            ind = len(l) - len(l.lstrip())
            if ind <= indent - 2 and ind < indent:
                return None
            if ind == indent and re.match(rf"^\s*{re.escape(key)}:\s*$", l):
                return j
            if ind < indent:
                return None
        return None

    op = child(top, 2, "onepassword")
    env = child(op, 4, "env") if op is not None else None
    if env is None:
        raise ValueError("secrets block has no onepassword.env mapping to extend; edit by hand")
    first = next(j for j in range(env + 1, len(lines)) if lines[j].strip() and not lines[j].lstrip().startswith("#"))
    ind = " " * (len(lines[first]) - len(lines[first].lstrip()))
    lines[first:first] = [ind + f"{ENV_NAME}: {ref}"]
    return "\n".join(lines)


def edit_delta(path: Path, ref: str, apply: bool) -> str:
    """Return 'added' | 'present' | 'skipped: why'. Verified semantically before writing."""
    text = path.read_text()
    before = yaml.safe_load(text) or {}
    existing = (((before.get("secrets") or {}).get("onepassword") or {}).get("env") or {}).get(ENV_NAME)
    if existing == ref:
        return "present"
    if existing:
        return f"skipped: delta already maps {ENV_NAME} to a different reference"
    try:
        new_text = add_env_line(text, ref)
    except ValueError as e:
        return f"skipped: {e}"
    expected = copy.deepcopy(before)
    expected.setdefault("secrets", {}).setdefault("onepassword", {}).setdefault("env", {})[ENV_NAME] = ref
    if yaml.safe_load(new_text) != expected:
        return "skipped: edit would change more than the one key (not written)"
    if apply:
        path.write_text(new_text if new_text.endswith("\n") else new_text + "\n")
    return "added"


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--apply", action="store_true", help="mint tokens and edit deltas (default: dry run)")
    ap.add_argument("--render", action="store_true", help="with --apply, re-render each edited desk")
    ap.add_argument("--members", help="comma-separated profiles (default: every registered member)")
    ap.add_argument("--models", nargs="+", default=DEFAULT_MODELS, help="routes each token may use")
    args = ap.parse_args()

    todo = [m.strip() for m in args.members.split(",")] if args.members else members()
    failures = 0
    for profile in todo:
        consumer = consumer_name(profile)
        delta = HERMES / "profiles" / profile / "config.delta.yaml"
        if not delta.exists():
            print(f"{profile:28s} SKIP no config.delta.yaml (not under inheritance)")
            continue
        try:
            ref = f"{TOKENS_ITEM}/{consumer}"
            state = "would mint if absent"
            if args.apply:
                ref, state = mint(consumer, args.models)
                state = f"token {state}"
            if args.apply and not readable(ref):
                print(f"{profile:28s} FAIL token reference does not read back: {ref}")
                failures += 1
                continue
            result = edit_delta(delta, ref, args.apply)
            print(f"{profile:28s} {state:16s} delta: {result}")
            if result.startswith("skipped"):
                failures += 1
            if args.apply and args.render and result == "added":
                r = run(["python3", str(RENDERER), "render", "--profile", profile])
                print(f"{'':28s} render: {'ok' if r.returncode == 0 else 'FAILED ' + r.stderr.strip()[:120]}")
                failures += r.returncode != 0
        except Exception as e:  # keep going: one member must not block the rest
            print(f"{profile:28s} FAIL {e}")
            failures += 1
    print(f"\n{len(todo)} member(s); {failures} problem(s); {'APPLIED' if args.apply else 'dry run (use --apply)'}")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
