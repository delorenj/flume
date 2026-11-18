#!/usr/bin/env python3
"""Stage employee-owned state for forever-ago; Candybar owns the clock."""
from __future__ import annotations

import argparse
import contextlib
import datetime as dt
import fcntl
import fnmatch
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import sqlite3
import stat
import subprocess
import sys
import tarfile
import tempfile
import time

import yaml

PREFIX = "flume-runtime"
RETAIN = 7
# Config may itself contain secrets. These exclusions are not a content scrubber.
EXCLUDES = (".git", ".env", ".env.*", "auth.json", "credentials*", "op_cache.json",
            "*.pem", "*.key", "cache", "logs", "audio_cache", "image_cache", "lsp",
            "node_modules", ".venv", "__pycache__", "*.pyc", "*-wal", "*-shm",
            "*-journal", "*.lock", "checkpoints", "backups", ".curator_backups")
REQUIRED_LINKS = {"sessions", "memories", "workspace", "plans", "hooks", "pairing",
                  "cron", "SOUL.md", "state.db", "kanban.db", "learned-skills"}
# A post's profile-homed state.db is the Hermes session authority. kanban.db
# is created on first use; only its canonical profile -> runtime link may dangle.


class BackupError(Exception):
    pass


class UniqueLoader(yaml.SafeLoader):
    pass


def unique_mapping(loader, node, deep=False):
    result = {}
    for key_node, value_node in node.value:
        key = loader.construct_object(key_node, deep=deep)
        if not isinstance(key, str) or key in result:
            raise BackupError("registry contains a duplicate or non-string key")
        result[key] = loader.construct_object(value_node, deep=deep)
    return result


UniqueLoader.add_constructor(yaml.resolver.BaseResolver.DEFAULT_MAPPING_TAG, unique_mapping)


def inside(path: Path, parent: Path) -> bool:
    return path == parent or parent in path.parents


def absolute(value) -> Path:
    return Path(os.path.abspath(Path(value).expanduser()))


def excluded(relative: Path) -> bool:
    return any(fnmatch.fnmatchcase(part.lower(), pat.lower())
               for part in relative.parts for pat in EXCLUDES)


