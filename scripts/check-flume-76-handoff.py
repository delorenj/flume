#!/usr/bin/env python3
"""Read-only consistency check for FLUME-76's coordination handoff.

Validates authored state against the exact stored command and current local source
files. This cannot certify the native protocol, ingestion, or Fleet adoption.
"""

import argparse
import hashlib
import json
import sqlite3
import sys
from pathlib import Path

COMMAND = "149134bb-3c88-4ebf-8ecf-98610e054933"
CORRELATION = "f9126f02-14cf-4fae-8a5c-00026336cefa"
THREAD = "i9-agent-message-planning:" + CORRELATION
GATES = {"G1", "G2", "G3"}


def validate(manifest: Path) -> list[str]:
    errors: list[str] = []
    data = json.loads(manifest.read_text())
    invocation = data["original_invocation"]
    if (invocation["command_id"], invocation["correlation_id"], invocation["thread_id"]) != (
        COMMAND, CORRELATION, THREAD
    ):
        errors.append("original invocation identity changed")
    if invocation["owner_response"] != "PENDING":
        errors.append("unproven owner response promoted")
    if data["owner_binding"]["implementation_home"] is not None or data["owner_binding"]["implementation_ticket"] is not None:
        errors.append("unverified Fleet implementation home/ticket claimed")
    if data["candidate"]["current"] != "UNSUPPORTED_FOR_SUBMISSION":
        errors.append("native submit enabled without capability proof")
    if data["later_validation_manifest"]["entrypoint_argv"] is not None or data["later_validation_manifest"]["independent_observer"] is not None:
        errors.append("unverified invocation/observer claimed")
    gates = data["gates"]
    if {gate["id"] for gate in gates} != GATES or len(gates) != 3:
        errors.append("G1/G2/G3 gate set changed")
    for gate in gates:
        if gate["owner"] != "Hermes Fleet" or gate["status"] != "BLOCKED_NOT_RUN" or not gate["missing_invocation"]:
            errors.append(f"{gate['id']} lacks truthful blocked state")
    if data["next_true_owner_brief"]["ticket"] is not None or data["next_true_owner_brief"]["worker"] is not None:
        errors.append("unverified next owner work assigned")

    sources = {item["path"]: item["sha256"] for item in data["sources"]}
    for name, digest in sources.items():
        source = Path(name)
        if not source.is_file() or hashlib.sha256(source.read_bytes()).hexdigest() != digest:
            errors.append(f"missing/drifted source: {name}")
    receipt_path = "/home/delorenj/.claude/tmp/i9-flume-stored-command-receipt.json"
    snapshot_path = "/home/delorenj/.claude/tmp/i9-flume-observer-expiry-evidence.json"
    if receipt_path not in sources or snapshot_path not in sources:
        errors.append("original command/expiry sources absent")
        return errors
    receipt = json.loads(Path(receipt_path).read_text())
    snapshot = json.loads(Path(snapshot_path).read_text())
    if (receipt["command_id"], receipt["correlationid"], receipt["target_agent_id"], receipt["sequence"]) != (
        COMMAND, CORRELATION, invocation["target"], invocation["sequence"]
    ):
        errors.append("original stored command does not match handoff")
    if (snapshot["command_id"], snapshot["correlationid"], snapshot["observer"], snapshot["execution"]) != (
        COMMAND, CORRELATION, "expired-no-terminal-receipt", None
    ) or snapshot["observed_events"] or snapshot["durable_events"]:
        errors.append("original observer evidence does not support pending state")
    if snapshot["batch"]["delivered"]["stream_seq"] >= invocation["sequence"]:
        errors.append("expiry snapshot no longer proves undelivered at that time")
    if data["candidate"]["installed_executable_sha256"] != hashlib.sha256(
        Path(data["candidate"]["installed_executable"]).read_bytes()
    ).hexdigest():
        errors.append("installed executable digest changed")
    # Current journal is read-only and selected by the immutable command only.
    uri = "file:/home/delorenj/.hermes/bloodbank-hermes-gateway-state.sqlite3?mode=ro"
    with sqlite3.connect(uri, uri=True) as db:
        rows = db.execute(
            "SELECT state, profile, outcome, rejection_reason, failure_code, terminal_events "
            "FROM executions WHERE command_id = ?", (COMMAND,)
        ).fetchall()
    if rows:
        errors.append("new selected journal evidence: reconcile exact row before reusing PENDING handoff")
    return errors


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("manifest", type=Path)
    args = parser.parse_args()
    try:
        errors = validate(args.manifest)
    except (OSError, ValueError, KeyError, sqlite3.Error) as exc:
        print(f"BLOCKED: source could not be verified: {exc}", file=sys.stderr)
        return 2
    if errors:
        for error in errors:
            print(f"BLOCKED: {error}", file=sys.stderr)
        return 1
    print("VALID: original invocation identity and current blocked handoff corroborated; no native gates executed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
