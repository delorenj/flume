#!/usr/bin/env python3
"""A stand-in for the `candybar` CLI: just enough of ls/register/resume/pause/history for flume launch.

State lives in $FAKE_CANDYBAR_STATE (JSON: {name: {"enabled": bool}}). Manifests are read from
<cwd>/.candybars/*.candybar.toml; a manifest is "unregistered" until `register --name N`, and a
registration creates the candybar paused, as a real one is created from `enabled = false`.
"""
import json, os, re, sys, pathlib

state_path = pathlib.Path(os.environ["FAKE_CANDYBAR_STATE"])
state = json.loads(state_path.read_text()) if state_path.exists() else {}
log = pathlib.Path(os.environ.get("FAKE_CANDYBAR_LOG", os.devnull))
with log.open("a") as handle:
    handle.write(json.dumps(sys.argv[1:]) + "\n")
args = sys.argv[1:]
cmd = args[0] if args else ""
if os.environ.get("FAKE_CANDYBAR_BROKEN"):
    print("boom", file=sys.stderr); sys.exit(3)

def save():
    state_path.write_text(json.dumps(state))

def manifests():
    out = {}
    for path in sorted(pathlib.Path(".candybars").glob("*.candybar.toml")):
        text = path.read_text()
        name = re.search(r'^name = "([^"]+)"', text, re.M).group(1)
        schedule = re.search(r'^schedule = "([^"]+)"', text, re.M).group(1)
        out[name] = (str(path), schedule)
    return out

if cmd == "ls":
    entries = []
    for name, (source, schedule) in manifests().items():
        row = state.get(name)
        entries.append({"name": name, "state": "unregistered" if row is None else ("enabled" if row["enabled"] else "paused"),
                        "sync": "new" if row is None else "ok", "drift": [], "source": source, "table": "[candybar]",
                        "schedule": schedule, "registered": row})
    print(json.dumps(entries))
elif cmd == "register":
    name = args[args.index("--name") + 1]
    if name not in manifests():
        print("no such manifest", file=sys.stderr); sys.exit(1)
    state.setdefault(name, {"enabled": False}); save(); print(f"create {name}")
elif cmd in ("resume", "pause"):
    name = args[1]
    if name not in state:
        print("not registered", file=sys.stderr); sys.exit(1)
    state[name]["enabled"] = cmd == "resume"; save()
elif cmd == "history":
    print("[]")
else:
    print("unsupported", file=sys.stderr); sys.exit(2)
