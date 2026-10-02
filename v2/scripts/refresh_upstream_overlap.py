#!/usr/bin/env python3
"""Prune only unrestricted host rules duplicated by EasyList/EasyPrivacy.

This is a review aid, not an auto-publisher. It never adds block rules.
"""
from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path
import hashlib
import json
import re
import urllib.request

ROOT = Path(__file__).resolve().parents[2]
LIST_DIR = ROOT / "v2"
SOURCES = {
    "EasyList": "https://easylist.to/easylist/easylist.txt",
    "EasyPrivacy": "https://easylist.to/easylist/easyprivacy.txt",
}
ALLOWED_OPTIONS = {"third-party", "important", "match-case", "all"}
HOST_RULE = re.compile(r"\|\|([a-z0-9.-]+)\^(?:\$([^\s]+))?$", re.I)
VERSION = re.compile(r"(?m)^! Version: (\d{8})\.(\d+)$")


def fetch_sources() -> dict[str, dict]:
    result = {}
    for name, url in SOURCES.items():
        request = urllib.request.Request(url, headers={"User-Agent": "filter-overlap-auditor/1.0"})
        with urllib.request.urlopen(request, timeout=60) as response:
            raw = response.read()
        domains = set()
        for line in raw.decode("utf-8", "ignore").splitlines():
            line = line.strip()
            if not line or line.startswith(("!", "#", "@@")):
                continue
            match = HOST_RULE.fullmatch(line)
            if not match:
                continue
            options = set((match.group(2) or "").lower().split(","))
            if options <= ALLOWED_OPTIONS:
                domains.add(match.group(1).lower())
        result[name] = {
            "url": url,
            "sha256": hashlib.sha256(raw).hexdigest(),
            "bytes": len(raw),
            "domains": domains,
        }
    return result


def matching_sources(host: str, sources: dict[str, dict]) -> list[dict]:
    matches = []
    for name, source in sources.items():
        parent = next((domain for domain in source["domains"]
                       if host == domain or host.endswith("." + domain)), None)
        if parent:
            matches.append({"source": name, "matched_domain": parent})
    return matches


def prune(text: str, sources: dict[str, dict]) -> tuple[str, list[dict]]:
    kept, removed = [], []
    for line in text.splitlines(keepends=True):
        match = HOST_RULE.fullmatch(line.rstrip("\r\n"))
        options = set((match.group(2) or "").lower().split(",")) if match else set()
        matches = matching_sources(match.group(1).lower(), sources) if match and "third-party" in options else []
        if matches:
            removed.append({"rule": line.rstrip("\r\n"), "covered_by": matches})
        else:
            kept.append(line)
    if removed:
        result = "".join(kept)
        result, count = VERSION.subn(lambda m: f"! Version: {m.group(1)}.{int(m.group(2)) + 1}", result, count=1)
        if count != 1:
            raise ValueError("could not bump exactly one filter version")
        return result, removed
    return text, removed


def main() -> None:
    sources = fetch_sources()
    removed_by_file = {}
    candidates = ("ad.txt", "tracking.txt", "strict.txt")
    for filename in candidates:
        path = LIST_DIR / filename
        updated, removed = prune(path.read_text(encoding="utf-8"), sources)
        if removed:
            path.write_text(updated, encoding="utf-8", newline="")
        removed_by_file[filename] = removed

    evidence_path = LIST_DIR / "evidence" / "current.json"
    evidence = json.loads(evidence_path.read_text(encoding="utf-8"))
    evidence["candidate_sha256"] = {
        name: hashlib.sha256((LIST_DIR / name).read_bytes()).hexdigest() for name in candidates
    }
    evidence["status"] = "UNVERIFIED"
    evidence["note"] = (
        "Weekly EasyList/EasyPrivacy broad-host overlap review only; see "
        "overlap-audit-latest.json. Retained-rule provenance, full-list overlap, "
        "browser regression, canary, and rollback remain unverified."
    )
    evidence_path.write_text(json.dumps(evidence, indent=2) + "\n", encoding="utf-8")

    report = {
        "audit": "EasyList/EasyPrivacy unrestricted anchored-host overlap",
        "retrieved_at_utc": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "method": (
            "Remove only candidate ||host^$third-party rules covered by an upstream "
            "unrestricted ||domain^ block. Do not add rules. Path-specific, resource-limited, "
            "site-limited, and exception filters are outside scope. Static audit only."
        ),
        "sources": {name: {k: v for k, v in src.items() if k != "domains"} for name, src in sources.items()},
        "removed_count": {name: len(rules) for name, rules in removed_by_file.items()},
        "removed_rules": removed_by_file,
        "status": "REVIEW_REQUIRED; no browser regression or auto-publication",
    }
    (LIST_DIR / "evidence" / "overlap-audit-latest.json").write_text(
        json.dumps(report, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
    )


if __name__ == "__main__":
    main()
