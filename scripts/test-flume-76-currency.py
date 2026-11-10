#!/usr/bin/env python3
"""Currency regression: --currency must fail closed on real evidence drift.

Every negative reaches check_currency: the manifest is left untouched (structure
passes on the real artifact), and drift is injected through scratch copies under
a temp dir via the explicit, default-off FLUME76_EVIDENCE_OVERRIDES path map.
Scratch journal rows are copied from the live journal (read-only) into a
throwaway SQLite file, then changed/duplicated/removed there. The live journal,
real evidence files and parent docs are never written. Children run -B -I.
"""

import hashlib
import json
import os
import shutil
import sqlite3
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CHECKER = ROOT / "scripts/check-flume-76-handoff.py"
MANIFEST = ROOT / "_bmad-output/implementation-artifacts/FLUME-76/agent-message-coordination.json"
JOURNAL = "/home/delorenj/.hermes/bloodbank-hermes-gateway-state.sqlite3"
COMMAND = "149134bb-3c88-4ebf-8ecf-98610e054933"
RECEIPT = "/home/delorenj/.claude/tmp/i9-flume-stored-command-receipt.json"
REPLY = "/home/delorenj/.claude/tmp/i9-flume-pm-final-reply-2026-11-08.md"
RESUME = "/home/delorenj/code/33GOD/_bmad-output/specs/spec-i9-agent-message-owner-handoff/resume.md"
COLUMNS = "profile, state, outcome, created_at, updated_at, rejection_reason, failure_code, detached_at, terminal_events"


def real_row():
    with sqlite3.connect("file:" + JOURNAL + "?mode=ro", uri=True) as db:
        rows = db.execute("SELECT " + COLUMNS + " FROM executions WHERE command_id = ?", (COMMAND,)).fetchall()
    assert len(rows) == 1, "expected exactly one live journal row to copy"
    return rows[0]


def scratch_journal(directory, row, extra=None):
    Path(directory).mkdir(parents=True, exist_ok=True)
    path = Path(directory) / "journal.sqlite3"
    with sqlite3.connect(path) as db:
        db.execute("CREATE TABLE executions (command_id TEXT, profile TEXT, state TEXT, outcome TEXT, "
                   "created_at TEXT, updated_at TEXT, rejection_reason TEXT, failure_code TEXT, "
                   "detached_at TEXT, terminal_events TEXT)")
        db.execute("INSERT INTO executions (command_id, " + COLUMNS + ") VALUES (?,?,?,?,?,?,?,?,?,?)",
                   (COMMAND,) + tuple(row))
        for dup in extra or []:
            db.execute("INSERT INTO executions (command_id, " + COLUMNS + ") VALUES (?,?,?,?,?,?,?,?,?,?)",
                       (COMMAND,) + tuple(dup))
    return str(path)


def run(overrides):
    env = dict(os.environ)
    if overrides is not None:
        env["FLUME76_EVIDENCE_OVERRIDES"] = str(overrides)
    else:
        env.pop("FLUME76_EVIDENCE_OVERRIDES", None)
    argv = [sys.executable, "-B", "-I", str(CHECKER), str(MANIFEST), "--currency"]
    result = subprocess.run(argv, capture_output=True, text=True, check=False, env=env)
    print(json.dumps({"argv": argv, "exit": result.returncode,
                      "stdout": result.stdout.strip(), "stderr": result.stderr.strip()}))
    return result


