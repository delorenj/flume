"""Exercise the pinned rendered Telegram provisioner with synthetic hire inputs."""

from __future__ import annotations

import os
import sys
from pathlib import Path
from tempfile import TemporaryDirectory

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "templates" / "hermes-agent" / "tests"))
from test_telegram_provisioning import BOT_TOKEN, _fake_bin, _make_role, _run  # noqa: E402


with TemporaryDirectory(prefix="flume-40-", dir=os.environ["TMPDIR"]) as directory:
    scratch = Path(directory)
    role, runtime, registry = _make_role(scratch)
    home = scratch / "home"
    home.mkdir()
    config = scratch / "operator.toml"
    config.write_text('[telegram]\noperator_user_ids = ["900001"]\n', encoding="utf-8")
    result = _run(
        role,
        registry,
        home,
        _fake_bin(scratch),
        {
            "TELEGRAM_BOT_TOKEN": BOT_TOKEN,
            "TELEGRAM_ALLOWED_USERS": "987654321",
            "HERMES_TEMPLATE_CONFIG": str(config),
            "PROFILE_RENDERER": str(ROOT / "templates" / "hermes-agent" / "scripts" / "hermes-profile-config.py"),
        },
    )
    assert result.returncode == 0, result.stdout + result.stderr
    effective = (runtime / ".env").read_text(encoding="utf-8")
    assert effective == 'TELEGRAM_ALLOWED_USERS="987654321,900001"\n', effective
    assert "op://DeLoSecrets/Telegram/id" not in effective
    assert "424242" not in effective  # fake getMe bot ID is not a chat allow-list member
    print("FLUME-40 rendered 30-telegram.sh: synthetic operator ID provisioned, bot ID/reference absent")