def digest(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def atomic_json(path: Path, value):
    fd, name = tempfile.mkstemp(prefix=".receipt-", dir=path.parent)
    try:
        with os.fdopen(fd, "w") as stream:
            json.dump(value, stream, indent=2, sort_keys=True)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(name, path)
    finally:
        Path(name).unlink(missing_ok=True)


def private_dir(path: Path):
    # Never chmod arbitrary existing trees or follow destination aliases.
    for part in [path, *path.parents]:
        if part.is_symlink():
            raise BackupError(f"private directory has a symlink component: {part}")
    path.mkdir(mode=0o700, parents=True, exist_ok=True)
    mode = path.stat()
    if (not stat.S_ISDIR(mode.st_mode) or mode.st_uid != os.getuid()
            or mode.st_mode & 0o077 or mode.st_mode & 0o700 != 0o700):
        raise BackupError(f"directory must be owned by this user and mode 0700: {path}")


def inventory(args):
    try:
        doc = yaml.load(args.registry.read_text(), Loader=UniqueLoader)
    except (OSError, yaml.YAMLError) as exc:
        raise BackupError("registry unavailable or malformed") from exc
    rows = doc.get("agents") if isinstance(doc, dict) else None
    if not isinstance(rows, dict) or not rows:
        raise BackupError("registry must contain a nonempty agents mapping")
    entries, errors, profiles = [], [], set()
    for ident, row in sorted(rows.items()):
        entry = {"employee": ident, "sources": [], "errors": []}
        entries.append(entry)
        if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]*", ident) or not isinstance(row, dict):
            entry["errors"].append("invalid employee identifier/record")
            continue
        profile = row.get("profile_name")
        if not isinstance(profile, str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]*", profile):
            entry["errors"].append("missing or unsafe profile_name")
            continue
        if profile in profiles:
            entry["errors"].append(f"duplicate profile_name: {profile}")
        profiles.add(profile)
        employment = row.get("employment") or "post"
        entry.update(profile_name=profile, employment=employment)
        sources = [("profile", args.fleet_home / "profiles" / profile)]
        key, label = ("desk_path", "desk") if employment == "portable-specialist" else ("role_dir", "runtime")
        if employment not in ("post", "portable-specialist"):
            entry["errors"].append(f"unsupported employment: {employment}")
        value = row.get(key)
        if not isinstance(value, str) or not value.strip() or not Path(value).expanduser().is_absolute():
            entry["errors"].append(f"missing or nonabsolute {key}")
        else:
            sources.append((label, absolute(value) / "runtime" if label == "runtime" else absolute(value)))
        for label, path in sources:
            source = {"kind": label, "path": str(path), "physical": str(path.resolve()),
                      "archive_path": f"employees/{ident}/{label}"}
            entry["sources"].append(source)
            if not path.is_dir():
                entry["errors"].append(f"unavailable {label}: {path}")
        for name in ("sessions", "memories"):
            if not (sources[0][1] / name).is_dir():
                entry["errors"].append(f"unavailable owned profile state: {name}")
        # Hermes's session authority is a real profile-homed store, not a
        # lazily-created runtime link. Every active post must have one.
        if employment == "post" and row.get("status") != "retired":
            store = sources[0][1] / "state.db"
            try:
                mode = store.lstat().st_mode
            except FileNotFoundError:
                mode = 0
            if not stat.S_ISREG(mode):
                entry["errors"].append(f"unavailable owned profile state: {store}")
    # Different employees sharing physical state is a topology fault, not duplicate coverage.
    owners = {}
    for entry in entries:
        for source in entry["sources"]:
            physical = source["physical"]
            if physical in owners and owners[physical] != entry["employee"]:
                entry["errors"].append(f"source shared with {owners[physical]}: {physical}")
            owners[physical] = entry["employee"]
    roots = [(e, Path(s["physical"])) for e in entries for s in e["sources"]]
    for index, (entry, physical) in enumerate(roots):
        for other, candidate in roots[:index]:
            if (entry["employee"] != other["employee"]
                    and (inside(physical, candidate) or inside(candidate, physical))):
                entry["errors"].append(f"source overlaps employee {other['employee']}: {physical}")
    for entry in entries:
        errors.extend(f"{entry['employee']}: {error}" for error in entry["errors"])
    return {"schema_version": 1, "registry": str(args.registry), "employees": entries,
            "policy": {"engine": "forever-ago --once", "destination": str(args.dest),
                       "prefix": PREFIX, "retain": RETAIN, "excludes": list(EXCLUDES)},
            "errors": errors, "status": "fail" if errors else "success"}


def validate_dest(dest, info):
    roots = [Path(s["physical"]) for e in info["employees"] for s in e["sources"]]
    for root in roots:
        if inside(dest.resolve(), root) or inside(root, dest.resolve()):
            raise BackupError(f"destination overlaps an owned source: {root}")
    # Also reject a destination anywhere in a Git worktree (including this repo).
    for parent in [dest, *dest.parents]:
        if (parent / ".git").exists():
            raise BackupError("destination cannot be inside a Git checkout")


DIR_FLAGS = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC


def same_inode(left, right):
    return (left.st_dev, left.st_ino) == (right.st_dev, right.st_ino)


def checked_dir(path: Path):
    """Pin every directory component; a replaced ancestor must fail, not be followed."""
    parts = path.absolute().parts
    fd = os.open(parts[0], DIR_FLAGS)
    try:
        for part in parts[1:]:
            child = os.open(part, DIR_FLAGS, dir_fd=fd)
            os.close(fd)
            fd = child
        if not same_inode(os.fstat(fd), path.stat()):
            raise BackupError(f"owned directory changed during staging: {path}")
        return fd
    except BaseException:
        os.close(fd)
        raise


