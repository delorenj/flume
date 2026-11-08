#!/usr/bin/env python3
"""Read-only FLUME-76 handoff consistency check, not native protocol certification.

Checks structured blocked-state invariants and the real receipt/source references.
It neither dispatches input nor certifies the prose's native capability claims.
Exit 1: invalid/inconsistent handoff; exit 2: unavailable local evidence.
"""

import argparse
import hashlib
import json
import re
import sqlite3
import sys
from datetime import datetime
from pathlib import Path

COMMAND = "149134bb-3c88-4ebf-8ecf-98610e054933"
CORRELATION = "f9126f02-14cf-4fae-8a5c-00026336cefa"
RECEIPT = "/home/delorenj/.claude/tmp/i9-flume-stored-command-receipt.json"
SNAPSHOT = "/home/delorenj/.claude/tmp/i9-flume-observer-expiry-evidence.json"
PARENT = "/home/delorenj/code/33GOD"
RESUME = PARENT + "/_bmad-output/specs/spec-i9-agent-message-owner-handoff/resume.md"
REQUIRED_SOURCES = {
    RECEIPT, SNAPSHOT, RESUME,
    PARENT + "/33god-platform/components/hermes-fleet.yaml",
    PARENT + "/_bmad-output/specs/spec-i9-agent-message-owner-handoff/SPEC.md",
    PARENT + "/_bmad-output/specs/spec-i9-agent-message-owner-handoff/acceptance-contract.md",
}
PREREQUISITES = [
    "EXACT_ORIGINAL_OWNER_REPLY", "FLEET_SOURCE_SELECTED",
    "FLEET_BOARD_PM_ENROLLED", "FLEET_AUTHORITY_EVIDENCED",
]
FORBIDDEN_FILES = [
    "FLUME_RUNTIME_IDENTITY_REGISTRY_CREDENTIAL_CONFIG", "PARENT_FEATURES_CATALOG",
    "PJAN_202", "BB_32_33", "CRANK_RUNTIME_ADMISSION", "TERMINAL_DRIVER_INPUT",
    "OPERATOR_PANES", "HERMES_INSTALLED_PROFILES_AS_SOURCE",
]
CONSEQUENCE = {
    "native_submit": "FORBIDDEN", "terminal_fallback": "FORBIDDEN",
    "unknown_fence": "PERSIST_UNTIL_DECISIVE_RECONCILIATION",
}


class InvalidHandoff(ValueError):
    """An actionable authored artifact inconsistency."""


def require(condition, message):
    if not condition:
        raise InvalidHandoff(message)


def record(value, path, fields):
    require(type(value) is dict, f"{path}: expected object")
    expected = set(fields.split())
    require(set(value) == expected,
            f"{path}: missing fields {sorted(expected - set(value))}; "
            f"unexpected fields {sorted(set(value) - expected)}")
    return value


def text(value, path):
    require(type(value) is str and bool(value.strip()), f"{path}: expected nonempty string")


def texts(value, path, minimum=1, maximum=16):
    require(type(value) is list and minimum <= len(value) <= maximum,
            f"{path}: expected {minimum}..{maximum} nonempty strings")
    for index, item in enumerate(value):
        text(item, f"{path}[{index}]")


