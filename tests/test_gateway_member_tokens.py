"""Offline regression fixtures. Stub token/vault processes do not prove live issuance."""
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys

import pytest
import yaml

ROOT = Path(__file__).resolve().parents[1]
HELPER = ROOT / "scripts/gateway-member-tokens.py"
spec = importlib.util.spec_from_file_location("member_helper_test", HELPER)
h = importlib.util.module_from_spec(spec)
spec.loader.exec_module(h)
REF = h.TOKENS_ITEM + "/hermes-test-person"


@pytest.mark.parametrize("text", [
    "# operator\n{}\n", "# operator\nsettings:\n  keep: yes\n",
    "secrets:\n  onepassword:\n    env:\n      OTHER: op://vault/item/field # keep\nlogging:\n  enabled: true\n",
    "secrets:\n    onepassword:\n        env:\n            OTHER: op://vault/item/field # keep four spaces\n",
    "secrets:\n    onepassword:\n        env: {} # four-space empty\n",
    "secrets:\n    onepassword:\n        other: yes # keep sibling\n",
])
def test_preserves_other_settings_and_comments(text):
    edited, state = h.candidate(text, REF)
    assert state == "added"
    assert h.mapping(edited)["secrets"]["onepassword"]["env"][h.ENV_NAME] == REF
    assert "# operator" not in text or "# operator" in edited
    assert "# keep" not in text or "# keep" in edited
    assert h.candidate(edited, REF) == (edited, "present")


@pytest.mark.parametrize("text", [
    "secrets:\n  onepassword:\n    env:\n      AUTOMATICAI_GATEWAY_KEY: op://other/item/key\n",
    "secrets:\n  onepassword:\n    env:\n      AUTOMATICAI_GATEWAY_KEY: op://other/item/key\n      AUTOMATICAI_GATEWAY_KEY: op://other/item/key\n",
])
def test_conflicts_refuse(text):
    with pytest.raises(h.ProvisionError):
        h.candidate(text, REF)


def test_hash_shorten():
    name = h.consumer_name("a-very-long-employee-identity-here")
    assert len(name) == 26 and name == h.consumer_name("a-very-long-employee-identity-here")


def test_bounded_cli_failures_and_repeat(tmp_path):
    fleet = tmp_path / "hermes"
    profile = fleet / "profiles/test-person"
    profile.mkdir(parents=True)
    (fleet / "config.yaml").write_text("secrets:\n  onepassword:\n    enabled: true\n")
    delta = profile / "config.delta.yaml"
    delta.write_text("# operator\nother: true\n")
    generated = profile / "config.yaml"
    generated.write_text("# generated\nother: true\n")
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    marker = tmp_path / "mint-count"
    gateway = bin_dir / "gateway-tokens.py"
    gateway.write_text("""#!/usr/bin/env python3
import os,sys
from pathlib import Path
count = Path(os.environ['COUNT_FILE'])
count.write_text(str(int(count.read_text() if count.exists() else '0') + 1))
assert sys.argv[1:4] == ['mint','hermes-test-person','--preset']
print('hermes-test-person: existing token; op://DeLoSecrets/yeurk5dpqkaarspvsn3cjtmkki/hermes-test-person')
""")
    op = bin_dir / "op"
    op.write_text("#!/usr/bin/env python3\nimport sys\nassert sys.argv[1]=='read'\nprint('SENTINEL_FROM_FAKE_VAULT_NOT_A_REAL_KEY_123456')\n")
    op.chmod(0o755)
    env = {**os.environ, "HERMES_FLEET_HOME": str(fleet), "FLUME_GATEWAY_TOKENS_BIN": str(gateway),
           "PATH": str(bin_dir) + os.pathsep + os.environ["PATH"], "COUNT_FILE": str(marker)}
    cmd = [sys.executable, str(HELPER), "--members", "test-person", "--group", "aai-personal", "--apply", "--render", "--json"]
    def run():
        proc = subprocess.run(cmd, env=env, capture_output=True, text=True, timeout=30)
        assert "SENTINEL_FROM_FAKE_VAULT" not in proc.stdout + proc.stderr
        return proc, json.loads(proc.stdout)
    # Conflict is preflight: no token or generated config changed.
    delta.write_text("# operator\nsecrets:\n  onepassword:\n    env:\n      AUTOMATICAI_GATEWAY_KEY: op://other/item/key\n")
    first_bytes = generated.read_bytes()
    proc, result = run()
    assert proc.returncode == 1 and result["members"][0]["error"] == "conflicting-reference"
    assert not marker.exists() and generated.read_bytes() == first_bytes
    delta.write_text("# operator\nother: true\n")
    proc, result = run()
    assert proc.returncode == 0, result
    assert result["members"][0]["token"] == "confirmed"
    assert result["members"][0]["delta"] == "added"
    assert result["members"][0]["render"] == "rendered"
    assert marker.read_text() == "1"
    first_bytes = delta.read_bytes(), generated.read_bytes()
    proc, result = run()
    assert proc.returncode == 0, result
    assert result["members"][0]["delta"] == "present"
    assert result["members"][0]["render"] == "unchanged"
    assert (delta.read_bytes(), generated.read_bytes()) == first_bytes
    assert marker.read_text() == "2"  # confirmed, not minted a second token
    op.write_text("#!/usr/bin/env python3\nimport sys\nprint('unavailable',file=sys.stderr)\nsys.exit(1)\n")
    proc, result = run()
    assert proc.returncode == 1 and result["members"][0]["error"] == "vault-readback-failed"
    assert (delta.read_bytes(), generated.read_bytes()) == first_bytes


