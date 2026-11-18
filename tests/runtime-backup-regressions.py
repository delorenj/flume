#!/usr/bin/env python3
"""Disposable PJAN-14 recovery tests; requires the real forever-ago executable."""
import contextlib
import datetime as dt
import fcntl
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import shutil
import sqlite3
import subprocess
import sys
import tarfile
import tempfile
import unittest
from unittest.mock import patch

import yaml

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("runtime_backup", ROOT / "scripts/hermes-runtime-backup.py")
assert SPEC is not None and SPEC.loader is not None
backup = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(backup)
ENGINE_PATH = shutil.which("forever-ago")
if not ENGINE_PATH:
    raise RuntimeError("real forever-ago is required; tests must not be skipped")
ENGINE: str = ENGINE_PATH
SCRATCH = Path(os.environ["TMPDIR"])


class RecoveryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="p14-", dir=SCRATCH)
        self.addCleanup(self.temp.cleanup)
        self.home = Path(self.temp.name)
        self.home.chmod(0o700)
        self.fleet = self.home / "fleet"
        self.profile = self.fleet / "profiles/alice"
        self.runtime = self.home / "project/agents/hermes/pm/runtime"
        self.desk = self.home / "workforce/bob"
        self.portable = self.fleet / "profiles/bob"
        self.dest = self.home / "archives"
        for base in (self.runtime, self.portable):
            for name in ("sessions", "memories", "workspace"):
                (base / name).mkdir(parents=True)
            (base / "sessions/session.json").write_text('{"message":"fixture session"}')
            (base / "memories/MEMORY.md").write_text("fixture memory\n")
        self.profile.mkdir(parents=True)
        for name in ("sessions", "memories", "workspace"):
            (self.profile / name).symlink_to(self.runtime / name)
        (self.runtime / "SOUL.md").write_text("fixture identity\n")
        (self.profile / "SOUL.md").symlink_to(self.runtime / "SOUL.md")
        self.desk.mkdir(parents=True)
        (self.desk / "learned-skills").mkdir()
        (self.desk / "learned-skills/new.md").write_text("fixture learned skill")
        (self.portable / "learned-skills").symlink_to(self.desk / "learned-skills")
        (self.profile / "skills").symlink_to(self.home / "shared-skills")
        (self.profile / ".env").write_text("DO_NOT_ARCHIVE=fixture-only\n")
        (self.runtime / "op_cache.json").write_text("fixture credential cache")
        (self.runtime / "logs").mkdir()
        (self.runtime / "logs/test.log").write_text("excluded log")
        (self.runtime / ".git").mkdir()
        (self.runtime / ".git/config").write_text("excluded nested repo")
        self.db = sqlite3.connect(self.profile / "state.db")
        self.addCleanup(self.db.close)
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.execute("CREATE TABLE sessions (message TEXT)")
        self.db.execute("INSERT INTO sessions VALUES ('committed in WAL')")
        self.db.commit()
        self.db.execute("INSERT INTO sessions VALUES ('uncommitted')")
        (self.runtime / "state.db").symlink_to(self.profile / "state.db")
        (self.profile / "kanban.db").symlink_to(self.runtime / "kanban.db")
        self.registry = self.fleet / "agents-registry.yaml"
        self.rows = {"alice": {"profile_name": "alice", "role_dir": str(self.runtime.parent)},
                     "bob": {"profile_name": "bob", "employment": "portable-specialist", "desk_path": str(self.desk), "status": "retired"}}
        self.write_registry()
        self.args = backup.parser().parse_args(["--fleet-home", str(self.fleet), "--registry", str(self.registry),
            "--dest", str(self.dest), "--forever-ago", ENGINE, "run"])
        self.archive = self.dest / f"flume-runtime-{dt.date.today()}.tar.gz"

    def write_registry(self):
        self.registry.write_text(yaml.safe_dump({"agents": self.rows}))

    def cli(self, *args, success=True, env=None):
        result = subprocess.run([sys.executable, str(ROOT / "scripts/hermes-runtime-backup.py"),
            "--fleet-home", str(self.fleet), "--registry", str(self.registry), "--dest", str(self.dest),
            "--forever-ago", ENGINE, *map(str, args)], capture_output=True, text=True,
            env={**os.environ, **(env or {})}, timeout=60)
        self.assertEqual(result.returncode, 0 if success else 1, result.stdout + result.stderr)
        return json.loads(result.stdout)

    def test_every_registry_row_is_included_with_policy(self):
        info = backup.inventory(self.args)
        self.assertEqual(info["errors"], [])
        self.assertEqual([e["employee"] for e in info["employees"]], ["alice", "bob"])
        self.assertEqual(info["employees"][1]["sources"][1]["kind"], "desk")
        self.assertEqual(info["policy"]["retain"], 7)
        self.assertIn("--once", info["policy"]["engine"])
        # A new registered employee is included without any scheduling mutation.
        self.rows["carol"] = {"profile_name": "carol", "role_dir": str(self.runtime.parent)}
        self.write_registry()
        info = backup.inventory(self.args)
        self.assertEqual(len(info["employees"]), 3)
        self.assertTrue(any("carol" in error for error in info["errors"]))

    def test_real_forever_ago_wal_restore_links_and_private_modes(self):
        self.assertTrue(Path(str(self.profile / "state.db") + "-wal").exists())
        result = self.cli("run")
        self.assertEqual(result["employees"], ["alice", "bob"])
        self.assertEqual(result["sha256"], backup.digest(self.archive))
        self.assertIn("--once", result["engine_argv"])
        drill = self.home / "drill"
        self.cli("restore", self.archive, drill)
        restored = drill / "employees/alice/profile"
        self.assertEqual((restored / "sessions/session.json").read_text(), '{"message":"fixture session"}')
        self.assertEqual((restored / "memories/MEMORY.md").read_text(), "fixture memory\n")
        self.assertTrue((restored / "sessions").is_symlink())
        self.assertTrue((drill / "employees/alice/runtime/state.db").is_symlink())
        self.assertEqual((restored / "state.db").resolve().parent, restored)
        self.assertEqual((drill / "employees/bob/profile/learned-skills/new.md").read_text(), "fixture learned skill")
        with contextlib.closing(sqlite3.connect(restored / "state.db")) as conn:
            self.assertEqual(conn.execute("PRAGMA integrity_check").fetchone(), ("ok",))
            self.assertEqual(conn.execute("SELECT message FROM sessions").fetchall(), [("committed in WAL",)])
        self.assertTrue((restored / "kanban.db").is_symlink())
        self.assertFalse((restored / "kanban.db").exists())
        manifest = json.loads((drill / "manifest.json").read_text())
        self.assertTrue(any("skills" in dep["path"] for dep in manifest["dependencies"]))
        for excluded in (".env", "skills"):
            self.assertFalse((restored / excluded).exists())
        with tarfile.open(self.archive) as tar:
            self.assertFalse(any(name.endswith(("-wal", "-shm", "op_cache.json", "test.log", ".git/config")) for name in tar.getnames()))
        self.assertEqual(self.dest.stat().st_mode & 0o777, 0o700)
        for path in (self.archive, Path(str(self.archive) + ".sha256"), self.dest / "last-success.json"):
            self.assertEqual(path.stat().st_mode & 0o077, 0)
        self.cli("verify", self.archive)
        self.cli("restore", self.archive, drill, success=False)

    def test_missing_source_preserves_last_good_and_reports_employee(self):
        self.cli("run")
        before = self.archive.read_bytes(), (self.dest / "last-success.json").read_bytes()
        self.rows["missing"] = {"profile_name": "missing", "role_dir": str(self.home / "missing-role")}
        self.write_registry()
        failure = self.cli("run", success=False)
        self.assertIn("missing:", failure["error"])
        self.assertEqual(before, (self.archive.read_bytes(), (self.dest / "last-success.json").read_bytes()))
        self.assertEqual(json.loads((self.dest / "last-run.json").read_text())["status"], "fail")

    def test_unwritable_destination_does_not_prune_last_good(self):
        self.cli("run")
        before = self.archive.read_bytes()
        self.dest.chmod(0o500)
        try:
            self.cli("run", success=False)
        finally:
            self.dest.chmod(0o700)
        self.assertEqual(before, self.archive.read_bytes())

    def test_retention_real_engine_keeps_newly_verified_snapshot(self):
        backup.private_dir(self.dest)
        # Valid disposable dated archives, not fabricated engine responses.
        for days in range(1, 11):
            day = dt.date.today() - dt.timedelta(days=days)
            path = self.dest / f"flume-runtime-{day}.tar.gz"
            with tarfile.open(path, "w:gz") as tar:
                data = b"disposable older snapshot"
                member = tarfile.TarInfo("fixture.txt")
                member.size = len(data)
                tar.addfile(member, io.BytesIO(data))
            Path(str(path) + ".sha256").write_text(f"{backup.digest(path)}  {path.name}\n")
        self.cli("run")
        remaining = list(self.dest.glob("flume-runtime-*.tar.gz"))
        self.assertEqual(len(remaining), 7)
        self.assertIn(self.archive, remaining)
        self.cli("verify", self.archive)

    def test_same_day_changed_state_is_not_reported_fresh(self):
        self.cli("run")
        good = (self.dest / "last-success.json").read_bytes()
        replay = self.cli("run")
        self.assertTrue(replay["reused_daily_snapshot"])
        # Compare against the replay receipt, not the original attempt's timestamp.
        good = (self.dest / "last-success.json").read_bytes()
        (self.runtime / "memories/MEMORY.md").write_text("changed state")
        result = self.cli("run", success=False)
        self.assertIn("same-day snapshot differs", result["error"])
        self.assertEqual(good, (self.dest / "last-success.json").read_bytes())

    def test_bad_database_or_unknown_owned_link_fails_before_engine(self):
        (self.runtime / "broken.db").write_text("not sqlite")
        self.cli("run", success=False)
        self.assertFalse(self.archive.exists())
        (self.runtime / "broken.db").unlink()
        (self.profile / "sessions").unlink()
        external = self.home / "foreign-sessions"
        external.mkdir()
        (self.profile / "sessions").symlink_to(external)
        result = self.cli("run", success=False)
        self.assertIn("outside inventoried roots", result["error"])
        self.assertFalse(self.archive.exists())

    def test_registry_rejects_empty_duplicate_unsafe_and_shared_profiles(self):
        for content in ("agents: {}", "agents: []", "agents:\n  alice: {}\n  alice: {}", "agents:\n  ../escape: {}"):
            self.registry.write_text(content)
            self.cli("inventory", success=False)
        self.rows["bob"]["profile_name"] = "alice"
        self.write_registry()
        result = self.cli("inventory", success=False)
        self.assertIn("duplicate profile_name", " ".join(result["errors"]))

    def test_overlap_and_busy_lock_and_engine_failure(self):
        original = self.args.dest
        self.args.dest = self.runtime / "backups"
        with self.assertRaisesRegex(backup.BackupError, "overlaps"):
            backup.run(self.args)
        self.args.dest = original
        backup.private_dir(self.dest)
        with (self.dest / ".flume-runtime.lock").open("w") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            result = self.cli("run", success=False)
            self.assertIn("another runtime backup", result["error"])
        self.cli("run")
        good = self.archive.read_bytes()
        with patch.object(backup, "engine", side_effect=backup.BackupError("fixture engine failure")):
            with self.assertRaisesRegex(backup.BackupError, "engine failure"):
                backup.run(self.args)
        self.assertEqual(good, self.archive.read_bytes())

    def test_corruption_traversal_and_escaping_links_are_refused(self):
        self.cli("run")
        archive = self.home / "malicious.tar.gz"
        for name, link in (("../escaped", None), ("/absolute", None), ("link", "../../escaped")):
            with tarfile.open(archive, "w:gz") as tar:
                member = tarfile.TarInfo(name)
                if link:
                    member.type = tarfile.SYMTYPE
                    member.linkname = link
                    tar.addfile(member)
                else:
                    member.size = 1
                    tar.addfile(member, io.BytesIO(b"x"))
            Path(str(archive) + ".sha256").write_text(backup.digest(archive))
            self.cli("restore", archive, self.home / "unsafe-drill", success=False)
            self.assertFalse((self.home / "unsafe-drill").exists())
        with self.archive.open("ab") as stream:
            stream.write(b"corrupt")
        self.cli("verify", self.archive, success=False)

    def test_real_engine_failure_preserves_previous_good_snapshot(self):
        self.cli("run")
        good = self.archive.read_bytes(), (self.dest / "last-success.json").read_bytes()
        self.args.forever_ago = "/usr/bin/false"
        with self.assertRaisesRegex(backup.BackupError, "exit 1"):
            backup.run(self.args)
        self.assertEqual(good, (self.archive.read_bytes(), (self.dest / "last-success.json").read_bytes()))

    def test_nested_physical_root_is_archived_once_and_linked(self):
        # Legacy employee whose role_dir is its own profile (the dumply layout).
        nested = self.profile / "runtime"
        nested.mkdir()
        (nested / "owned.txt").write_text("nested owned state")
        self.rows["alice"]["role_dir"] = str(self.profile)
        self.write_registry()
        # Point profile-owned links into the newly registered nested root.
        for name in ("sessions", "memories", "workspace"):
            shutil.copytree(self.runtime / name, nested / name)
            (self.profile / name).unlink()
            (self.profile / name).symlink_to(nested / name)
        (self.profile / "SOUL.md").unlink()
        (self.profile / "SOUL.md").write_text("identity")
        (self.profile / "kanban.db").unlink()
        self.cli("run")
        drill = self.home / "nested-drill"
        self.cli("restore", self.archive, drill)
        restored = drill / "employees/alice"
        self.assertTrue((restored / "profile/runtime").is_symlink())
        self.assertEqual((restored / "profile/runtime/owned.txt").read_text(), "nested owned state")
        manifest = json.loads((drill / "manifest.json").read_text())
        self.assertNotIn("employees/alice/profile/runtime/owned.txt", manifest["files"])

    def test_restore_works_without_live_registry(self):
        self.cli("run")
        self.registry.unlink()
        drill = self.home / "offline-drill"
        self.cli("restore", self.archive, drill)
        self.assertEqual((drill / "employees/alice/profile/memories/MEMORY.md").read_text(), "fixture memory\n")

    def test_excluded_link_target_is_not_covered_or_restored(self):
        (self.profile / "secret-alias").symlink_to(self.profile / ".env")
        self.cli("run")
        drill = self.home / "excluded-drill"
        self.cli("restore", self.archive, drill)
        self.assertFalse((drill / "employees/alice/profile/secret-alias").is_symlink())
        (self.profile / "sessions").unlink()
        (self.profile / "cache").mkdir()
        (self.profile / "sessions").symlink_to(self.profile / "cache")
        failure = self.cli("run", success=False)
        self.assertIn("excluded subtree", failure["error"])

    def test_verification_failure_never_reaches_retention(self):
        self.cli("run")
        last_good = (self.dest / "last-success.json").read_bytes()
        with patch.object(backup, "extract_verified", side_effect=backup.BackupError("fixture recovery failure")):
            with patch.object(backup, "engine") as engine:
                with self.assertRaisesRegex(backup.BackupError, "recovery failure"):
                    backup.run(self.args)
                engine.assert_not_called()
        self.assertEqual(last_good, (self.dest / "last-success.json").read_bytes())

    def test_candybar_result_contains_no_runtime_payload(self):
        result_path = self.home / "result.json"
        self.cli("run", env={"CANDYBAR_RESULT_FILE": str(result_path)})
        result = json.loads(result_path.read_text())
        self.assertEqual(result["status"], "success")
        self.assertEqual(result["metrics"], {"token_spend": 0, "cost_usd": 0})
        self.assertNotIn("fixture session", result_path.read_text())
    def test_directory_swap_does_not_follow_outside_tree(self):
        branch = self.runtime / "branch"
        branch.mkdir()
        (branch / "owned.txt").write_text("owned")
        outside = self.home / "outside-tree"
        outside.mkdir()
        (outside / "outside.txt").write_text("OUTSIDE-FIXTURE")
        original = os.listdir
        swapped = False
        def swap_listdir(fd):
            nonlocal swapped
            if not swapped and same_branch(fd):
                swapped = True
                branch.rename(self.home / "moved-branch")
                branch.symlink_to(outside, target_is_directory=True)
            return original(fd)
        def same_branch(fd):
            return os.fstat(fd).st_ino == branch.stat().st_ino
        with patch.object(backup.os, "listdir", side_effect=swap_listdir):
            with self.assertRaises((backup.BackupError, OSError)):
                backup.run(self.args)
        self.assertTrue(swapped)
        self.assertFalse(self.archive.exists())
        self.assertFalse((self.dest / "last-success.json").exists())

    def test_sqlite_reopen_swap_fails_without_archiving_outside_database(self):
        outside = self.home / "outside.db"
        with sqlite3.connect(outside) as conn:
            conn.execute("CREATE TABLE secret (value TEXT)")
            conn.execute("INSERT INTO secret VALUES ('OUTSIDE-FIXTURE')")
        original = sqlite3.connect
        swapped = False
        def swap_connect(database, *args, **kwargs):
            nonlocal swapped
            if str(database).startswith("file:/proc/self/fd/") and not swapped:
                swapped = True
                self.db.rollback()
                self.db.close()
                (self.profile / "state.db").rename(self.home / "saved-owned.db")
                (self.profile / "state.db").symlink_to(outside)
            return original(database, *args, **kwargs)
        with patch.object(backup.sqlite3, "connect", side_effect=swap_connect):
            with self.assertRaises((backup.BackupError, sqlite3.Error, OSError)):
                backup.run(self.args)
        self.assertTrue(swapped)
        self.assertFalse(self.archive.exists())

    def test_chained_links_and_cycles_are_rejected_before_publication(self):
        self.cli("run")
        for links in ({"employees/alice/runtime/bridge": "../../..",
                       "employees/alice/runtime/probe": "bridge/../outside-marker"},
                      {"employees/alice/runtime/a": "b", "employees/alice/runtime/b": "a"}):
            crafted = self.home / "crafted.tar.gz"
            with tarfile.open(self.archive) as old:
                stream = old.extractfile("snapshot/manifest.json")
                assert stream is not None
                manifest = json.load(stream)
                manifest["links"].update(links)
                with tarfile.open(crafted, "w:gz") as new:
                    for member in old.getmembers():
                        if member.name == "snapshot/manifest.json":
                            data = json.dumps(manifest).encode()
                            member.size = len(data)
                            new.addfile(member, io.BytesIO(data))
                        else:
                            new.addfile(member, old.extractfile(member) if member.isfile() else None)
                    for name, target in links.items():
                        member = tarfile.TarInfo("snapshot/" + name)
                        member.type = tarfile.SYMTYPE
                        member.linkname = target
                        new.addfile(member)
            Path(str(crafted) + ".sha256").write_text(backup.digest(crafted))
            drill = self.home / "crafted-drill"
            result = self.cli("restore", crafted, drill, success=False)
            self.assertIn("link", result["error"])
            self.assertFalse(drill.exists())
            self.cli("verify", crafted, success=False)

    def test_owner_execute_mode_restores_and_group_world_never_gain_access(self):
        hook = self.runtime / "hooks/run.sh"
        hook.parent.mkdir()
        hook.write_text("#!/bin/sh\nexit 0\n")
        hook.chmod(0o751)
        self.cli("run")
        drill = self.home / "exec-drill"
        self.cli("restore", self.archive, drill)
        restored = drill / "employees/alice/runtime/hooks/run.sh"
        self.assertEqual(restored.stat().st_mode & 0o777, 0o700)
        subprocess.run([str(restored)], check=True, timeout=5)
        manifest = json.loads((drill / "manifest.json").read_text())
        self.assertEqual(manifest["files"]["employees/alice/runtime/hooks/run.sh"]["mode"], 0o700)

    def test_restore_overlap_fails_before_parent_or_extraction(self):
        self.cli("run")
        for unsafe in (self.runtime / "unintended-parent/drill", self.profile / "nested/drill",
                       self.home / "project/agents/hermes/pm", self.home / "project"):
            result = self.cli("restore", self.archive, unsafe, success=False)
            self.assertTrue("overlaps an owned source" in result["error"] or
                            "outside the active fleet home" in result["error"] or
                            "restore destination must not exist" in result["error"], result)
            if "must not exist" not in result["error"]:
                self.assertFalse(unsafe.exists())
        self.assertFalse((self.runtime / "unintended-parent").exists())
        self.assertFalse((self.profile / "nested").exists())
        self.assertFalse(any(self.runtime.glob(".restore-*")))

    def test_active_missing_state_store_is_named_failure_not_lazy_success(self):
        self.db.rollback()
        self.db.close()
        (self.profile / "state.db").unlink()
        result = self.cli("run", success=False)
        self.assertIn("alice:", result["error"])
        self.assertIn("state.db", result["error"])
        self.assertFalse(self.archive.exists())


if __name__ == "__main__":
    print(subprocess.check_output([ENGINE, "--version"], text=True).strip(), flush=True)
    unittest.main(verbosity=2)