def timestamp(value, path):
    text(value, path)
    require(bool(re.fullmatch(r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)", value)),
            f"{path}: expected timezone-qualified ISO timestamp")
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as exc:
        raise InvalidHandoff(f"{path}: invalid timestamp") from exc


def validate(manifest: Path):
    data = record(json.loads(manifest.read_text()), "manifest",
                  "schema ticket scope original_invocation owner_binding candidate gates "
                  "later_validation_manifest next_true_owner_brief sources")
    for field, expected in {"schema": "flume.i9.agent-message-coordination.v2",
                            "ticket": "FLUME-76", "scope": "COORDINATION_ONLY"}.items():
        require(data[field] == expected, f"{field}: expected {expected}")
    invocation = record(data["original_invocation"], "original_invocation",
                        "command_id correlation_id thread_id target subject stream sequence stored_at "
                        "observer_expires_at last_snapshot_at latest_scoped_journal_read owner_response "
                        "interpretation dispatch_policy observer_evidence")
    identity = {"command_id": COMMAND, "correlation_id": CORRELATION,
                "thread_id": "i9-agent-message-planning:" + CORRELATION,
                "target": "flume-pm", "subject": "bloodbank.cmd.agent.invocation.start",
                "stream": "BLOODBANK_COMMANDS", "owner_response": "PENDING",
                "interpretation": "STORED_EXPIRED_NO_REPLY_NOT_REJECTION", "observer_evidence": RESUME}
    for field, expected in identity.items():
        require(invocation[field] == expected, f"original_invocation.{field}: expected {expected}")
    require(type(invocation["sequence"]) is int and invocation["sequence"] == 160790,
            "original_invocation.sequence: expected stored sequence 160790")
    text(invocation["latest_scoped_journal_read"], "original_invocation.latest_scoped_journal_read")
    policy = record(invocation["dispatch_policy"], "dispatch_policy", "resend replay cross_route")
    require(all(value is False for value in policy.values()), "dispatch_policy: resend/replay/cross_route must all be false")
    stored = timestamp(invocation["stored_at"], "original_invocation.stored_at")
    expiry = timestamp(invocation["observer_expires_at"], "original_invocation.observer_expires_at")
    checked = timestamp(invocation["last_snapshot_at"], "original_invocation.last_snapshot_at")
    require(stored < expiry <= checked, "original_invocation: expected stored_at < observer_expires_at <= last_snapshot_at")

    owner = record(data["owner_binding"], "owner_binding",
                   "coordination contract_owner mutation_owner source_selection enrolled_board enrolled_pm "
                   "authority_evidence catalog_owner_key fleet_component_source template_revision "
                   "implementation_home implementation_ticket blocker")
    for field, expected in {"coordination": "FLUME_COORDINATION_ONLY", "contract_owner": "Hermes Fleet",
                            "mutation_owner": "Hermes Fleet", "source_selection": "MISSING"}.items():
        require(owner[field] == expected, f"owner_binding.{field}: expected {expected}")
    for field in ("enrolled_board", "enrolled_pm", "authority_evidence", "implementation_home", "implementation_ticket"):
        require(owner[field] is None, f"owner_binding.{field}: unverified Fleet binding must remain null")
    for field in ("catalog_owner_key", "fleet_component_source", "blocker"):
        text(owner[field], f"owner_binding.{field}")
    require(bool(re.fullmatch(r"[0-9a-f]{40}", str(owner["template_revision"]))), "owner_binding.template_revision: expected full source SHA")

    candidate = record(data["candidate"], "candidate",
                       "cohort predicate current installed_executable installed_executable_sha256 installed_inspection")
    require(candidate["current"] == "UNSUPPORTED_FOR_SUBMISSION", "candidate.current: native submit must remain unsupported")
    for field in ("cohort", "predicate", "installed_executable", "installed_inspection"):
        text(candidate[field], f"candidate.{field}")
    gates = data["gates"]
    require(type(gates) is list and len(gates) == 3, "gates: expected exactly three gate objects")
    ids = []
    for index, gate in enumerate(gates):
        path = f"gates[{index}]"
        record(gate, path, "id owner question cases acceptance status missing_invocation unsupported_consequence")
        text(gate["id"], path + ".id")
        ids.append(gate["id"])
        require(gate["owner"] == "Hermes Fleet", path + ".owner: expected Hermes Fleet")
        require(gate["status"] == "BLOCKED_NOT_RUN", path + ".status: expected BLOCKED_NOT_RUN")
        for field in ("question", "acceptance", "missing_invocation"):
            text(gate[field], path + "." + field)
        texts(gate["cases"], path + ".cases")
        record(gate["unsupported_consequence"], path + ".unsupported_consequence", "native_submit terminal_fallback unknown_fence")
        require(gate["unsupported_consequence"] == CONSEQUENCE,
                path + ".unsupported_consequence: require no-submit/no-fallback and persistent unknown fence")
    require(set(ids) == {"G1", "G2", "G3"}, "gates: expected unique G1/G2/G3")
    later = record(data["later_validation_manifest"], "later_validation_manifest",
                   "status entrypoint_argv source_revision executable_digest disposable_resources inputs "
                   "independent_observer expected_events evidence_path teardown stop_conditions")
    require(later["status"] == "BLOCKED_NOT_RUN", "later_validation_manifest.status: expected BLOCKED_NOT_RUN")
    for field in ("entrypoint_argv", "source_revision", "independent_observer"):
        require(later[field] is None, f"later_validation_manifest.{field}: unavailable binding must remain null")
    for field in ("executable_digest", "disposable_resources", "inputs", "expected_events", "evidence_path", "teardown", "stop_conditions"):
        text(later[field], "later_validation_manifest." + field)
    require(later["executable_digest"] == "candidate evidence only: " + candidate["installed_executable_sha256"],
            "later_validation_manifest.executable_digest: must reference candidate evidence only")

    brief = record(data["next_true_owner_brief"], "next_true_owner_brief",
                   "state ticket worker instruction required_prerequisites allowed_files forbidden_files dependencies verdict_separation")
    require(brief["state"] == "BLOCKED_SOURCE_SELECTION", "next_true_owner_brief.state: expected BLOCKED_SOURCE_SELECTION")
    require(brief["ticket"] is None and brief["worker"] is None, "next_true_owner_brief: unverified ticket/worker must remain null")
    require(brief["instruction"] == "WAIT_FOR_VERIFIED_FLEET_BINDING_THEN_ONE_TICKET", "next_true_owner_brief.instruction: must wait for verified Fleet binding")
    for field, expected in {"required_prerequisites": PREREQUISITES,
                            "allowed_files": ["SELECTED_FLEET_CONTRACT_AND_VALIDATION_ONLY"],
                            "forbidden_files": FORBIDDEN_FILES,
                            "verdict_separation": ["HUB_WORKFLOW", "SCOPED_FR6", "FULL_I8"]}.items():
        require(brief[field] == expected, f"next_true_owner_brief.{field}: required boundaries changed")
    dependencies = brief["dependencies"]
    require(type(dependencies) is list and len(dependencies) == 5, "next_true_owner_brief.dependencies: expected five owner contracts")
    owners = []
    for dependency in dependencies:
        record(dependency, "dependency", "owner contract")
        text(dependency["owner"], "dependency.owner")
        text(dependency["contract"], "dependency.contract")
        owners.append(dependency["owner"])
    require(set(owners) == {"Bloodbank", "PJangler", "ASM", "terminal-driver", "Crank"}, "dependencies: owner set changed")

    require(type(data["sources"]) is list, "sources: expected source reference list")
    sources = {}
    for source in data["sources"]:
        record(source, "source", "path sha256")
        text(source["path"], "source.path")
        require(type(source["sha256"]) is str and bool(re.fullmatch(r"[0-9a-f]{64}", source["sha256"])), "source.sha256: expected SHA256")
        require(source["path"] not in sources, "sources: duplicate path")
        sources[source["path"]] = source["sha256"]
    require(set(sources) == REQUIRED_SOURCES, "sources: exact original receipt/expiry/card/SPEC/acceptance/resume references required")
    for name, digest in sources.items():
        require(hashlib.sha256(Path(name).read_bytes()).hexdigest() == digest, f"missing/drifted source: {name}")
    receipt = json.loads(Path(RECEIPT).read_text())
    snapshot = json.loads(Path(SNAPSHOT).read_text())
    for field, reference in {"command_id": "command_id", "correlation_id": "correlationid", "target": "target_agent_id",
                             "sequence": "sequence", "subject": "subject", "stream": "stream", "stored_at": "time"}.items():
        require(invocation[field] == receipt[reference], f"original_invocation.{field}: differs from stored receipt")
    require(checked == timestamp(snapshot["checked_at"], "snapshot.checked_at"), "original_invocation.last_snapshot_at: differs from snapshot.checked_at")
    resume = Path(RESUME).read_text()
    require(invocation["observer_expires_at"] in resume, "original_invocation.observer_expires_at: absent from hashed observer resume evidence")
    require((snapshot["command_id"], snapshot["correlationid"], snapshot["observer"], snapshot["execution"]) ==
            (COMMAND, CORRELATION, "expired-no-terminal-receipt", None) and
            not snapshot["observed_events"] and not snapshot["durable_events"], "snapshot: does not support historical pending state")
    require(snapshot["stored_command"]["sequence"] == invocation["sequence"] and
            snapshot["stored_command"]["time"] == invocation["stored_at"] and
            snapshot["stored_command"]["subject"] == invocation["subject"] and
            snapshot["stored_command"]["target"] == invocation["target"] and snapshot["stored_command"]["matches"] is True,
            "snapshot.stored_command: does not match original invocation")
    require(snapshot["batch"]["delivered"]["stream_seq"] < invocation["sequence"], "snapshot: no longer proves undelivered at historical snapshot")
    require(candidate["installed_executable_sha256"] == hashlib.sha256(Path(candidate["installed_executable"]).read_bytes()).hexdigest(), "candidate: installed executable digest changed")
    # Exact command only; mode=ro prevents writes. No broker or native endpoint.
    with sqlite3.connect("file:/home/delorenj/.hermes/bloodbank-hermes-gateway-state.sqlite3?mode=ro", uri=True) as db:
        rows = db.execute("SELECT state, profile, outcome, rejection_reason, failure_code, terminal_events "
                          "FROM executions WHERE command_id = ?", (COMMAND,)).fetchall()
    require(not rows, "new selected journal evidence: reconcile exact row before reusing PENDING handoff")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("manifest", type=Path)
    args = parser.parse_args()
    try:
        validate(args.manifest)
    except (InvalidHandoff, json.JSONDecodeError) as exc:
        print(f"BLOCKED: {exc}", file=sys.stderr)
        return 1
    except (OSError, sqlite3.Error) as exc:
        print(f"BLOCKED: local evidence unavailable: {exc}", file=sys.stderr)
        return 2
    except (KeyError, TypeError, ValueError) as exc:
        print(f"BLOCKED: malformed evidence/field: {exc}", file=sys.stderr)
        return 1
    print("VALID: original invocation identity and current blocked handoff corroborated; no native gates executed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