def check_entry(parent_fd, name, expected, display):
    if not same_inode(os.stat(name, dir_fd=parent_fd, follow_symlinks=False), expected):
        raise BackupError(f"owned state changed during staging: {display}")


def snapshot_database(source: Path, target: Path, pinned_fd: int, parent_fd: int):
    deadline = time.monotonic() + 30
    identity = os.fstat(pinned_fd)
    def check_source():
        check_entry(parent_fd, source.name, identity, source)
        # SQLite canonicalizes /proc/self/fd paths for WAL and journal access.
        # Refuse any path/parent replacement before and after the connection.
        parent = checked_dir(source.parent)
        try:
            if not same_inode(os.fstat(parent), os.fstat(parent_fd)):
                raise BackupError(f"SQLite parent changed during staging: {source}")
        finally:
            os.close(parent)
        if not same_inode(source.stat(), identity):
            raise BackupError(f"SQLite source changed during staging: {source}")
    def progress(status, remaining, total):
        if time.monotonic() > deadline:
            raise BackupError(f"SQLite snapshot timed out: {source.name}")
        check_source()
    check_source()
    with contextlib.closing(sqlite3.connect(f"file:/proc/self/fd/{pinned_fd}?mode=ro", uri=True, timeout=5)) as src:
        db_path = Path(src.execute("PRAGMA database_list").fetchone()[2])
        if db_path != source or not same_inode(db_path.stat(), identity):
            raise BackupError(f"SQLite source changed during connection: {source}")
        check_source()
        with contextlib.closing(sqlite3.connect(target)) as dst:
            src.backup(dst, pages=256, progress=progress, sleep=0.05)
            check_source()
            if dst.execute("PRAGMA integrity_check").fetchall() != [("ok",)]:
                raise BackupError(f"SQLite integrity failed: {source.name}")
    target.chmod(0o600)


def copy_file(source: Path, target: Path, parent_fd: int, metadata):
    fd = os.open(source.name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent_fd)
    with os.fdopen(fd, "rb") as stream:
        before = os.fstat(stream.fileno())
        if not stat.S_ISREG(before.st_mode) or not same_inode(metadata, before):
            raise BackupError(f"unsupported or changed state file: {source}")
        header = stream.read(16)
        is_db = header == b"SQLite format 3\x00" or source.suffix.lower() in {".db", ".sqlite", ".sqlite3"}
        if is_db:
            snapshot_database(source, target, stream.fileno(), parent_fd)
            return "sqlite"
        stream.seek(0)
        with target.open("xb") as out:
            shutil.copyfileobj(stream, out)
        after = os.fstat(stream.fileno())
        check_entry(parent_fd, source.name, before, source)
        if (before.st_size, before.st_mtime_ns, before.st_ctime_ns) != (after.st_size, after.st_mtime_ns, after.st_ctime_ns):
            raise BackupError(f"state file changed while staging; retry: {source}")
    target.chmod(before.st_mode & 0o700)
    return "file"


