#!/usr/bin/env python3
"""Fail-closed promotion gate for candidate filter rules."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from datetime import date
from pathlib import Path
from typing import Any

from validate_filters import EXPECTED, ROOT


SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
REVISION_RE = re.compile(r"^[0-9a-f]{40}$")


def active_rules() -> set[tuple[str, str]]:
    result: set[tuple[str, str]] = set()
    for name in EXPECTED:
        path = ROOT / name
        if path.exists():
            for line in path.read_text(encoding="utf-8").splitlines():
                if line.startswith("||"):
                    result.add((name, line.strip()))
    return result


def evidence_files_exist(value: Any) -> bool:
    if not isinstance(value, list) or not value:
        return False
    repo_root = ROOT.parent.resolve()
    for path in value:
        if not isinstance(path, str) or not path.strip() or Path(path).is_absolute():
            return False
        candidate = (repo_root / path).resolve()
        try:
            candidate.relative_to(repo_root)
        except ValueError:
            return False
        if not candidate.is_file():
            return False
    return True


def snapshot_matches(source: dict[str, Any]) -> bool:
    path = source.get("snapshot_path")
    digest = source.get("sha256")
    if not isinstance(path, str) or not isinstance(digest, str) or not SHA256_RE.fullmatch(digest):
        return False
    if not evidence_files_exist([path]):
        return False
    return hashlib.sha256((ROOT.parent / path).read_bytes()).hexdigest() == digest


def evaluate(manifest: dict[str, Any], target: str, today: date | None = None) -> list[str]:
    errors: list[str] = []
    today = today or date.today()
    if manifest.get("schema") != "adblock-promotion-evidence/v1":
        errors.append("unsupported or missing evidence schema")
    if manifest.get("status") != "READY_FOR_REVIEW":
        errors.append("manifest status is not READY_FOR_REVIEW")

    expected_hashes: dict[str, str] = {}
    for name in EXPECTED:
        path = ROOT / name
        if not path.is_file():
            errors.append(f"missing candidate filter: {name}")
            continue
        expected_hashes[name] = hashlib.sha256(path.read_bytes()).hexdigest()
    if manifest.get("candidate_sha256") != expected_hashes:
        errors.append("evidence is not bound to the exact current filter bytes")

    wanted = active_rules()
    assessments = manifest.get("assessments")
    if not isinstance(assessments, list):
        errors.append("assessments must be a list")
        assessments = []
    observed: set[tuple[str, str]] = set()
    for index, item in enumerate(assessments):
        prefix = f"assessment[{index}]"
        if not isinstance(item, dict):
            errors.append(f"{prefix}: expected an object")
            continue
        key = (item.get("profile"), item.get("rule"))
        if key in observed:
            errors.append(f"{prefix}: duplicate assessment")
        observed.add(key)
        if key not in wanted:
            errors.append(f"{prefix}: rule is not present in the bound candidate files")

        sources = item.get("sources")
        if not isinstance(sources, list) or len(sources) < 2:
            errors.append(f"{prefix}: requires two independent source snapshots")
        else:
            source_ids: set[str] = set()
            source_hashes: set[str] = set()
            for source in sources:
                if not isinstance(source, dict):
                    errors.append(f"{prefix}: malformed source snapshot")
                    continue
                source_id = source.get("source_id")
                if not isinstance(source_id, str) or not source_id or source_id in source_ids:
                    errors.append(f"{prefix}: source snapshots must have distinct source IDs")
                source_ids.add(source_id if isinstance(source_id, str) else "")
                if not REVISION_RE.fullmatch(str(source.get("revision", ""))):
                    errors.append(f"{prefix}: source revision must be an immutable 40-character commit")
                if not SHA256_RE.fullmatch(str(source.get("sha256", ""))):
                    errors.append(f"{prefix}: source snapshot requires a SHA-256")
                elif not snapshot_matches(source):
                    errors.append(f"{prefix}: source snapshot file is missing or its SHA-256 does not match")
                source_hash = source.get("sha256")
                if isinstance(source_hash, str):
                    source_hashes.add(source_hash)
                if not str(source.get("url", "")).startswith("https://"):
                    errors.append(f"{prefix}: source URL must use HTTPS")
                elif str(source.get("revision", "")) not in str(source.get("url", "")):
                    errors.append(f"{prefix}: source URL must bind to the immutable revision")
            if len(source_hashes) < 2:
                errors.append(f"{prefix}: source snapshots must have distinct content")

        independence = item.get("source_independence")
        if not isinstance(independence, dict) or independence.get("status") != "PASS":
            errors.append(f"{prefix}: source independence review is not PASS")
        elif not evidence_files_exist(independence.get("evidence")):
            errors.append(f"{prefix}: source independence evidence file is missing")

        overlap = item.get("overlap")
        if not isinstance(overlap, dict) or overlap.get("result") != "NO_MATCH":
            errors.append(f"{prefix}: upstream overlap audit is not PASS/NO_MATCH")
        elif not SHA256_RE.fullmatch(str(overlap.get("snapshot_sha256", ""))):
            errors.append(f"{prefix}: overlap audit requires an immutable snapshot SHA-256")
        elif not evidence_files_exist(overlap.get("evidence")):
            errors.append(f"{prefix}: overlap audit evidence file is missing")

        for field in ("exception_review", "regression", "canary", "rollback"):
            check = item.get(field)
            if not isinstance(check, dict) or check.get("status") != "PASS":
                errors.append(f"{prefix}: {field} is not PASS")
            elif not evidence_files_exist(check.get("evidence")):
                errors.append(f"{prefix}: {field} evidence file is missing")

        if target == "stable":
            soak = item.get("soak")
            if not isinstance(soak, dict) or not evidence_files_exist(soak.get("evidence")):
                errors.append(f"{prefix}: stable promotion requires soak evidence")
            else:
                try:
                    started = date.fromisoformat(str(soak.get("started_at", "")))
                    days = (today - started).days
                    if days < 14:
                        errors.append(f"{prefix}: stable soak is only {days} days; 14 are required")
                except ValueError:
                    errors.append(f"{prefix}: invalid stable soak start date")

    missing = wanted - observed
    if missing:
        errors.append(f"{len(missing)} active rules lack complete assessments")
    return errors


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--target", choices=("canary", "stable"), required=True)
    parser.add_argument("--evidence", default="evidence/current.json")
    args = parser.parse_args()
    path = ROOT / args.evidence
    try:
        manifest = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        print(f"BLOCKED: cannot read evidence manifest: {exc}")
        return 2
    if not isinstance(manifest, dict):
        print("BLOCKED: evidence manifest must be a JSON object")
        return 2
    errors = evaluate(manifest, args.target)
    if errors:
        print(f"BLOCKED: {args.target} promotion is not supported by current evidence")
        print("\n".join(f"- {item}" for item in errors))
        return 2
    print(f"PASS: all rules satisfy the {args.target} evidence gate")
    return 0


if __name__ == "__main__":
    sys.exit(main())
