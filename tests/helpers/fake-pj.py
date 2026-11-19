#!/usr/bin/env python3
"""A stand-in for the `pj` CLI: just enough of `pj crank status|enable` for flume launch.

Reads and writes <cwd>/.project.json's crank block, as pj does; an absent block resolves to OFF at the
built-in 5m. Every call is appended to $FAKE_PJ_LOG. FAKE_PJ_BROKEN=1 fails every call.
"""
import json, os, pathlib, sys

args = sys.argv[1:]
with pathlib.Path(os.environ.get("FAKE_PJ_LOG", os.devnull)).open("a") as handle:
    handle.write(json.dumps(args) + "\n")
if os.environ.get("FAKE_PJ_BROKEN"):
    print("pj: boom", file=sys.stderr); sys.exit(3)

project = pathlib.Path(".project.json")
doc = json.loads(project.read_text()) if project.exists() else {}
crank = doc.get("crank") or {}

if args[:2] == ["crank", "status"]:
    print(json.dumps({"project": {"root": os.getcwd()}, "policy": {
        "enabled": bool(crank.get("enabled", False)), "enabledSource": "project" if "enabled" in crank else "built-in default",
        "interval": crank.get("interval", "5m"), "intervalSource": "project" if "interval" in crank else "built-in default",
    }, "sessions": []}))
elif args[:2] == ["crank", "enable"]:
    interval = args[args.index("--interval") + 1] if "--interval" in args else "5m"
    doc["crank"] = {**crank, "enabled": True, "interval": interval}
    project.write_text(json.dumps(doc, indent=2) + "\n")
    print(f"  ON  {pathlib.Path.cwd().name} every {interval} (.project.json)")
else:
    print(f"fake pj: unsupported {args}", file=sys.stderr); sys.exit(2)