def test_stale_scope_is_rescoped_in_place_then_confirmed(tmp_path):
    """The preset's route set moves under live tokens; mint refuses, `scope` repairs the same key, mint confirms."""
    fleet = tmp_path / "hermes"
    profile = fleet / "profiles/test-person"
    profile.mkdir(parents=True)
    (fleet / "config.yaml").write_text("secrets:\n  onepassword:\n    enabled: true\n")
    (profile / "config.delta.yaml").write_text("other: true\n")
    (profile / "config.yaml").write_text("other: true\n")
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    calls = tmp_path / "calls"
    gateway = bin_dir / "gateway-tokens.py"
    gateway.write_text("""#!/usr/bin/env python3
import os,sys
from pathlib import Path
log = Path(os.environ['CALLS']); state = Path(os.environ['SCOPED'])
with log.open('a') as f: f.write(sys.argv[1] + ' ' + ' '.join(a for a in sys.argv[2:] if a in ('--days',)) + '\\n')
if sys.argv[1] == 'scope':
    if os.environ.get('SCOPE_FAILS'): sys.exit(1)
    state.write_text('1'); print('scoped'); sys.exit(0)
if not state.exists():
    print('token operation failed: existing token differs, expired or untracked; use rotate', file=sys.stderr); sys.exit(1)
print('hermes-test-person: existing token; op://DeLoSecrets/yeurk5dpqkaarspvsn3cjtmkki/hermes-test-person')
""")
    (bin_dir / "op").write_text("#!/usr/bin/env python3\nprint('SENTINEL_FROM_FAKE_VAULT_NOT_A_REAL_KEY_123456')\n")
    (bin_dir / "op").chmod(0o755)
    env = {**os.environ, "HERMES_FLEET_HOME": str(fleet), "FLUME_GATEWAY_TOKENS_BIN": str(gateway),
           "PATH": str(bin_dir) + os.pathsep + os.environ["PATH"], "CALLS": str(calls), "SCOPED": str(tmp_path / "scoped")}
    cmd = [sys.executable, str(HELPER), "--members", "test-person", "--group", "aai-personal", "--apply", "--json"]
    failing = subprocess.run(cmd, env={**env, "SCOPE_FAILS": "1"}, capture_output=True, text=True, timeout=30)
    assert failing.returncode == 1 and json.loads(failing.stdout)["members"][0]["error"] == "gateway-mint-or-confirm-failed"
    calls.unlink()
    proc = subprocess.run(cmd, env=env, capture_output=True, text=True, timeout=30)
    assert proc.returncode == 0, proc.stdout + proc.stderr
    assert json.loads(proc.stdout)["members"][0]["token"] == "confirmed"
    assert calls.read_text().split("\n")[:3] == ["mint --days", "scope ", "mint --days"]