def stage(info, directory):
    roots = [(Path(s["physical"]), Path(s["archive_path"]))
             for e in info["employees"] for s in e["sources"]]
    roots.sort(key=lambda pair: len(pair[0].parts), reverse=True)
    links, files, directories, dependencies = [], {}, [], []
    def map_target(path):
        for physical, archived in roots:
            if inside(path, physical):
                relative = path.relative_to(physical)
                if not excluded(relative):
                    return archived / relative
        return None
    def walk(source, target, source_root):
        parent_fd = checked_dir(source)
        try:
            target.mkdir(mode=0o700, parents=True, exist_ok=True)
            directories.append(str(target.relative_to(directory)))
            for name in sorted(os.listdir(parent_fd)):
                child = source / name
                relative = child.relative_to(source_root)
                if excluded(relative):
                    continue
                dest = target / name
                metadata = os.stat(name, dir_fd=parent_fd, follow_symlinks=False)
                if stat.S_ISLNK(metadata.st_mode):
                    raw = os.readlink(name, dir_fd=parent_fd)
                    check_entry(parent_fd, name, metadata, child)
                    resolved = (child.parent / raw).resolve()
                    mapped = map_target(resolved)
                    required = name in REQUIRED_LINKS
                    if any(inside(resolved, physical) and excluded(resolved.relative_to(physical))
                           for physical, _ in roots):
                        if required:
                            raise BackupError(f"owned link points into an excluded subtree: {child}")
                        dependencies.append({"path": str(dest.relative_to(directory)),
                                             "action": "excluded target; reconstruct through its owner"})
                        continue
                    if mapped is None:
                        if required:
                            raise BackupError(f"owned link target is outside inventoried roots: {child}")
                        dependencies.append({"path": str(dest.relative_to(directory)), "target": raw,
                                             "action": "reconstruct via Flume/Skillex; not restored automatically"})
                    else:
                        # state.db is profile-homed and mandatory for a running post.
                        # Only the documented profile -> runtime kanban link is lazy.
                        lazy_kanban = (name == "kanban.db" and relative == Path("kanban.db")
                                       and target.name == "profile" and mapped.name == "kanban.db"
                                       and "runtime" in mapped.parts)
                        if not child.exists() and not lazy_kanban:
                            raise BackupError(f"unavailable owned link: {child}")
                        links.append((dest, directory / mapped))
                elif stat.S_ISDIR(metadata.st_mode):
                    nested = next((a for p, a in roots if p == child and p != source_root), None)
                    if nested is not None:
                        check_entry(parent_fd, name, metadata, child)
                        links.append((dest, directory / nested))
                    else:
                        walk(child, dest, source_root)
                        check_entry(parent_fd, name, metadata, child)
                elif stat.S_ISREG(metadata.st_mode):
                    kind = copy_file(child, dest, parent_fd, metadata)
                    files[str(dest.relative_to(directory))] = {"sha256": digest(dest), "kind": kind,
                                                               "mode": dest.stat().st_mode & 0o700}
                elif stat.S_ISSOCK(metadata.st_mode):
                    dependencies.append({"path": str(dest.relative_to(directory)), "action": "ephemeral socket; recreate on launch"})
                else:
                    raise BackupError(f"unsupported owned state type: {child}")
            # A swapped directory may remain readable through its fd; never publish it.
            if not same_inode(os.fstat(parent_fd), source.stat()):
                raise BackupError(f"owned directory changed during staging: {source}")
        finally:
            os.close(parent_fd)
    for physical, archived in roots:
        walk(physical, directory / archived, physical)
    link_map = {}
    for dest, target in links:
        relative = os.path.relpath(target, dest.parent)
        dest.symlink_to(relative)
        link_map[str(dest.relative_to(directory))] = relative
    all_paths = set(files) | set(link_map) | set(directories)
    directories = sorted(set(directories) | {str(parent) for name in all_paths
        for parent in Path(name).parents if str(parent) != "."})
    manifest = {"schema_version": 1, "inventory": info, "files": files,
                "directories": directories, "links": link_map,
                "dependencies": dependencies}
    atomic_json(directory / "manifest.json", manifest)
    return manifest


def safe_name(name):
    path = PurePosixPath(name)
    if path.is_absolute() or ".." in path.parts:
        raise BackupError("archive contains an unsafe path")
    return str(path)


def validate_link_graph(links):
    """Resolve link chains lexically against the complete manifest, never the host FS."""
    for name, target in links.items():
        if not isinstance(target, str) or not target or target.startswith("/"):
            raise BackupError("archive contains an absolute or empty link")
        parts = list(PurePosixPath(name).parent.parts)
        pending = target.split("/")
        visited = {name}
        while pending:
            part = pending.pop(0)
            if part in ("", "."):
                continue
            if part == "..":
                if not parts:
                    raise BackupError("archive link escapes restore directory")
                parts.pop()
                continue
            parts.append(part)
            candidate = "/".join(parts)
            if candidate in links:
                if candidate in visited:
                    raise BackupError("archive contains a link cycle")
                visited.add(candidate)
                parts.pop()
                pending = links[candidate].split("/") + pending


