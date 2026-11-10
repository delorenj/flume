#!/usr/bin/env python3
"""FLUME-76 handoff check, not native protocol certification.

Default mode validates STRUCTURE only: manifest shape, blocked-state invariants
and consistency with the durable evidence copies (historical receipt/snapshot
and the reconciliation record, committed byte-identical under
_bmad-output/implementation-artifacts/FLUME-76/evidence/). It never reads the
live gateway journal or parent repo documents, so those checks keep running
when live evidence changes.

--currency is a separate fail-closed check. Every pinned source digest must
match (the five scratch-recorded sources are read from their durable copies),
the pinned candidate executable must hash to its pinned digest, and the live
journal (SQLite URI mode=ro, path percent-encoded) must hold exactly one row for
the original command whose profile, state, outcome, created_at, updated_at,
rejection_reason, failure_code, detached_at and terminal_events id/type/time
equal the recorded values. Other columns (lane, rejected_at, started_events,
envelope_digest, event causation ids) are not compared.

FLUME76_EVIDENCE_OVERRIDES is a default-off test seam (currency mode only). Its
replacement paths must resolve under tempfile.gettempdir(), and whenever the
variable is set, --currency never prints VALID: a run whose evidence all checks
out still exits 1 naming the active overrides.

Exit 1: invalid/inconsistent artifact; exit 2: local evidence unavailable.
"""

import argparse
import hashlib
import json
import os
import re
import sqlite3
import sys
import tempfile
import urllib.parse
from datetime import datetime
from pathlib import Path

