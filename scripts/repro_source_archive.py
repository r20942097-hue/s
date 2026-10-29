"""Deterministically build/verify an exact-copy ZIP from immutable Git blobs.

Offline and Python-stdlib only. Neither the recipe nor generated digest is an
attestation of who authored the Git commit; never promotes a product to GO.
No archive extraction, shell commands, network, hooks, or Git writes.
"""
from __future__ import annotations

import argparse
import hashlib
import io
import json
import os
import re
import stat
import subprocess
import sys
import unicodedata
import zipfile
from pathlib import Path


SCHEMA = "gpt1-repro-source-zip/v1"
SHA40 = re.compile(r"[0-9a-f]{40}\Z")
SHA256 = re.compile(r"[0-9a-f]{64}\Z")
MAX_RECIPE = 128 * 1024
MAX_FILES = 128
MAX_BLOB = 4 * 1024 * 1024
MAX_TOTAL = 32 * 1024 * 1024
ZIP_DATE = (1980, 1, 1, 0, 0, 0)


class BuildError(ValueError):
    """Untrusted or inconsistent reproducible-build input."""


DEVICES = re.compile(r"(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?\Z", re.I)
BAD_CHARS = set('<>:"|?*')


def safe_name(name: object) -> bool:
    if not isinstance(name, str) or not name or name.startswith("/") or "\\" in name or "\0" in name:
        return False
    return not any(
        part in ("", ".", "..") or part.endswith((" ", ".")) or DEVICES.fullmatch(part)
        or any(ord(c) < 32 or c in BAD_CHARS for c in part)
        for part in name.split("/")
    )


def _git(root: Path, *args: str, binary: bool = False) -> bytes | str:
    command = ["git", "-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null",
               "-C", str(root), *args]
    p = subprocess.run(command, capture_output=True, check=False, timeout=25)
    if p.returncode != 0 or len(p.stdout) > (MAX_BLOB if binary else 2 * 1024 * 1024):
        raise BuildError("Git command failed or exceeded output limit")
    return p.stdout if binary else p.stdout.decode("utf-8", "strict").strip()


def _recipe(path: Path) -> dict:
    if path.is_symlink() or not path.is_file() or path.stat().st_size > MAX_RECIPE:
        raise BuildError("recipe missing, linked or oversized")
    data = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict) or set(data) != {"schema", "source_commit", "files"}:
        raise BuildError("invalid build recipe root")
    if data["schema"] != SCHEMA or not isinstance(data["source_commit"], str) or not SHA40.fullmatch(data["source_commit"]):
        raise BuildError("invalid recipe schema/commit")
    files = data["files"]
    if not isinstance(files, list) or not 1 <= len(files) <= MAX_FILES:
        raise BuildError("invalid recipe file count")
    seen_src, seen_dst = set(), set()
    for item in files:
        if not isinstance(item, dict) or set(item) != {"source", "member"}:
            raise BuildError("invalid file mapping")
        src, dst = item["source"], item["member"]
        if not safe_name(src) or not safe_name(dst):
            raise BuildError("unsafe source or ZIP member path")
        sn, dn = unicodedata.normalize("NFC", src).casefold(), unicodedata.normalize("NFC", dst).casefold()
        if sn in seen_src or dn in seen_dst:
            raise BuildError("colliding or duplicate paths")
        seen_src.add(sn)
        seen_dst.add(dn)
    destination_names = {item["member"] for item in files}
    if any(any(other.startswith(name + "/") for other in destination_names) for name in destination_names):
        raise BuildError("ZIP file/directory conflict")
    return data


