#!/usr/bin/env python3
"""Currency regression: --currency must fail closed on any drift.

Baseline verifies the real manifest against the live journal (exactly the
recorded reconciled row, SQLite URI mode=ro, selected fields only) and every
pinned source digest. Negatives mutate temporary copies of the real manifest.
No journal writes, no Redis, no bus. Children run with -B -I.
"""

import copy
import hashlib
import json
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CHECKER = ROOT / "scripts/check-flume-76-handoff.py"
MANIFEST = ROOT / "_bmad-output/implementation-artifacts/FLUME-76/agent-message-coordination.json"


def main():
    original = MANIFEST.read_bytes()
    baseline = json.loads(original)
    mutations = []

    def change(label, path, value, diagnostic):
        data = copy.deepcopy(baseline)
        target = data
        for key in path[:-1]:
            target = target[key]
        target[path[-1]] = value
        mutations.append((label, data, diagnostic))

    change("currency-row-state", ["reconciliation", "journal_row", "state"], "running", "BLOCKED")
    change("currency-row-updated", ["reconciliation", "journal_row", "updated_at"], "2026-11-09T00:00:00Z", "BLOCKED")
    change("currency-reply-sha", ["reconciliation", "reply", "copy_sha256"], "0" * 64, "BLOCKED")
    change("currency-resume-drift", ["sources", 8, "sha256"], "0" * 64, "BLOCKED")
    change("currency-reply-source-drift", ["sources", 3, "sha256"], "0" * 64, "BLOCKED")
    change("currency-expiry-not-in-resume", ["original_invocation", "observer_expires_at"], "2026-11-08T10:13:54Z", "BLOCKED")

    def run(path):
        argv = [sys.executable, "-B", "-I", str(CHECKER), str(path), "--currency"]
        result = subprocess.run(argv, capture_output=True, text=True, check=False)
        print(json.dumps({"argv": argv, "exit": result.returncode,
                          "stdout": result.stdout.strip(), "stderr": result.stderr.strip()}))
        return result

    head = subprocess.run(["git", "-C", str(ROOT), "rev-parse", "HEAD"],
                          capture_output=True, text=True, check=True).stdout.strip()
    print(json.dumps({"parent_head": head, "checker_sha256": hashlib.sha256(CHECKER.read_bytes()).hexdigest(),
                      "manifest_sha256": hashlib.sha256(original).hexdigest(), "kind": "currency real-artifact rejection probes; live journal read-only"}))
    result = run(MANIFEST)
    assert result.returncode == 0 and "VALID (structure+currency)" in result.stdout, "real currency baseline failed"
    with tempfile.TemporaryDirectory(prefix="flume76-currency-mutations-") as directory:
        for label, data, diagnostic in mutations:
            path = Path(directory) / (label + ".json")
            path.write_text(json.dumps(data))
            result = run(path)
            assert result.returncode in (1, 2) and diagnostic in result.stderr and "Traceback" not in result.stderr, label
            assert result.returncode != 0, label
    assert MANIFEST.read_bytes() == original, "authored artifact changed"
    print(f"PASS: currency baseline + {len(mutations)} fail-closed negatives; temp copies removed; authored artifact unchanged")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
