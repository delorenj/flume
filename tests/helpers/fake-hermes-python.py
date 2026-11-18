#!/usr/bin/env python3
"""A stand-in for Hermes' Python running scripts/launch-hermes-job.py: one JSON request on stdin,
the profile's cron/jobs.json edited the way cron.jobs.create_job/update_job would."""
import json, os, pathlib, sys

request = json.load(sys.stdin)
home = pathlib.Path(os.environ["HERMES_FLEET_HOME"]) / "profiles" / request["profile"] / "cron"
home.mkdir(parents=True, exist_ok=True)
store = home / "jobs.json"
doc = json.loads(store.read_text()) if store.exists() else {"jobs": []}
job = None
if request["job_id"] is None:
    c = request["create"]
    job = {"id": "feedfacecafe", "name": c["name"], "prompt": c["prompt"], "skills": ["preloaded"], "skill": None,
           "script": c["script"], "monitor_script": c["monitor_script"], "schedule": {"kind": "cron", "expr": c["schedule"]},
           "enabled": True, "state": "scheduled", "scheduler": "external", "timezone": c.get("timezone"),
           "reasoning_effort": c.get("reasoning_effort"), "enabled_toolsets": None, "economics": {}}
    doc["jobs"].append(job)
else:
    job = next((j for j in doc["jobs"] if j["id"] == request["job_id"]), None)
    if job is None:
        print(json.dumps({"ok": False, "error": "no such job"})); sys.exit(1)
for key, value in (request.get("updates") or {}).items():
    if key == "schedule":
        job["schedule"] = {"kind": "cron", "expr": value}
    else:
        job[key] = value
store.write_text(json.dumps(doc))
print(json.dumps({"ok": True, "job": job}))
