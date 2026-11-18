#!/usr/bin/env python3
"""Create or update the Hermes job behind a PM's launch pass (`flume launch enable`).

Run with Hermes' own Python so the real jobs store and its validators apply:

  ~/.hermes/hermes-agent/.venv/bin/python launch-hermes-job.py < request.json

stdin is one JSON object:
  {"profile": "earshot-pm", "job_id": null | "<hex>",
   "create": {"prompt": ..., "schedule": ..., "name": ..., "script": ..., "monitor_script": ...,
              "timezone": ..., "reasoning_effort": ...},        # used only when job_id is null
   "updates": {...}}                                            # applied to the job afterwards

The job is always pinned `scheduler: external`: Candybar is its only clock. Nothing here schedules
anything. stdout is one JSON object: {"ok": true, "job": {...}} or {"ok": false, "error": "..."}.
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path


def main() -> int:
    try:
        request = json.load(sys.stdin)
        profile = request["profile"]
        home = Path.home() / ".hermes" / "profiles" / profile
        fleet = os.environ.get("HERMES_FLEET_HOME")
        if fleet:
            home = Path(fleet) / "profiles" / profile
        if not home.is_dir():
            raise RuntimeError(f"no profile dir {home}")
        os.environ["HERMES_HOME"] = str(home)
        hermes_root = Path(os.environ.get("HERMES_AGENT_ROOT") or Path.home() / ".hermes" / "hermes-agent")
        sys.path.insert(0, str(hermes_root))
        from cron import jobs  # noqa: E402  (needs HERMES_HOME set first)

        job_id = request.get("job_id")
        if job_id is None:
            c = request["create"]
            job = jobs.create_job(
                prompt=c["prompt"],
                schedule=c["schedule"],
                name=c.get("name"),
                deliver="local",
                script=c["script"],
                monitor_script=c["monitor_script"],
                timezone=c.get("timezone"),
                reasoning_effort=c.get("reasoning_effort"),
                scheduler="external",
            )
            job_id = job["id"]
        updates = dict(request.get("updates") or {})
        if updates:
            job = jobs.update_job(job_id, updates)
        else:
            job = jobs.get_job(job_id)
        if not job:
            raise RuntimeError(f"no job {job_id} in profile {profile}")
        print(json.dumps({"ok": True, "job": job}, default=str))
        return 0
    except Exception as error:  # noqa: BLE001 - one JSON verdict for the caller
        print(json.dumps({"ok": False, "error": f"{type(error).__name__}: {error}"}))
        return 1


if __name__ == "__main__":
    sys.exit(main())
