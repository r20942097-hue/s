"""Read-only, offline repository environment preflight for GPT1 projects.

This is a *structural* check, not a product or browser acceptance test.
Requires Python 3.11+; writes no files and makes no network calls.
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path

REQUIRED = {
    "r20942097-hue/faaff": (
        "AGENTS.md", "ai/PROJECT_STATE.json", "ai/HANDOFF.md",
        "ai/README.md", "ai/projects.json", "ai/check_hub.py",
        "browser_filter_lists", "integrations/browser-filters/source/s",
        ".github/workflows/ai-hub.yml",
    ),
    "r20942097-hue/s": (
        "AGENTS.md", "ai/PROJECT_STATE.json", "ai/HANDOFF.md",
        "filter-profiles.json", "scripts/validate_lists.py",
        "scripts/generate_lists.py", "ad.txt", "tracking.txt",
        "v2/ad.txt", "v2/tracking.txt", "v2/strict.txt",
        ".github/workflows/japanese-text-softener.yml",
    ),
}
GATES = ("P0", "PUBLICATION_HOLD", "NO_NEW_INTERNAL_PUSH")


def tracked_archives(root: Path) -> tuple[str, list[str]]:
    """Return (PASS|FAIL|NOT_RUN, archive paths). Never follow archive contents."""
    if not (root / ".git").exists():
        return "NOT_RUN", []
    try:
        proc = subprocess.run(
            ["git", "-C", str(root), "ls-files", "-z"],
            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
            timeout=15, check=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        return "NOT_RUN", []
    if proc.returncode != 0:
        return "NOT_RUN", []
    paths = [p.decode("utf-8", errors="replace") for p in proc.stdout.split(b"\0") if p]
    bad = sorted(p for p in paths if p.casefold().endswith((".zip", ".7z")))
    return ("FAIL" if bad else "PASS"), bad


def audit(root: Path) -> dict:
    """Inspect a checked-out repo without mutating it or using the network."""
    root = Path(root).resolve()
    checks: list[dict[str, str]] = []

    def record(name: str, status: str, detail: str) -> None:
        checks.append({"name": name, "status": status, "detail": detail})

    record("python", "PASS" if sys.version_info >= (3, 11) else "FAIL",
           f"{sys.version_info.major}.{sys.version_info.minor}.{sys.version_info.micro} (minimum 3.11)")
    state_path = root / "ai/PROJECT_STATE.json"
    state = None
    if not state_path.is_file() or state_path.is_symlink():
        record("state", "FAIL", "ai/PROJECT_STATE.json is missing or a symlink")
    else:
        try:
            state = json.loads(state_path.read_text(encoding="utf-8"))
            if not isinstance(state, dict):
                raise ValueError("state must be a JSON object")
        except (OSError, ValueError, UnicodeError) as exc:
            record("state", "FAIL", f"invalid JSON ({type(exc).__name__})")
            state = None

    repo = state.get("repository") if state is not None else None
    if repo not in REQUIRED:
        record("repository", "FAIL", "unknown or unreadable repository identity")
    else:
        record("repository", "PASS", repo)
    if state is not None:
        record("state-schema", "PASS" if state.get("schema") == "project-state/v1" else "FAIL",
               "project-state/v1 expected")
        gates = state.get("gates")
        if not isinstance(gates, dict):
            record("governance", "FAIL", "gates object missing")
        else:
            inactive = [g for g in GATES if not str(gates.get(g, "")).startswith("active")]
            record("governance", "FAIL" if inactive else "PASS",
                   "inactive or missing: " + ", ".join(inactive) if inactive else "P0/publication hold/main push guard active")

    if repo in REQUIRED:
        for rel in REQUIRED[repo]:
            path = root / rel
            valid = path.exists() and not path.is_symlink()
            record("required:" + rel, "PASS" if valid else "FAIL",
                   "present" if valid else "missing or symlink")
    archive_status, archives = tracked_archives(root)
    record("tracked-archives", archive_status,
           "tracked ZIP/7z: " + ", ".join(archives[:8]) if archives else
           ("no tracked ZIP/7z" if archive_status == "PASS" else "git checkout unavailable; not checked"))
    record("product-e2e", "NOT_RUN", "real browser, Windows device, sign-in and live service tests are separate gates")
    record("publication", "NOT_RUN", "no release, merge, publishing or subscription operations performed")
    summary = {k: sum(1 for c in checks if c["status"] == k)
               for k in ("PASS", "FAIL", "NOT_RUN")}
    return {"schema": "gpt1-repository-preflight/v1", "repository": repo or "UNKNOWN",
            "result": "FAIL" if summary["FAIL"] else "PASS", "scope": "structural/offline-only",
            "summary": summary, "checks": checks}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument("--json", action="store_true", help="emit machine-readable result")
    args = parser.parse_args(argv)
    result = audit(args.root)
    if args.json:
        print(json.dumps(result, ensure_ascii=False, indent=2))
    else:
        for check in result["checks"]:
            print(f"{check['status']:7} {check['name']}: {check['detail']}")
        print(f"Overall: {result['result']} (structural/offline only)")
    return 1 if result["result"] == "FAIL" else 0


if __name__ == "__main__":
    raise SystemExit(main())