def extract_verified(archive: Path, destination: Path):
    sha_file = Path(str(archive) + ".sha256")
    try:
        expected = sha_file.read_text().split()[0]
    except (OSError, IndexError) as exc:
        raise BackupError("archive checksum is missing or unreadable") from exc
    if not re.fullmatch(r"[a-f0-9]{64}", expected) or digest(archive) != expected:
        raise BackupError("archive SHA-256 mismatch")
    with tarfile.open(archive, "r:gz") as tar:
        members = {}
        for member in tar.getmembers():
            raw_name = safe_name(member.name)
            if raw_name == "snapshot":
                if not member.isdir():
                    raise BackupError("archive root is not a directory")
                continue
            if not raw_name.startswith("snapshot/"):
                raise BackupError("archive payload is outside the snapshot root")
            name = safe_name(raw_name[len("snapshot/"):])
            if name == ".":
                if not member.isdir():
                    raise BackupError("archive root is not a directory")
                continue
            if name in members or not (member.isdir() or member.isfile() or member.issym()):
                raise BackupError("archive contains duplicate paths or unsupported types")
            members[name] = member
        manifest_member = members.get("manifest.json")
        if not manifest_member or not manifest_member.isfile() or manifest_member.size > 64 * 1024 * 1024:
            raise BackupError("archive recovery manifest missing or too large")
        manifest_stream = tar.extractfile(manifest_member)
        if manifest_stream is None:
            raise BackupError("archive manifest is unreadable")
        manifest = json.load(manifest_stream)
        if manifest.get("schema_version") != 1:
            raise BackupError("unsupported recovery manifest")
        files, links, dirs = manifest["files"], manifest["links"], set(manifest["directories"])
        if files.keys() & links.keys() or files.keys() & dirs or links.keys() & dirs:
            raise BackupError("archive manifest has conflicting entry types")
        wanted = set(files) | set(links) | dirs | {"manifest.json", "employees"}
        for name in files:
            for parent in PurePosixPath(name).parents:
                if str(parent) != "." and str(parent) not in dirs:
                    raise BackupError("archive manifest omits a parent directory")
        if set(members) != wanted:
            raise BackupError("archive payload differs from recovery manifest")
        for name in wanted:
            if safe_name(name) != name:
                raise BackupError("noncanonical recovery path")
            for parent in PurePosixPath(name).parents:
                if str(parent) in links or str(parent) in files:
                    raise BackupError("archive descends through a link or file")
        validate_link_graph(links)
        for name in links:
            member = members[name]
            if not member.issym() or member.linkname != links[name]:
                raise BackupError("archive link differs from recovery manifest")
        # Do not extract links until every regular file has been written and checked.
        for name in sorted(dirs | {"employees"}, key=lambda n: len(Path(n).parts)):
            if not members[name].isdir():
                raise BackupError("archive directory differs from recovery manifest")
            (destination / name).mkdir(mode=0o700, parents=True, exist_ok=True)
        for name, record in files.items():
            member = members[name]
            if not member.isfile():
                raise BackupError("archive file differs from recovery manifest")
            target = destination / name
            source = tar.extractfile(member)
            if source is None:
                raise BackupError("archive file is unreadable")
            with source, target.open("xb") as out:
                shutil.copyfileobj(source, out)
            mode = record.get("mode", 0o600)  # schema v1 archives predate mode metadata
            if type(mode) is not int or mode < 0 or mode & ~0o700:
                raise BackupError(f"unsafe restored file mode: {name}")
            target.chmod(mode)
            if digest(target) != record["sha256"]:
                raise BackupError(f"restored file hash mismatch: {name}")
            if record["kind"] == "sqlite":
                with contextlib.closing(sqlite3.connect(target.as_uri() + "?mode=ro", uri=True)) as conn:
                    if conn.execute("PRAGMA integrity_check").fetchall() != [("ok",)]:
                        raise BackupError(f"restored database integrity failed: {name}")
        atomic_json(destination / "manifest.json", manifest)
        for name, target in links.items():
            (destination / name).symlink_to(target)
    return manifest, expected


