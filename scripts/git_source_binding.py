"""Bind a complete copied-source ZIP to a clean, exact Git commit's blob bytes.

Read-only local proof; Git origin configuration is untrusted and a matching
commit object does not authenticate an upstream publisher. Requires an
independently reviewed manifest, source ZIP parity, and a clean checkout.
Never publishes, modifies Git, signs, or approves product releases.
"""
from __future__ import annotations
import argparse
import hashlib
import json
import re
import subprocess
import sys
from pathlib import Path

from source_zip_parity import verify as zip_parity

REPOS = frozenset({"r20942097-hue/faaff", "r20942097-hue/s"})
SHA40 = re.compile(r"[0-9a-f]{40}\Z")
MAX_BLOB_BYTES = 16 * 1024 * 1024
MAX_FILES = 1000
MAX_OUTPUT = 2 * 1024 * 1024


def _git(root: Path, *args: str, binary: bool = False) -> bytes | str:
    command = ["git", "-c", "core.fsmonitor=false", "-c",
               "core.hooksPath=/dev/null", "-C", str(root), *args]
    p = subprocess.run(command, capture_output=True, timeout=25, check=False)
    if p.returncode != 0 or len(p.stdout) > (MAX_BLOB_BYTES if binary else MAX_OUTPUT):
        raise ValueError("git command failed or exceeded output policy")
    return p.stdout if binary else p.stdout.decode("utf-8", "strict").strip()


def _failure(errors: list[str], copied: dict | None = None) -> dict:
    return {
        "schema": "gpt1-git-source-binding/v1", "status": "FAIL",
        "decision": "CANDIDATE_NO_GO",
        "source_zip_parity": (copied or {}).get("content_parity", "NOT_RUN"),
        "git_tree_parity": "NOT_VERIFIED", "git_author_identity": "NOT_VERIFIED",
        "upstream_repository_authenticated": "NOT_RUN",
        "signed_attestation": "NOT_RUN", "live_browser_e2e": "NOT_RUN",
        "errors": errors,
    }


def verify(claim_path: Path, source_root: Path, artifact: Path, expected_repo: str) -> dict:
    if not isinstance(expected_repo, str) or expected_repo not in REPOS:
        return _failure(["repository not allowlisted"])
    source_root = Path(source_root)
    if source_root.is_symlink() or not source_root.is_dir():
        return _failure(["missing or symlinked source checkout"])
    # The existing dedicated verifier rejects unsafe names, CRC and unmapped
    # members before any Git-object assertion is considered.
    copied = zip_parity(Path(claim_path), source_root, Path(artifact))
    if copied["content_parity"] != "MATCH":
        return _failure(["complete source-to-ZIP byte parity failed"], copied)
    try:
        claim = json.loads(Path(claim_path).read_text(encoding="utf-8"))
        commit = claim["source_commit"]
        entries = claim["files"]
        if not isinstance(commit, str) or not SHA40.fullmatch(commit):
            raise ValueError("missing full Git commit pin")
        if not isinstance(entries, list) or not (1 <= len(entries) <= MAX_FILES):
            raise ValueError("source mapping count outside Git verification budget")
        source_root = source_root.resolve(strict=True)
        top = Path(_git(source_root, "rev-parse", "--show-toplevel")).resolve(strict=True)
        if top != source_root:
            raise ValueError("source root is not checkout toplevel")
        if _git(source_root, "rev-parse", "--verify", "HEAD") != commit:
            raise ValueError("checked-out HEAD differs from claimed Git commit")
        if _git(source_root, "status", "--porcelain=v1", "--untracked-files=all"):
            raise ValueError("Git checkout has modifications or untracked files")
        origin = _git(source_root, "remote", "get-url", "origin")
        allowed = {f"https://github.com/{expected_repo}", f"https://github.com/{expected_repo}.git",
                   f"git@github.com:{expected_repo}.git", f"git@github.com:{expected_repo}"}
        if origin not in allowed:
            raise ValueError("configured Git origin differs from expected repository")
        for record in entries:
            rel, digest = record["source"], record["sha256"]
            raw = _git(source_root, "ls-tree", "-z", "HEAD", "--", rel, binary=True)
            if not raw.endswith(b"\0") or raw.count(b"\0") != 1:
                raise ValueError("source path has no unique committed tree entry")
            metadata, actual_path = raw[:-1].split(b"\t", 1)
            if actual_path.decode("utf-8", "strict") != rel:
                raise ValueError("tree path differs from expected path")
            fields = metadata.split(b" ")
            if (len(fields) != 3 or fields[0] not in (b"100644", b"100755")
                    or fields[1] != b"blob"):
                raise ValueError("committed path is not an ordinary file")
            blob = fields[2].decode("ascii")
            if SHA40.fullmatch(blob) is None:
                raise ValueError("unsupported Git object identifier")
            size = _git(source_root, "cat-file", "-s", blob)
            if not size.isdecimal() or int(size) > MAX_BLOB_BYTES:
                raise ValueError("Git blob too large")
            payload = _git(source_root, "cat-file", "blob", blob, binary=True)
            if len(payload) != int(size) or hashlib.sha256(payload).hexdigest() != digest:
                raise ValueError("committed blob SHA-256 differs from ZIP/source claim")
    except (OSError, ValueError, KeyError, TypeError, UnicodeError,
            subprocess.TimeoutExpired, FileNotFoundError):
        return _failure(["Git checkout, origin metadata, or committed blob evidence failed"], copied)
    return {
        "schema": "gpt1-git-source-binding/v1", "status": "MATCH",
        "decision": "CANDIDATE_NO_GO", "source_zip_parity": "MATCH",
        "git_tree_parity": "MATCH", "git_commit": commit,
        "repository_configured": expected_repo, "files_verified": len(entries),
        "git_author_identity": "NOT_VERIFIED",
        "upstream_repository_authenticated": "NOT_RUN",
        "signed_attestation": "NOT_RUN", "live_browser_e2e": "NOT_RUN",
        "errors": [],
    }


def main(argv=None) -> int:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--claim", required=True, type=Path)
    p.add_argument("--source-root", required=True, type=Path)
    p.add_argument("--artifact", required=True, type=Path)
    p.add_argument("--expected-repo", required=True, choices=sorted(REPOS))
    p.add_argument("--json", action="store_true")
    a = p.parse_args(argv)
    result = verify(a.claim, a.source_root, a.artifact, a.expected_repo)
    if a.json:
        print(json.dumps(result, indent=2, ensure_ascii=False))
    else:
        print(result["status"], result["decision"])
        for issue in result["errors"]:
            print("ERROR:", issue)
    return 0 if result["status"] == "MATCH" else 1


if __name__ == "__main__":
    sys.exit(main())
