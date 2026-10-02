#!/usr/bin/env python3
"""Apply a role chain under the existing renderer's profile lock; preserve desk overrides."""
import importlib.util
import json
import os
from pathlib import Path
import sys

renderer, profile = sys.argv[1:3]
spec = importlib.util.spec_from_file_location("flume_renderer", renderer)
assert spec is not None and spec.loader is not None
r = importlib.util.module_from_spec(spec)
spec.loader.exec_module(r)
request = json.load(sys.stdin)
pdir = r.PROFILES / profile
if pdir.is_symlink() or not pdir.is_dir():
    raise SystemExit("desk must be a real directory")
with r.PROFILE_LOCK.ProfileConfigLock(pdir):
    delta_path = pdir / "config.delta.yaml"
    state_path = pdir / "role-projection.json"
    for path in (delta_path, state_path, pdir / "config.yaml"):
        if path.is_symlink():
            raise SystemExit(f"refusing config/state symlink: {path.name}")
    delta = r.load_yaml(delta_path)
    previous = json.loads(state_path.read_text()) if state_path.exists() else {}
    chain = request.get("chain")
    overrides = []
    managed = {}
    desired = {"model": {"provider": "automaticai", "default": chain[0]},
               "fallback_providers": [{"provider": "automaticai", "model": route} for route in chain[1:]]} if chain else {}
    for key, value in desired.items():
        current = delta.get(key)
        if key == "model":
            old = previous.get(key, {})
            current = current or {}
            kept = dict(current)
            for leaf, wanted in value.items():
                if leaf not in current or current[leaf] == old.get(leaf):
                    kept[leaf] = wanted
                else:
                    overrides.append(f"model.{leaf}")
            delta[key] = kept
            managed[key] = {leaf: kept[leaf] for leaf in value if f"model.{leaf}" not in overrides}
        elif key not in delta or current == previous.get(key):
            delta[key] = value
            managed[key] = value
        else:
            overrides.append(key)
    # Explicitly scoped, never mistaken for a shared-process Bloodbank chain.
    if "fallback_providers" in delta:
        delta["x-flume-fallback-override"] = "desk-gateway"
    # A role loadout is delivered as a Skillex selection, never as a discovery root. Earlier
    # flume versions appended the desk's own .agents/skills to skills.external_dirs through a
    # list patch; a Skillex-only desk refuses that, so the one entry flume itself wrote (and
    # nothing a person authored) is removed.
    directive = delta.get(r.LIST_PATCH_KEY)
    patches = directive.get("list_patches") if isinstance(directive, dict) else None
    legacy = patches.get("skills.external_dirs") if isinstance(patches, dict) else None
    if legacy == {"add": [str(pdir / ".agents" / "skills")]}:
        del patches["skills.external_dirs"]
        if not patches:
            del directive["list_patches"]
        if not directive:
            del delta[r.LIST_PATCH_KEY]
    # Strict discovery (skills.external_dirs: []) mirrors the template's step 10 pin, so a desk
    # that this projection first makes Skillex-only is accepted by `skillex profile sync
    # --skillex-only` and by hermes.delta-list-override. Idempotent: an already pinned delta is
    # left byte for byte alone.
    if request.get("strict_skills"):
        skills = delta.get("skills")
        if skills is None:
            skills = {}
        if not isinstance(skills, dict):
            raise SystemExit("skills delta must be a mapping")
        delta["skills"] = {**skills, "external_dirs": []}
    merged = r.deep_merge(r.load_yaml(r.BASE), delta)
    text = r.dump_yaml(delta)
    if not delta_path.exists() or delta_path.read_text() != text:
        tmp = delta_path.with_name(".config.delta.yaml.role-tmp")
        tmp.write_text(text)
        os.chmod(tmp, 0o600)
        os.replace(tmp, delta_path)
    r.write_generated(pdir / "config.yaml", merged)
    state_path.write_text(json.dumps(managed, sort_keys=True) + "\n")
    print(json.dumps({"overrides": overrides, "chain": [merged.get("model", {}).get("default"), *[f.get("model") for f in merged.get("fallback_providers", [])]], "fallback_surface": "desk-gateway"}))