COMMAND = "149134bb-3c88-4ebf-8ecf-98610e054933"
CORRELATION = "f9126f02-14cf-4fae-8a5c-00026336cefa"
# Recorded scratch paths: the manifest's evidence identity. They are never read
# directly; DURABLE maps each to its committed byte-identical copy.
RECEIPT = "/home/delorenj/.claude/tmp/i9-flume-stored-command-receipt.json"
SNAPSHOT = "/home/delorenj/.claude/tmp/i9-flume-observer-expiry-evidence.json"
RECONCILIATION = "/home/delorenj/.claude/tmp/i9-flume-original-request-reconciliation-2026-11-09.json"
REPLY = "/home/delorenj/.claude/tmp/i9-flume-pm-final-reply-2026-11-08.md"
EVENTS = "/home/delorenj/.claude/tmp/i9-flume-correlated-events-2026-11-09.json"
EVIDENCE_DIR = Path(__file__).resolve().parents[1] / "_bmad-output/implementation-artifacts/FLUME-76/evidence"
DURABLE = {path: EVIDENCE_DIR / Path(path).name for path in (RECEIPT, SNAPSHOT, RECONCILIATION, REPLY, EVENTS)}
PARENT = "/home/delorenj/code/33GOD"
RESUME = PARENT + "/_bmad-output/specs/spec-i9-agent-message-owner-handoff/resume.md"
REQUIRED_SOURCES = {
    RECEIPT: ("historical_receipt", "e5b1ce26762831bb005fd8584d5fcc60a3e792a8c89f0a0565279b74beeaffae"),
    SNAPSHOT: ("historical_snapshot", "906478a2d18e5bfb0ecee46653370bd7db6d9f67a41e51865309c3752cfc4035"),
    RECONCILIATION: ("reconciliation_record", "d0990398727cadf03ca9657c1652e8b73497f2aef718929dce1cbf55ef53b585"),
    REPLY: ("owner_reply_copy", "e779f054f306a7002e1cec6946eea49a10d762917ab63ac7745abcf7c25b5854"),
    EVENTS: ("candystore_events", "e00620c988e1b1fd77e480e7b981f4f94181e207a5778291fba55ff63522f6a8"),
    PARENT + "/33god-platform/components/hermes-fleet.yaml": ("fleet_component_card", "23627b9dc9bc8ab943606179e3a22a01d0fa9d11ceb0dfe1c83d39d5355a7df4"),
    PARENT + "/_bmad-output/specs/spec-i9-agent-message-owner-handoff/SPEC.md": ("parent_spec", "3b386c035dbd77af2e5a9cafb32943e548c9a37d7d0979bdf33ba9a432fa9691"),
    PARENT + "/_bmad-output/specs/spec-i9-agent-message-owner-handoff/acceptance-contract.md": ("parent_acceptance_contract", "e113f6fbf5542f50da8ec70211a95c5710868eb296c1c5fca4f7d24ed211b0b4"),
    RESUME: ("parent_resume", "1562d587187ffe2c65b840514edb6966e9cdc160a95c99cac9ea87676b4f1aaf"),
}
# Candidate executable: pinned like REQUIRED_SOURCES, never taken from the manifest.
INSTALLED_EXECUTABLE = "/home/delorenj/.local/share/claude/versions/2.1.319"
INSTALLED_EXECUTABLE_SHA256 = "dabafec82ca1319fa43d8be36a10fc61b1d11821cb98ad5df04ad95e199b8eed"
FORBIDDEN_FILES = [
    "FLUME_RUNTIME_IDENTITY_REGISTRY_CREDENTIAL_CONFIG", "PARENT_FEATURES_CATALOG",
    "PJAN_202", "BB_32_33", "CRANK_RUNTIME_ADMISSION", "TERMINAL_DRIVER_INPUT",
    "OPERATOR_PANES", "HERMES_INSTALLED_PROFILES_AS_SOURCE",
]
CONSEQUENCE = {
    "native_submit": "FORBIDDEN", "terminal_fallback": "FORBIDDEN",
    "unknown_fence": "PERSIST_UNTIL_DECISIVE_RECONCILIATION",
}
PREREQUISITES = {
    "EXACT_ORIGINAL_OWNER_REPLY": "SATISFIED_COORDINATION_REPLY_ONLY",
    "FLEET_SOURCE_SELECTED": "MISSING",
    "FLEET_BOARD_PM_ENROLLED": "MISSING",
    "FLEET_AUTHORITY_EVIDENCED": "MISSING",
}
TERMINAL_EVENTS = [
    {"id": "3fe51b58-8ff9-5212-bdf9-e0988bd0d47c", "type": "bloodbank.agent.invocation.completed", "time": "2026-11-08T13:56:46.047623Z"},
    {"id": "d16988b9-1a67-5656-a992-fba0aaa433bb", "type": "bloodbank.conversation.turn.completed", "time": "2026-11-08T13:56:46.047639Z"},
]
# Stale evidence-state claims, matched on lowercased free text. The owner reply
# was received and reconciled, and Fleet adoption is BLOCKED, so prose saying the
# reply is still awaited, or that the contract was adopted, contradicts the record.
# Pattern 0 is the reviewed 456facc blocker guard, verbatim (substring match, so
# "responses", "replying", "impending" still count) except that ';' joins '.' and
# '\n' as a clause boundary. Patterns 1-6 widen it: plurals, answers,
# outstanding/awaited, "no reply yet", "not received", "unanswered", "still pending".
# Clause-boundary tradeoff: a reply/response word and a pending word in different
# ';' clauses are not linked. That accepts the honest "Coordination reply received;
# Fleet adoption pending source selection." (456facc rejected it, a false positive)
# and, as the price, also accepts a stale claim split by ';' such as
# "... planning reply; pending", which 456facc rejected. Every other wording the
# 456facc guard rejected is still rejected. "historical PENDING" wording matches
# only if a reply/response/answer word shares its clause.
STALE_PENDING = [
    r"(response|reply)[^.;\n]*(remains |is |still )?pending",
    r"\b(responses?|repl(?:y|ies)|answers?)\b[^.;\n]*\b(pending|outstanding|awaited|unanswered)\b",
    r"\b(pending|outstanding|awaited|awaiting|waiting (for|on))\b[^.;\n]*\b(responses?|repl(?:y|ies)|answers?)\b",
    r"\bno\s+(\S+\s+){0,2}(responses?|repl(y|ies)|answers?)\s+(yet|received|recorded)\b",
    r"\b(responses?|repl(?:y|ies)|answers?)\s+(has\s+|have\s+|was\s+|were\s+)?not\s+(yet\s+)?(been\s+)?(received|recorded|arrived|given|returned)\b",
    r"\bunanswered\b",
    r"\b(still|remains?|currently|now)\s+(pending|outstanding|unanswered|awaiting)\b",
]
ADOPTION_CLAIM = r"\badoption\b\W{0,3}(?:(?:is|was|has|been|now)\s+)*(accepted|complete|completed|done|succeeded|granted|approved)\b"
# "adopted"/"adopts" is a claim unless directly negated ("not adopted", "has not yet been adopted").
ADOPTED_WORD = r"\b(?:(not|never|no longer)\s+(?:(?:yet|been|be|being)\s+)*)?(adopted|adopts)\b"


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