def main():
    original = MANIFEST.read_bytes()
    row = real_row()
    print(json.dumps({"parent_head": subprocess.run(["git", "-C", str(ROOT), "rev-parse", "HEAD"],
                                                    capture_output=True, text=True, check=True).stdout.strip(),
                      "checker_sha256": hashlib.sha256(CHECKER.read_bytes()).hexdigest(),
                      "manifest_sha256": hashlib.sha256(original).hexdigest(),
                      "kind": "currency drift injected via scratch copies; manifest untouched"}))
    with tempfile.TemporaryDirectory(prefix="flume76-currency-mutations-") as directory:
        # Baseline: no overrides, real paths, real manifest.
        result = run(None)
        assert result.returncode == 0 and "VALID (structure+currency)" in result.stdout, "real currency baseline failed"

        cases = []

        def overrides_file(name, mapping):
            path = Path(directory) / (name + ".json")
            path.write_text(json.dumps(mapping))
            return path

        # 1. Scratch journal with changed state.
        mutated = list(row)
        mutated[1] = "running"
        cases.append(("journal-state-changed", overrides_file(
            "journal-state", {JOURNAL: scratch_journal(directory + "/s1", mutated)}),
            "currency: journal profile/state/outcome changed"))
        # 2. Scratch journal with changed updated_at.
        mutated = list(row)
        mutated[4] = "2026-11-09T00:00:00Z"
        cases.append(("journal-updated-changed", overrides_file(
            "journal-updated", {JOURNAL: scratch_journal(directory + "/s2", mutated)}),
            "currency: journal timestamps changed"))
        # 3. Scratch journal with the row removed.
        empty = Path(directory) / "s3/journal.sqlite3"
        (Path(directory) / "s3").mkdir()
        with sqlite3.connect(empty) as db:
            db.execute("CREATE TABLE executions (command_id TEXT, profile TEXT, state TEXT, outcome TEXT, "
                       "created_at TEXT, updated_at TEXT, rejection_reason TEXT, failure_code TEXT, "
                       "detached_at TEXT, terminal_events TEXT)")
        cases.append(("journal-row-missing", overrides_file("journal-missing", {JOURNAL: str(empty)}),
                      "currency: expected exactly one journal row, found 0"))
        # 4. Scratch journal with the row duplicated.
        cases.append(("journal-row-duplicated", overrides_file(
            "journal-dup", {JOURNAL: scratch_journal(directory + "/s4", row, extra=[row])}),
            "currency: expected exactly one journal row, found 2"))
        # 5. Scratch copy of the stored receipt with one byte changed.
        drifted = Path(directory) / "receipt-drifted.json"
        content = bytearray(Path(RECEIPT).read_bytes())
        content[0] ^= 0x01
        drifted.write_bytes(bytes(content))
        cases.append(("receipt-digest-drift", overrides_file("receipt-drift", {RECEIPT: str(drifted)}),
                      "currency: digest drift for " + RECEIPT))
        # 6. Scratch copy of the reply with one byte changed.
        drifted_reply = Path(directory) / "reply-drifted.md"
        content = bytearray(Path(REPLY).read_bytes())
        content[0] ^= 0x01
        drifted_reply.write_bytes(bytes(content))
        cases.append(("reply-digest-drift", overrides_file("reply-drift", {REPLY: str(drifted_reply)}),
                      "currency: digest drift for " + REPLY))
        # 7. Scratch copy of resume.md with the observer expiry removed. The pinned
        # digest fires first (a resume without the expiry necessarily drifts), so
        # this is a digest-drift negative; the expiry-text check guards future
        # repins, not this probe.
        drifted_resume = Path(directory) / "resume-drifted.md"
        drifted_resume.write_text(Path(RESUME).read_text().replace("2026-11-08T10:13:53.579009Z", "REMOVED"))
        cases.append(("resume-digest-drift", overrides_file("resume-drift", {RESUME: str(drifted_resume)}),
                      "currency: digest drift for " + RESUME))

        for label, overrides, diagnostic in cases:
            result = run(overrides)
            assert result.returncode in (1, 2) and diagnostic in result.stderr and "Traceback" not in result.stderr, label
            assert result.returncode != 0, label
    assert MANIFEST.read_bytes() == original, "authored artifact changed"
    print(f"PASS: currency baseline + {len(cases)} negatives each rejected inside check_currency; temp copies removed; authored artifact unchanged")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
