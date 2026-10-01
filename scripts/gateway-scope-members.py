#!/usr/bin/env python3
"""Add gateway routes to every fleet member's consumer token, through ONE gateway login.

A new catalog route (ops/routes.json) is unreachable by an existing consumer token until that
token's model scope lists it: the gateway answers 403/400 for a route outside the scope, so a
desk's fallback chain silently skips it. `gateway-tokens.py scope` fixes one consumer per call,
and every call logs in as `delo-relay` and never logs out. Across 27 consumers that hits the login
limiter (HTTP 429) and the 50-session cap (HTTP 409), the same trap `gateway-member-tokens.py`
documents. This script logs in once and scopes every `hermes-*` consumer under the shared
`tokens-vault` lock, using the gateway tool's own `scope_token` (so the key and expiry are
preserved and the change is read back).

Dry run by default. --apply writes. Idempotent: a consumer already carrying every route is skipped.
Never prints a key.

  python3 gateway-scope-members.py --add automaticai/personal/claude-sonnet-5.5 \
      automaticai/intelliforia/claude-sonnet-5.5            # dry run
  ... --apply
"""
from __future__ import annotations

import argparse
import importlib.util
import json
import sys
from pathlib import Path

OPS = Path.home() / "docker" / "stacks" / "ai" / "newapi" / "ops"
sys.path.insert(0, str(OPS))
import aai  # noqa: E402  (gateway ops helpers; they own every credential read)


def load(name: str, filename: str):
    spec = importlib.util.spec_from_file_location(name, OPS / filename)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


tokens = load("gateway_tokens", "gateway-tokens.py")


def consumer_of(token_name: str) -> str | None:
    """`aai:<consumer>:<id>` -> consumer."""
    parts = token_name.split(":")
    return parts[1] if len(parts) == 3 and parts[0] == "aai" else None


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--add", nargs="+", required=True, help="canonical routes to add to each consumer's scope")
    ap.add_argument("--prefix", default="hermes-", help="only consumers whose name starts with this")
    ap.add_argument("--apply", action="store_true", help="write (default: dry run)")
    args = ap.parse_args()

    allowed = {route["id"] for route in aai.catalog()}
    add = sorted({aai.canonical(m) for m in args.add})
    unknown = [m for m in add if m not in allowed]
    if unknown:
        print(f"unknown route(s), not in the gateway catalog (ops/routes.json): {', '.join(unknown)}", file=sys.stderr)
        return 2

    failures = 0
    scoped = skipped = 0
    with aai.lock("tokens-vault"):
        relay = aai.relay_gateway()  # the single management login
        rows = relay.rows("/api/token/")
        item = aai.vault_get(tokens.ITEM)
        by_consumer: dict[str, list] = {}
        for row in rows:
            name = consumer_of(row.get("name", ""))
            if name and name.startswith(args.prefix):
                by_consumer.setdefault(name, []).append(row)
        for name in sorted(by_consumer):
            current = by_consumer[name]
            try:
                metadata = json.loads(aai.field(item, name + "-metadata") or "{}")
                have = {aai.canonical(m) for m in current[0].get("model_limits", "").split(",") if m}
                models = sorted(have | set(add))
                if models == sorted(have):
                    skipped += 1
                    print(f"{name:34s} already has every route")
                    continue
                if len(current) != 1:
                    raise RuntimeError(f"{len(current)} tokens, expected exactly one")
                tokens.scope_token(relay, name, current, metadata, models, dry_run=not args.apply)
                scoped += 1
            except Exception as error:  # one consumer must not block the rest
                failures += 1
                print(f"{name:34s} FAIL {error}")
    print(f"\n{len(by_consumer)} consumer(s): {scoped} {'scoped' if args.apply else 'would be scoped'}, "
          f"{skipped} already complete, {failures} problem(s); 1 management login")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
