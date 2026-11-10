#!/usr/bin/env python3
"""Structural regression: mutate temporary copies of the REAL FLUME-76 manifest.

The default structural check never touches the live gateway journal or parent
repo documents, so every probe here keeps running when that evidence changes.
The children get -B and -I; temporary copies are removed when the run ends.
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

    mutations.extend([("root-list", [], "manifest: expected object"),
                      ("root-null", None, "manifest: expected object")])
    for field in ("schema", "ticket", "scope"):
        data = copy.deepcopy(baseline)
        del data[field]
        mutations.append(("missing-" + field, data, "manifest: missing fields"))
    # Reconciliation identity and distinct verdicts (AC1 currency evidence).
    change("owner-response-pending", ["original_invocation", "owner_response"], "PENDING", "owner_response: expected")
    change("replay-prose", ["original_invocation", "interpretation"], "Replay the original now", "original_invocation.interpretation")
    change("replay-flag", ["original_invocation", "dispatch_policy", "replay"], True, "dispatch_policy")
    change("resend-flag", ["original_invocation", "dispatch_policy", "resend"], True, "dispatch_policy")
    change("cross-route-flag", ["original_invocation", "dispatch_policy", "cross_route"], True, "dispatch_policy")
    change("no-dispatch-policy", ["original_invocation", "dispatch_policy"], None, "dispatch_policy: expected object")
    change("no-reconciliation", ["reconciliation"], None, "reconciliation: expected object")
    change("journal-row-missing", ["reconciliation", "journal_row"], None, "journal_row: expected object")
    change("journal-row-state", ["reconciliation", "journal_row", "state"], "running", "expected flume-pm completed/success")
    change("journal-row-updated", ["reconciliation", "journal_row", "updated_at"], "2026-11-09T00:00:00Z", "timestamps changed")
    change("journal-row-rejected", ["reconciliation", "journal_row", "rejection_reason"], "timeout", "must remain null")
    change("terminal-event-id", ["reconciliation", "terminal_events", 0, "id"], "other", "recorded ids/types/times changed")
    change("terminal-events-null", ["reconciliation", "terminal_events"], None, "terminal_events: recorded")
    change("reply-sha", ["reconciliation", "reply", "copy_sha256"], "0" * 64, "reconciliation.reply: identity changed")
    change("reply-message", ["reconciliation", "reply", "message_id"], 0, "reconciliation.reply: identity changed")
    change("disposition-adoption", ["reconciliation", "disposition", "fleet_contract_adoption"], "ACCEPTED", "reconciliation.disposition: distinct verdicts changed")
    change("disposition-gates", ["reconciliation", "disposition", "g1_g2_g3"], "PASS", "reconciliation.disposition: distinct verdicts changed")
    change("recon-record-sha", ["reconciliation", "record_sha256"], "0" * 64, "reconciliation.record: identity or digest changed")
    # Timestamps: exact pins plus chronology.
    change("bad-timestamp", ["original_invocation", "last_snapshot_at"], "not-a-date", "last_snapshot_at: expected")
    change("future-stored-date", ["original_invocation", "stored_at"], "2099-01-01T00:00:00Z", "original_invocation.stored_at: expected")
    change("past-expiry-date", ["original_invocation", "observer_expires_at"], "1900-01-01T00:00:00Z", "original_invocation.observer_expires_at: expected")
    change("different-stored-date", ["original_invocation", "stored_at"], "2026-11-08T09:59:08Z", "original_invocation.stored_at: expected")
    change("different-snapshot-date", ["original_invocation", "last_snapshot_at"], "2026-11-08T10:15:00Z", "original_invocation.last_snapshot_at: expected")
    change("different-expiry-date", ["original_invocation", "observer_expires_at"], "2026-11-08T10:13:54Z", "original_invocation.observer_expires_at: expected")
    for field in ("stored_at", "observer_expires_at", "last_snapshot_at"):
        data = copy.deepcopy(baseline)
        del data["original_invocation"][field]
        mutations.append(("missing-" + field, data, "original_invocation: missing fields"))
    change("different-subject", ["original_invocation", "subject"], "other", "original_invocation.subject")
    change("different-stream", ["original_invocation", "stream"], "other", "original_invocation.stream")
    change("different-command", ["original_invocation", "command_id"], "other", "original_invocation.command_id")
    # Gate structure and blocked-state invariants.
    change("gates-null", ["gates"], None, "gates: expected exactly three")
    change("gate-null", ["gates", 0], None, "gates[0]: expected object")
    change("gate-pass", ["gates", 1, "status"], "PASS", "gates[1].status")
    change("gate-empty-cases", ["gates", 0, "cases"], [], "gates[0].cases")
    change("gate-string-cases", ["gates", 0, "cases"], "not a case list", "gates[0].cases")
    change("gate-empty-case", ["gates", 0, "cases"], [""], "gates[0].cases[0]")
    change("gate-empty-acceptance", ["gates", 0, "acceptance"], "", "gates[0].acceptance")
    change("gate-object-missing-invocation", ["gates", 0, "missing_invocation"], {}, "gates[0].missing_invocation")
    change("gate-terminal-fallback-prose", ["gates", 0, "unsupported_consequence"], "submit through terminal fallback", "unsupported_consequence: expected object")
    change("gate-terminal-fallback", ["gates", 0, "unsupported_consequence", "terminal_fallback"], "ALLOWED", "require no-submit/no-fallback")
    change("gate-submit", ["gates", 0, "unsupported_consequence", "native_submit"], "ALLOWED", "require no-submit/no-fallback")
    change("gate-cleared-unknown", ["gates", 1, "unsupported_consequence", "unknown_fence"], "CLEAR_ON_TIMEOUT", "persistent unknown fence")
    # Later manifest stays blocked.
    change("later-pass", ["later_validation_manifest", "status"], "PASS", "later_validation_manifest.status")
    change("later-native-certified", ["later_validation_manifest", "source_revision"], "native-certified", "source_revision: unavailable binding")
    change("later-argv", ["later_validation_manifest", "entrypoint_argv"], ["invented-send"], "entrypoint_argv: unavailable binding")
    change("later-observer", ["later_validation_manifest", "independent_observer"], "invented-observer", "independent_observer: unavailable binding")
    # Ownership and conditional next work (AC2/AC4).
    for field in ("contract_owner", "mutation_owner"):
        change("flume-" + field, ["owner_binding", field], "Flume", "owner_binding." + field)
    change("flume-mutation-coordination", ["owner_binding", "coordination"], "Flume owns native mutation", "owner_binding.coordination")
    change("empty-binding-blocker", ["owner_binding", "blocker"], "", "owner_binding.blocker")
    change("stale-pending-blocker", ["owner_binding", "blocker"],
           "Neither establishes a Fleet code home. The parent planning response remains pending.", "stale pending-response claim")
    change("adoption-claim-blocker", ["owner_binding", "blocker"],
           "Fleet contract adopted; nothing else missing.", "adoption claim")
    change("selected-source", ["owner_binding", "source_selection"], "SELECTED", "owner_binding.source_selection")
    change("invented-home", ["owner_binding", "implementation_home"], "/tmp/fleet", "implementation_home: unverified Fleet binding")
    change("invented-board", ["owner_binding", "enrolled_board"], "FLEET", "enrolled_board: unverified Fleet binding")
    change("next-ready", ["next_true_owner_brief", "state"], "READY", "next_true_owner_brief.state")
    change("next-immediate", ["next_true_owner_brief", "instruction"], "Assign immediately without source selection", "next_true_owner_brief.instruction")
    change("next-no-prerequisites", ["next_true_owner_brief", "required_prerequisites"], [], "required_prerequisites: expected four")
    change("next-reply-prereq-missing", ["next_true_owner_brief", "required_prerequisites", 0, "status"], "MISSING", "required_prerequisites: statuses changed")
    change("next-source-prereq-satisfied", ["next_true_owner_brief", "required_prerequisites", 1, "status"], "SATISFIED", "required_prerequisites: statuses changed")
    change("next-unrestricted-files", ["next_true_owner_brief", "allowed_files"], "Any Flume runtime file", "allowed_files: required boundaries changed")
    change("next-no-forbidden-files", ["next_true_owner_brief", "forbidden_files"], [], "forbidden_files: required boundaries changed")
    change("next-no-dependencies", ["next_true_owner_brief", "dependencies"], "", "dependencies: expected five")
    change("next-wrong-dependency-owner", ["next_true_owner_brief", "dependencies", 0, "owner"], "Flume", "dependencies: owner set changed")
    change("next-empty-dependency-contract", ["next_true_owner_brief", "dependencies", 0, "contract"], "", "dependency.contract")
    # Sources: shape/roles/digests; file verification itself is currency-only.
    change("missing-sources", ["sources"], [], "sources: exact nine reference set")
    change("sources-null", ["sources"], None, "sources: expected source")
    change("changed-source-digest", ["sources", 0, "sha256"], "0" * 64, "sources: digest changed")
    change("changed-source-role", ["sources", 0, "role"], "current_receipt", "sources: role changed")
    change("extra-source", ["sources"], baseline["sources"] + [{"path": "/tmp/x", "sha256": "0" * 64, "role": "x"}], "sources: unexpected path")

    def run(path):
        argv = [sys.executable, "-B", "-I", str(CHECKER), str(path)]
        result = subprocess.run(argv, capture_output=True, text=True, check=False)
        print(json.dumps({"argv": argv, "exit": result.returncode,
                          "stdout": result.stdout.strip(), "stderr": result.stderr.strip()}))
        return result

    head = subprocess.run(["git", "-C", str(ROOT), "rev-parse", "HEAD"],
                          capture_output=True, text=True, check=True).stdout.strip()
    print(json.dumps({"parent_head": head, "checker_sha256": hashlib.sha256(CHECKER.read_bytes()).hexdigest(),
                      "manifest_sha256": hashlib.sha256(original).hexdigest(), "kind": "structural real-artifact rejection probes; journal and parent docs not touched"}))
    result = run(MANIFEST)
    assert result.returncode == 0 and "VALID (structure-only)" in result.stdout, "real structural baseline failed"
    with tempfile.TemporaryDirectory(prefix="flume76-structural-mutations-") as directory:
        for label, data, diagnostic in mutations:
            path = Path(directory) / (label + ".json")
            path.write_text(json.dumps(data))
            result = run(path)
            assert result.returncode == 1 and diagnostic in result.stderr and "Traceback" not in result.stderr, label
    assert MANIFEST.read_bytes() == original, "authored artifact changed"
    print(f"PASS: structural baseline + {len(mutations)} rejected mutations; temp copies removed; authored artifact unchanged")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