def archived_inventory(archive):
    """Read only the bounded manifest for restore placement; no extraction/writes."""
    with tarfile.open(archive, "r:gz") as tar:
        members = [m for m in tar if m.name == "snapshot/manifest.json"]
        if len(members) != 1 or not members[0].isfile() or members[0].size > 64 * 1024 * 1024:
            raise BackupError("archive recovery manifest missing or too large")
        stream = tar.extractfile(members[0])
        if stream is None:
            raise BackupError("archive manifest is unreadable")
        with stream:
            manifest = json.load(stream)
        if manifest.get("schema_version") != 1:
            raise BackupError("unsupported recovery manifest")
        return manifest["inventory"]


def engine(args, source, retain):
    argv = [args.forever_ago, "--source", str(source), "--dest-dir", str(args.dest),
            "--prefix", PREFIX, "--retain", str(retain), "--once"]
    try:
        result = subprocess.run(argv, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=1500)
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise BackupError("forever-ago unavailable or timed out") from exc
    if result.returncode:
        # Engine stderr can include state filenames; do not leak payload into scheduler logs.
        raise BackupError(f"forever-ago failed (exit {result.returncode}); inspect private destination")
    return argv


def run(args):
    info = inventory(args)
    if info["errors"]:
        raise BackupError("; ".join(info["errors"]))
    validate_dest(args.dest, info)
    private_dir(args.dest)
    lock_path = args.dest / ".flume-runtime.lock"
    fd = os.open(lock_path, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, "w") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as exc:
            raise BackupError("another runtime backup is running") from exc
        started = dt.datetime.now(dt.timezone.utc).isoformat()
        # forever-ago names by local date; Candybar runner pins TZ to the schedule zone.
        archive = args.dest / f"{PREFIX}-{dt.date.today().isoformat()}.tar.gz"
        with tempfile.TemporaryDirectory(prefix=".stage-", dir=args.dest) as working:
            source = Path(working) / "snapshot"
            source.mkdir(mode=0o700)
            manifest = stage(info, source)
            reused = archive.exists()
            if archive.is_symlink() or Path(str(archive) + ".sha256").is_symlink():
                raise BackupError("archive paths cannot be symlinks")
            if reused:
                with tempfile.TemporaryDirectory(prefix=".verify-", dir=args.dest) as drill:
                    old, _ = extract_verified(archive, Path(drill))
                if old != manifest:
                    raise BackupError("same-day snapshot differs; immutable backup preserved; retry next night")
            elif Path(str(archive) + ".sha256").exists():
                raise BackupError("orphan daily checksum; inspect destination before retry")
            # First pass cannot prune anything, including archives with future-dated names.
            existing = sum(1 for p in args.dest.glob(f"{PREFIX}-*.tar.gz"))
            argv = engine(args, source, max(RETAIN, existing + 1))
            with tempfile.TemporaryDirectory(prefix=".verify-", dir=args.dest) as drill:
                recovered, sha = extract_verified(archive, Path(drill))
            if recovered != manifest:
                raise BackupError("archive does not match staged employee coverage")
            engine(args, source, RETAIN)
            result = {"status": "success", "started_at": started,
                      "completed_at": dt.datetime.now(dt.timezone.utc).isoformat(),
                      "snapshot_date": dt.date.today().isoformat(), "reused_daily_snapshot": reused,
                      "employees": [e["employee"] for e in info["employees"]],
                      "archive": str(archive), "sha256": sha, "engine_argv": argv,
                      "retained": RETAIN, "files": len(manifest["files"])}
            atomic_json(args.dest / "last-success.json", result)
            atomic_json(args.dest / "last-run.json", result)
            return result


