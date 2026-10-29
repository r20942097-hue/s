"""Verify explicit source-file -> ZIP-member byte identity; never assert build provenance.

This gate is for copied-source packages, not compiled/transformed outputs.
Only an independently reviewed manifest is a useful claim. Even MATCH is
NOT release approval or trusted builder provenance. Python 3.11+, offline.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import stat
import sys
import unicodedata
import zipfile
from pathlib import Path, PurePosixPath

SCHEMA = "gpt1-source-zip-parity/v1"
PRODUCTS = {"rplay", "streamharbor", "youtube-optimizer", "filter-lists", "fixture"}
SHA = re.compile(r"[0-9a-f]{64}\Z")
COMMIT = re.compile(r"[0-9a-f]{40}\Z")
DEVICES = re.compile(r"(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?\Z", re.I)
BAD_CHARS = set('<>:"|?*')
MAX_MANIFEST = 512 * 1024
MAX_MEMBERS = 15000
MAX_ITEM = 128 * 1024 * 1024
MAX_TOTAL = 768 * 1024 * 1024


def safe_name(name: object) -> bool:
    if not isinstance(name, str) or not name or name.startswith("/") or "\\" in name or "\0" in name:
        return False
    parts = name.split("/")
    return not any(
        part in ("", ".", "..") or part.endswith((" ", ".")) or DEVICES.fullmatch(part)
        or any(ord(c) < 32 or c in BAD_CHARS for c in part)
        for part in parts
    )


def _safe_source(root: Path, relative: str) -> Path:
    path = root
    for part in PurePosixPath(relative).parts:
        path /= part
        if path.is_symlink():
            raise ValueError("linked source file or parent")
    if not path.is_file():
        raise ValueError("missing/non-file source")
    return path


def digest_file(path: Path, max_bytes: int = MAX_TOTAL) -> tuple[str, int]:
    if path.is_symlink() or not path.is_file():
        raise ValueError("missing or linked file")
    if path.stat().st_size > max_bytes:
        raise ValueError("file size exceeds policy")
    h, size = hashlib.sha256(), 0
    with path.open("rb") as f:
        while data := f.read(256 * 1024):
            size += len(data)
            if size > max_bytes:
                raise ValueError("file read exceeds policy")
            h.update(data)
    return h.hexdigest(), size


def _validate_claim(data: object) -> tuple[list[dict], list[str]]:
    errors: list[str] = []
    if not isinstance(data, dict) or set(data) != {"schema", "product", "artifact_sha256", "source_commit", "files"}:
        return [], ["invalid manifest keys"]
    if data["schema"] != SCHEMA or not isinstance(data["product"], str) or data["product"] not in PRODUCTS:
        errors.append("invalid schema/product")
    if not isinstance(data["artifact_sha256"], str) or not SHA.fullmatch(data["artifact_sha256"]):
        errors.append("invalid expected artifact digest")
    commit = data["source_commit"]
    if commit is not None and (not isinstance(commit, str) or not COMMIT.fullmatch(commit)):
        errors.append("invalid source commit metadata")
    files = data["files"]
    if not isinstance(files, list) or not (1 <= len(files) <= MAX_MEMBERS):
        return [], errors + ["empty/excessive file mapping"]
    seen_src, seen_dst = set(), set()
    for i, item in enumerate(files):
        if not isinstance(item, dict) or set(item) != {"source", "member", "sha256"}:
            errors.append(f"mapping {i}: incorrect keys")
            continue
        src, dst, sha = item["source"], item["member"], item["sha256"]
        if not safe_name(src) or not safe_name(dst) or not isinstance(sha, str) or not SHA.fullmatch(sha):
            errors.append(f"mapping {i}: invalid path or digest")
            continue
        a, b = unicodedata.normalize("NFC", src).casefold(), unicodedata.normalize("NFC", dst).casefold()
        if a in seen_src or b in seen_dst:
            errors.append(f"mapping {i}: duplicate/colliding source or member")
        seen_src.add(a)
        seen_dst.add(b)
    return files, errors


def verify(claim_file: Path, source_dir: Path, artifact: Path) -> dict:
    errors: list[str] = []
    observed: dict[str, int | str] = {"matched": 0, "total": 0}
    try:
        if claim_file.is_symlink() or not claim_file.is_file() or claim_file.stat().st_size > MAX_MANIFEST:
            raise ValueError("manifest missing/linked/oversized")
        claim = json.loads(claim_file.read_text(encoding="utf-8"))
        files, errors = _validate_claim(claim)
    except (OSError, ValueError, UnicodeError):
        files, claim = [], {}
        errors = ["unreadable/invalid manifest"]
    root = Path(source_dir).absolute()
    if root.is_symlink() or not root.is_dir():
        errors.append("source directory missing/linked")
    if not errors:
        try:
            actual_hash, actual_size = digest_file(artifact)
            if actual_hash != claim["artifact_sha256"]:
                errors.append("artifact SHA-256 differs from independent manifest claim")
            observed["artifact_sha256"] = actual_hash
            observed["artifact_size"] = actual_size
            with zipfile.ZipFile(artifact) as zf:
                members = zf.infolist()
                if not members or len(members) > MAX_MEMBERS:
                    errors.append("ZIP entry count outside policy")
                canonical: set[str] = set()
                actual: dict[str, zipfile.ZipInfo] = {}
                total = 0
                for entry in members:
                    name = entry.filename
                    if not safe_name(name[:-1] if entry.is_dir() else name):
                        errors.append("unsafe ZIP member path")
                        continue
                    key = unicodedata.normalize("NFC", name.rstrip("/")).casefold()
                    if key in canonical:
                        errors.append("ZIP member name collision")
                    canonical.add(key)
                    mode = (entry.external_attr >> 16) & 0xFFFF
                    if stat.S_ISLNK(mode) or entry.flag_bits & 1:
                        errors.append("linked/encrypted ZIP member")
                    if entry.compress_type not in (zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED):
                        errors.append("unsupported ZIP compression")
                    if entry.file_size > MAX_ITEM:
                        errors.append("ZIP member exceeds size policy")
                    if not entry.is_dir():
                        total += entry.file_size
                        actual[name] = entry
                if any(any(other.startswith(name + "/") for other in canonical) for name in actual):
                    errors.append("ZIP member file/directory name conflict")
                if total > MAX_TOTAL:
                    errors.append("ZIP expanded size exceeds policy")
                claim_members = {item["member"] for item in files}
                if set(actual) != claim_members:
                    errors.append("unmapped/missing ZIP members (complete coverage required)")
                observed["total"] = len(files)
                if not errors:
                    for item in files:
                        src = _safe_source(root, item["source"])
                        source_hash, source_size = digest_file(src, MAX_ITEM)
                        entry = actual[item["member"]]
                        h, read = hashlib.sha256(), 0
                        with zf.open(entry) as stream:
                            while chunk := stream.read(256 * 1024):
                                h.update(chunk)
                                read += len(chunk)
                                if read > MAX_ITEM:
                                    raise ValueError("expanded member too large")
                        if source_hash != item["sha256"] or h.hexdigest() != item["sha256"] or source_size != read:
                            errors.append(f"content digest mismatch for {item['member']}")
                        else:
                            observed["matched"] += 1
        except (OSError, RuntimeError, EOFError, ValueError, zipfile.BadZipFile, NotImplementedError) as exc:
            errors.append(f"source/archive unreadable or unsafe ({type(exc).__name__})")
    return {
        "schema": "gpt1-source-zip-parity-result/v1",
        "content_parity": "MATCH" if not errors else "MISMATCH",
        "decision": "CANDIDATE_NO_GO",
        "scope": "exact copied-source bytes in a complete ZIP; not transformed builds",
        "observed": observed, "errors": errors,
        "git_commit_verified": "NOT_RUN",
        "signed_attestation_verified": "NOT_RUN",
        "live_browser_e2e": "NOT_RUN",
    }


def main(argv=None) -> int:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--claim", required=True, type=Path)
    p.add_argument("--source-root", required=True, type=Path)
    p.add_argument("--artifact", required=True, type=Path)
    p.add_argument("--json", action="store_true")
    a = p.parse_args(argv)
    result = verify(a.claim, a.source_root, a.artifact)
    if a.json:
        print(json.dumps(result, ensure_ascii=False, indent=2))
    else:
        print(result["content_parity"], result["observed"], result["errors"])
    return 0 if result["content_parity"] == "MATCH" else 1


if __name__ == "__main__":
    sys.exit(main())