def evidence_state(value, path):
    """Free text that asserts evidence state must not contradict the reconciled record."""
    text(value, path)
    lowered = value.lower()
    for pattern in STALE_PENDING:
        require(not re.search(pattern, lowered), f"{path}: stale pending-response claim contradicts reconciled reply")
    claimed = re.search(ADOPTION_CLAIM, lowered) or any(m.group(1) is None for m in re.finditer(ADOPTED_WORD, lowered))
    require(not claimed, f"{path}: adoption claim contradicts BLOCKED disposition")


def load_structure(manifest: Path):
    """Manifest shape and stable-scratch consistency; no journal, no parent docs."""
    data = record(json.loads(manifest.read_text()), "manifest",
                  "schema ticket scope original_invocation reconciliation owner_binding candidate gates "
                  "later_validation_manifest next_true_owner_brief sources")
    for field, expected in {"schema": "flume.i9.agent-message-coordination.v3",
                            "ticket": "FLUME-76", "scope": "COORDINATION_ONLY"}.items():
        require(data[field] == expected, f"{field}: expected {expected}")
    invocation = record(data["original_invocation"], "original_invocation",
                        "command_id correlation_id thread_id target subject stream sequence stored_at "
                        "observer_expires_at last_snapshot_at latest_scoped_journal_read owner_response "
                        "interpretation dispatch_policy observer_evidence")
    identity = {"command_id": COMMAND, "correlation_id": CORRELATION,
                "thread_id": "i9-agent-message-planning:" + CORRELATION,
                "target": "flume-pm", "subject": "bloodbank.cmd.agent.invocation.start",
                "stream": "BLOODBANK_COMMANDS", "owner_response": "ANSWERED_COORDINATION_ONLY",
                "interpretation": "EXECUTION_COMPLETED_REPLY_RECORDED_NOT_ADOPTION", "observer_evidence": RESUME,
                # Immutable history: original stored time, fixed observer expiry, final snapshot.
                "stored_at": "2026-11-08T09:59:07.11897492Z",
                "observer_expires_at": "2026-11-08T10:13:53.579009Z",
                "last_snapshot_at": "2026-11-08T10:14:20.883733Z"}
    for field, expected in identity.items():
        require(invocation[field] == expected, f"original_invocation.{field}: expected {expected}")
    require(type(invocation["sequence"]) is int and invocation["sequence"] == 160790,
            "original_invocation.sequence: expected stored sequence 160790")
    evidence_state(invocation["latest_scoped_journal_read"], "original_invocation.latest_scoped_journal_read")
    policy = record(invocation["dispatch_policy"], "dispatch_policy", "resend replay cross_route")
    require(all(value is False for value in policy.values()), "dispatch_policy: resend/replay/cross_route must all be false")
    stored = timestamp(invocation["stored_at"], "original_invocation.stored_at")
    expiry = timestamp(invocation["observer_expires_at"], "original_invocation.observer_expires_at")
    checked = timestamp(invocation["last_snapshot_at"], "original_invocation.last_snapshot_at")
    require(stored < expiry <= checked, "original_invocation: expected stored_at < observer_expires_at <= last_snapshot_at")

    recon = record(data["reconciliation"], "reconciliation",
                   "reconciled_at record record_sha256 journal_row terminal_events reply disposition historical_snapshot")
    require(recon["reconciled_at"] == "2026-11-10T00:20:14.138412Z", "reconciliation.reconciled_at: unexpected value")
    require(recon["record"] == RECONCILIATION and recon["record_sha256"] == REQUIRED_SOURCES[RECONCILIATION][1],
            "reconciliation.record: identity or digest changed")
    evidence_state(recon["historical_snapshot"], "reconciliation.historical_snapshot")
    row = record(recon["journal_row"], "reconciliation.journal_row",
                 "profile state outcome created_at updated_at rejection_reason failure_code detached_at")
    require((row["profile"], row["state"], row["outcome"]) == ("flume-pm", "completed", "success"),
            "reconciliation.journal_row: expected flume-pm completed/success")
    require(row["created_at"] == "2026-11-08T13:48:40.160176Z" and row["updated_at"] == "2026-11-08T13:56:46.047665Z",
            "reconciliation.journal_row: timestamps changed")
    require(row["rejection_reason"] is None and row["failure_code"] is None and row["detached_at"] is None,
            "reconciliation.journal_row: rejection/failure/detached must remain null")
    require(recon["terminal_events"] == TERMINAL_EVENTS, "reconciliation.terminal_events: recorded ids/types/times changed")
    reply = record(recon["reply"], "reconciliation.reply",
                   "copy_path copy_sha256 session_id message_id finish_reason message_time")
    require(reply["copy_path"] == REPLY and reply["copy_sha256"] == REQUIRED_SOURCES[REPLY][1] and
            reply["session_id"] == "20261108_084840_86474df2" and reply["message_id"] == 3949 and
            reply["finish_reason"] == "stop" and reply["message_time"] == "2026-11-08T13:56:45.783575Z",
            "reconciliation.reply: identity changed")
    disposition = record(recon["disposition"], "reconciliation.disposition",
                         "coordination_receipt fleet_contract_adoption authoritative_agent_message_contract capability_predicate g1_g2_g3")
    require(disposition == {"coordination_receipt": "ACCEPTED", "fleet_contract_adoption": "BLOCKED",
                            "authoritative_agent_message_contract": "ABSENT", "capability_predicate": "UNSUPPORTED",
                            "g1_g2_g3": "BLOCKED_NOT_RUN"},
            "reconciliation.disposition: distinct verdicts changed")

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
    evidence_state(owner["blocker"], "owner_binding.blocker")
    require(bool(re.fullmatch(r"[0-9a-f]{40}", str(owner["template_revision"]))), "owner_binding.template_revision: expected full source SHA")

    candidate = record(data["candidate"], "candidate",
                       "cohort predicate current installed_executable installed_executable_sha256 installed_inspection")
    require(candidate["current"] == "UNSUPPORTED_FOR_SUBMISSION", "candidate.current: native submit must remain unsupported")
    for field in ("cohort", "predicate", "installed_executable", "installed_inspection"):
        text(candidate[field], f"candidate.{field}")
    evidence_state(candidate["installed_inspection"], "candidate.installed_inspection")
    require(candidate["installed_executable"] == INSTALLED_EXECUTABLE,
            f"candidate.installed_executable: expected pinned {INSTALLED_EXECUTABLE}")
    require(candidate["installed_executable_sha256"] == INSTALLED_EXECUTABLE_SHA256,
            f"candidate.installed_executable_sha256: expected pinned {INSTALLED_EXECUTABLE_SHA256}")
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
    require(later["executable_digest"] == "candidate evidence only: " + INSTALLED_EXECUTABLE_SHA256,
            "later_validation_manifest.executable_digest: must reference candidate evidence only")

    brief = record(data["next_true_owner_brief"], "next_true_owner_brief",
                   "state ticket worker instruction required_prerequisites allowed_files forbidden_files dependencies verdict_separation")
    require(brief["state"] == "BLOCKED_SOURCE_SELECTION", "next_true_owner_brief.state: expected BLOCKED_SOURCE_SELECTION")
    require(brief["ticket"] is None and brief["worker"] is None, "next_true_owner_brief: unverified ticket/worker must remain null")
    require(brief["instruction"] == "WAIT_FOR_VERIFIED_FLEET_BINDING_THEN_ONE_TICKET", "next_true_owner_brief.instruction: must wait for verified Fleet binding")
    prereq = brief["required_prerequisites"]
    require(type(prereq) is list and len(prereq) == 4, "next_true_owner_brief.required_prerequisites: expected four structured entries")
    seen = {}
    for item in prereq:
        record(item, "required_prerequisites[]", "name status")
        require(item["name"] in PREREQUISITES, "required_prerequisites: unexpected name " + str(item["name"]))
        seen[item["name"]] = item["status"]
    require(seen == PREREQUISITES, "required_prerequisites: statuses changed")
    for field, expected in {"allowed_files": ["SELECTED_FLEET_CONTRACT_AND_VALIDATION_ONLY"],
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
        record(source, "source", "path sha256 role")
        text(source["path"], "source.path")
        require(type(source["sha256"]) is str and bool(re.fullmatch(r"[0-9a-f]{64}", source["sha256"])), "source.sha256: expected SHA256")
        require(source["path"] in REQUIRED_SOURCES, "sources: unexpected path " + source["path"])
        role, digest = REQUIRED_SOURCES[source["path"]]
        require(source["role"] == role, "sources: role changed for " + source["path"])
        require(source["sha256"] == digest, "sources: digest changed for " + source["path"] + " (currency check verifies files)")
        require(source["path"] not in sources, "sources: duplicate path")
        sources[source["path"]] = source["sha256"]
    require(set(sources) == set(REQUIRED_SOURCES), "sources: exact nine reference set required")

    # Durable evidence consistency (committed copies; no live journal, no parent docs).
    receipt = json.loads(DURABLE[RECEIPT].read_text())
    snapshot = json.loads(DURABLE[SNAPSHOT].read_text())
    recon_record = json.loads(DURABLE[RECONCILIATION].read_text())
    for field, reference in {"command_id": "command_id", "correlation_id": "correlationid", "target": "target_agent_id",
                             "sequence": "sequence", "subject": "subject", "stream": "stream", "stored_at": "time"}.items():
        require(invocation[field] == receipt[reference], f"original_invocation.{field}: differs from stored receipt")
    require(checked == timestamp(snapshot["checked_at"], "snapshot.checked_at"), "original_invocation.last_snapshot_at: differs from snapshot.checked_at")
    require((snapshot["command_id"], snapshot["correlationid"], snapshot["observer"], snapshot["execution"]) ==
            (COMMAND, CORRELATION, "expired-no-terminal-receipt", None) and
            not snapshot["observed_events"] and not snapshot["durable_events"], "snapshot: does not support historical pending state")
    require(snapshot["stored_command"]["sequence"] == invocation["sequence"] and
            snapshot["stored_command"]["time"] == invocation["stored_at"] and
            snapshot["stored_command"]["subject"] == invocation["subject"] and
            snapshot["stored_command"]["target"] == invocation["target"] and snapshot["stored_command"]["matches"] is True,
            "snapshot.stored_command: does not match original invocation")
    require(snapshot["batch"]["delivered"]["stream_seq"] < invocation["sequence"], "snapshot: no longer proves undelivered at historical snapshot")
    require(recon_record["command_id"] == COMMAND and recon_record["correlationid"] == CORRELATION,
            "reconciliation record: identity changed")
    journal = recon_record["journal"]["row"]
    require(recon_record["journal"]["rows"] == 1 and
            journal["profile"] == row["profile"] and journal["state"] == row["state"] and
            journal["outcome"] == row["outcome"] and journal["created_at"] == row["created_at"] and
            journal["updated_at"] == row["updated_at"] and journal["rejection_reason"] is None and
            journal["failure_code"] is None and journal["detached_at"] is None,
            "reconciliation.journal_row: differs from reconciliation record")
    require([{"id": e["id"], "type": e["type"], "time": e["time"]} for e in journal["terminal_events"]] == TERMINAL_EVENTS,
            "reconciliation.terminal_events: differs from reconciliation record")
    record_reply = recon_record["owner_reply"]
    require(record_reply["copy"] == REPLY and record_reply["sha256"] == reply["copy_sha256"] and
            record_reply["session_id"] == reply["session_id"] and record_reply["message_id"] == reply["message_id"],
            "reconciliation.reply: differs from reconciliation record")
    require(recon_record["disposition_quoted_from_reply"]["coordination_receipt"].startswith("ACCEPTED") and
            recon_record["disposition_quoted_from_reply"]["fleet_contract_adoption"].startswith("BLOCKED") and
            recon_record["disposition_quoted_from_reply"]["authoritative_agent_message_contract"].startswith("ABSENT"),
            "reconciliation.disposition: differs from reconciliation record")


JOURNAL = "/home/delorenj/.hermes/bloodbank-hermes-gateway-state.sqlite3"
OVERRIDES_ENV = "FLUME76_EVIDENCE_OVERRIDES"


def journal_uri(path):
    """Read-only SQLite URI; the path is percent-encoded so '?', '#', '&' or '%' cannot alter mode=ro."""
    return "file:" + urllib.parse.quote(str(Path(path).absolute()), safe="/") + "?mode=ro"


def currency_overrides():
    """Default-off test seam: FLUME76_EVIDENCE_OVERRIDES names a JSON map {recorded path: replacement}.

    Returns None when the variable is unset. When it is set (even to an empty
    map), check_currency refuses VALID after all checks, so redirected evidence
    can never yield a currency pass. Keys must be pinned source paths or the
    journal; replacements must resolve (symlinks followed) under
    tempfile.gettempdir(). Only honored in --currency mode.
    """
    env = os.environ.get(OVERRIDES_ENV)
    if env is None:
        return None
    require(bool(env.strip()), f"currency: {OVERRIDES_ENV} is set but empty; overrides refused")
    mapping = json.loads(Path(env).read_text())
    require(type(mapping) is dict and all(type(k) is str and type(v) is str and v for k, v in mapping.items()),
            "currency: overrides file must map path strings to nonempty path strings")
    unknown = sorted(set(mapping) - set(REQUIRED_SOURCES) - {JOURNAL})
    require(not unknown, f"currency: overrides name unknown evidence paths {unknown}")
    base = Path(tempfile.gettempdir()).resolve()
    for key, value in mapping.items():
        target = Path(value).resolve()
        require(target != base and target.is_relative_to(base),
                f"currency: override for {key} resolves outside tempfile.gettempdir() {base}: {target}")
    return mapping


def check_currency(data):
    """Fail-closed currency: pinned digests, pinned executable and the recorded journal columns."""
    overrides = currency_overrides()
    active = overrides or {}
    for path, (role, digest) in REQUIRED_SOURCES.items():
        actual = Path(active[path]) if path in active else DURABLE.get(path, Path(path))
        require(actual.is_file(), f"currency: missing source {path} ({role})")
        require(hashlib.sha256(actual.read_bytes()).hexdigest() == digest,
                f"currency: digest drift for {path} ({role})")
    require(hashlib.sha256(Path(INSTALLED_EXECUTABLE).read_bytes()).hexdigest() == INSTALLED_EXECUTABLE_SHA256,
            "currency: installed executable digest changed")
    resume = Path(active.get(RESUME, RESUME)).read_text()
    invocation = data["original_invocation"]
    require(invocation["observer_expires_at"] in resume, "currency: observer expiry absent from pinned resume evidence")
    row = data["reconciliation"]["journal_row"]
    with sqlite3.connect(journal_uri(active.get(JOURNAL, JOURNAL)), uri=True) as db:
        rows = db.execute("SELECT profile, state, outcome, created_at, updated_at, rejection_reason, failure_code, detached_at, terminal_events "
                          "FROM executions WHERE command_id = ?", (COMMAND,)).fetchall()
    require(len(rows) == 1, f"currency: expected exactly one journal row, found {len(rows)}")
    profile, state, outcome, created_at, updated_at, rejection, failure, detached, terminal = rows[0]
    require((profile, state, outcome) == (row["profile"], row["state"], row["outcome"]), "currency: journal profile/state/outcome changed")
    require(created_at == row["created_at"] and updated_at == row["updated_at"], "currency: journal timestamps changed")
    require(rejection_reason := (rejection is None), "currency: rejection_reason appeared")
    require(failure is None and detached is None, "currency: failure/detached fields appeared")
    events = json.loads(terminal)
    require([{"id": e["id"], "type": e["type"], "time": e["time"]} for e in events] == data["reconciliation"]["terminal_events"],
            "currency: terminal events changed")
    if overrides is not None:
        named = ", ".join(f"{key} -> {value}" for key, value in sorted(overrides.items())) or "(empty map)"
        raise InvalidHandoff(f"currency: {OVERRIDES_ENV} active, evidence redirected ({named}); VALID refused")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("manifest", type=Path)
    parser.add_argument("--currency", action="store_true",
                        help="also verify pinned digests, the pinned executable and the recorded journal columns")
    args = parser.parse_args()
    try:
        data = json.loads(args.manifest.read_text())
        load_structure(args.manifest)
        if args.currency:
            check_currency(data)
    except (InvalidHandoff, json.JSONDecodeError) as exc:
        print(f"BLOCKED: {exc}", file=sys.stderr)
        return 1
    except (OSError, sqlite3.Error) as exc:
        print(f"BLOCKED: local evidence unavailable: {exc}", file=sys.stderr)
        return 2
    except (KeyError, TypeError, ValueError) as exc:
        print(f"BLOCKED: malformed evidence/field: {exc}", file=sys.stderr)
        return 1
    mode = "structure+currency" if args.currency else "structure-only"
    print(f"VALID ({mode}): original invocation and blocked handoff corroborated; no native gates executed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