def parser():
    cli = argparse.ArgumentParser(description=__doc__)
    cli.add_argument("--fleet-home", type=absolute, default=absolute(os.environ.get("HERMES_FLEET_HOME", "").strip() or "~/.hermes"))
    cli.add_argument("--registry", type=absolute)
    cli.add_argument("--dest", type=absolute, default=absolute("~/backups/flume-runtime"))
    cli.add_argument("--forever-ago", default=str(Path.home() / ".cargo/bin/forever-ago"))
    sub = cli.add_subparsers(dest="command", required=True)
    sub.add_parser("inventory")
    sub.add_parser("run")
    verify = sub.add_parser("verify")
    verify.add_argument("archive", type=absolute)
    restore = sub.add_parser("restore")
    restore.add_argument("archive", type=absolute)
    restore.add_argument("destination", type=absolute)
    return cli


def main():
    os.umask(0o077)
    args = parser().parse_args()
    args.registry = args.registry or absolute(os.environ.get("HERMES_AGENTS_REGISTRY", "").strip() or
        os.environ.get("HERMES_FLEET_REGISTRY_FILE", "").strip() or args.fleet_home / "agents-registry.yaml")
    try:
        if args.command == "inventory":
            result = inventory(args)
            code = bool(result["errors"])
        elif args.command == "run":
            result = run(args)
            code = 0
        else:
            if args.command == "restore":
                destination = args.destination
                if destination.exists() or destination.is_symlink():
                    raise BackupError("restore destination must not exist")
                if inside(destination.resolve(), args.fleet_home.resolve()):
                    raise BackupError("restore destination must be outside the active fleet home")
                # Refuse overlapping placement before even creating its parent or
                # extracting into a temporary tree beneath an active runtime.
                validate_dest(destination, archived_inventory(args.archive))
                if args.registry.exists():
                    validate_dest(destination, inventory(args))
                private_dir(destination.parent)
                with tempfile.TemporaryDirectory(prefix=".restore-", dir=destination.parent) as working:
                    recovered = Path(working) / "recovered"
                    recovered.mkdir(mode=0o700)
                    manifest, sha = extract_verified(args.archive, recovered)
                    validate_dest(destination, manifest["inventory"])
                    # Reserve the target without replacing even an empty existing directory.
                    destination.mkdir(mode=0o700)
                    try:
                        os.rename(recovered, destination)
                    except Exception:
                        destination.rmdir()
                        raise
            else:
                private_dir(args.dest)
                with tempfile.TemporaryDirectory(prefix=".verify-", dir=args.dest) as tmp:
                    manifest, sha = extract_verified(args.archive, Path(tmp))
            result = {"status": "success", "sha256": sha, "employees": len(manifest["inventory"]["employees"]),
                      "files": len(manifest["files"]), "dependencies": len(manifest["dependencies"])}
            code = 0
    except (BackupError, OSError, ValueError, KeyError, TypeError, RuntimeError, sqlite3.Error, tarfile.TarError) as exc:
        result = {"status": "fail", "error": str(exc)}
        code = 1
        if args.command == "run" and args.dest.is_dir() and not args.dest.is_symlink():
            try:
                info = inventory(args)
                validate_dest(args.dest, info)
                private_dir(args.dest)
                atomic_json(args.dest / "last-run.json", result)
            except (BackupError, OSError):
                pass
    print(json.dumps(result, indent=2, sort_keys=True))
    result_file = os.environ.get("CANDYBAR_RESULT_FILE")
    if result_file:
        # Candybar supplies this private per-invocation path; no payload goes into it.
        atomic_json(Path(result_file), {"status": "fail" if code else "success",
            "message": result.get("error", "employee runtime backup verified"),
            "metrics": {"token_spend": 0, "cost_usd": 0}})
    return int(code)


if __name__ == "__main__":
    raise SystemExit(main())