def generate(root: Path, recipe_path: Path) -> tuple[bytes, dict]:
    root = Path(root)
    if root.is_symlink() or not root.is_dir():
        raise BuildError("checkout root missing or linked")
    root = root.resolve(strict=True)
    recipe = _recipe(Path(recipe_path))
    if Path(_git(root, "rev-parse", "--show-toplevel")).resolve(strict=True) != root:
        raise BuildError("source path is not the Git repository root")
    if _git(root, "rev-parse", "--verify", "HEAD") != recipe["source_commit"]:
        raise BuildError("Git HEAD is not the pinned source commit")
    if _git(root, "status", "--porcelain=v1", "--untracked-files=all"):
        raise BuildError("Git worktree contains modifications or untracked files")
    buffer = io.BytesIO()
    size = 0
    index = []
    with zipfile.ZipFile(buffer, mode="w", compression=zipfile.ZIP_STORED, allowZip64=False) as archive:
        for item in sorted(recipe["files"], key=lambda x: x["member"].encode("utf-8")):
            rel, member = item["source"], item["member"]
            listing = _git(root, "ls-tree", "-z", "HEAD", "--", rel, binary=True)
            if listing.count(b"\0") != 1 or not listing.endswith(b"\0"):
                raise BuildError("path is not a unique committed Git tree entry")
            meta, gitpath = listing[:-1].split(b"\t", 1)
            if gitpath.decode("utf-8", "strict") != rel:
                raise BuildError("committed source path mismatch")
            fields = meta.split(b" ")
            if len(fields) != 3 or fields[0] not in {b"100644", b"100755"} or fields[1] != b"blob":
                raise BuildError("source must be a normal Git blob (not submodule/symlink)")
            blob = fields[2].decode("ascii")
            if not SHA40.fullmatch(blob):
                raise BuildError("unsupported Git object format")
            n = _git(root, "cat-file", "-s", blob)
            if not n.isdecimal() or int(n) > MAX_BLOB:
                raise BuildError("Git blob exceeds deterministic archive budget")
            size += int(n)
            if size > MAX_TOTAL:
                raise BuildError("aggregate Git blobs exceed budget")
            data = _git(root, "cat-file", "blob", blob, binary=True)
            if len(data) != int(n):
                raise BuildError("committed Git blob length mismatch")
            info = zipfile.ZipInfo(member, date_time=ZIP_DATE)
            info.create_system = 3  # always Unix metadata, even on Windows
            info.external_attr = (stat.S_IFREG | 0o644) << 16
            info.compress_type = zipfile.ZIP_STORED  # no zlib-version dependence
            archive.writestr(info, data)
            index.append({"member": member, "source": rel, "sha256": hashlib.sha256(data).hexdigest()})
    data = buffer.getvalue()
    digest = hashlib.sha256(data).hexdigest()
    report = {"schema": "gpt1-repro-source-zip-result/v1", "status": "BUILT",
              "decision": "CANDIDATE_NO_GO", "source_commit": recipe["source_commit"],
              "sha256": digest, "bytes": len(data), "files": index,
              "upstream_origin_authenticated": "NOT_RUN", "signed_attestation": "NOT_RUN",
              "browser_e2e": "NOT_RUN"}
    return data, report


def verify(root: Path, recipe: Path, candidate: Path, expected_sha256: str) -> dict:
    try:
        if not isinstance(expected_sha256, str) or not SHA256.fullmatch(expected_sha256):
            raise BuildError("expected SHA-256 must be independent 64-character lowercase hex")
        if candidate.is_symlink() or not candidate.is_file() or candidate.stat().st_size > MAX_TOTAL + 128 * MAX_FILES + 65536:
            raise BuildError("candidate missing, linked or oversized")
        regenerated, report = generate(root, recipe)
        candidate_bytes = candidate.read_bytes()
        if candidate_bytes != regenerated or hashlib.sha256(candidate_bytes).hexdigest() != expected_sha256:
            raise BuildError("candidate ZIP differs from deterministic Git rebuild or expected digest")
        return {**report, "status": "REPRODUCIBLE", "external_digest_matched": True}
    except (BuildError, ValueError, OSError, UnicodeError, KeyError, TypeError, RuntimeError, EOFError) as exc:
        return {"schema": "gpt1-repro-source-zip-result/v1", "status": "FAIL",
                "decision": "CANDIDATE_NO_GO", "error": type(exc).__name__,
                "upstream_origin_authenticated": "NOT_RUN", "signed_attestation": "NOT_RUN",
                "browser_e2e": "NOT_RUN"}


def main(argv=None) -> int:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--root", type=Path, required=True)
    p.add_argument("--recipe", type=Path, required=True)
    g = p.add_mutually_exclusive_group(required=True)
    g.add_argument("--candidate", type=Path, help="read-only verify an existing ZIP")
    g.add_argument("--output", type=Path, help="create one new ZIP, never overwrite")
    p.add_argument("--expected-sha256", help="independent expected ZIP digest for --candidate")
    p.add_argument("--json", action="store_true")
    a = p.parse_args(argv)
    try:
        if a.candidate is not None:
            result = verify(a.root, a.recipe, a.candidate, a.expected_sha256)
        else:
            if a.expected_sha256 is not None:
                raise BuildError("--expected-sha256 only applies to verification")
            archive, result = generate(a.root, a.recipe)
            destination = a.output
            if destination.is_symlink() or not destination.parent.is_dir():
                raise BuildError("destination is a link or parent does not exist")
            if a.root.resolve() in (destination.parent.resolve(), *destination.parent.resolve().parents):
                raise BuildError("output must be outside source checkout")
            # Exclusive creation: cannot silently overwrite an earlier candidate.
            with destination.open("xb") as out:
                out.write(archive)
        if a.json:
            print(json.dumps(result, ensure_ascii=False, indent=2))
        else:
            print(result["status"], result.get("sha256", ""))
        return 0 if result["status"] in {"BUILT", "REPRODUCIBLE"} else 1
    except (BuildError, ValueError, OSError, UnicodeError, KeyError, TypeError, RuntimeError):
        print(json.dumps({"status": "FAIL", "decision": "CANDIDATE_NO_GO", "error": "build inputs or destination rejected"}))
        return 1


if __name__ == "__main__":
    sys.exit(main())
