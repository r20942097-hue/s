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
REQUIRED_DIRS = {
    "r20942097-hue/faaff": frozenset((
        "browser_filter_lists", "integrations/browser-filters/source/s",
    )),
    "r20942097-hue/s": frozenset(),
}


def safe_required_path(root: Path, relative: str, expect_dir: bool) -> bool:
    """Reject missing paths, wrong kinds, and symbolic links in any component."""
    path = root
    for component in Path(relative).parts:
        path = path / component
        if path.is_symlink():
            return False
    return path.is_dir() if expect_dir else path.is_file()


def active_gate(value: object) -> bool:
    """Only accept an explicit active state, not 'actively disabled' etc."""
    return isinstance(value, str) and (value == "active" or value.startswith("active:"))


def tracked_archives(root: Path) -> tuple[str, list[str]]:
    """Return (PASS|FAIL|NOT_RUN, archive paths). Never follow archive contents."""
    metadata = root / ".git"
    # A Git worktree has a regular .git file, a normal clone has a directory.
    if metadata.is_symlink() or not (metadata.is_file() or metadata.is_dir()):
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


def audit(root: Path, expected_repo: str | None = None, require_git: bool = False) -> dict:
    """Inspect a checked-out repo without mutating it or using the network."""
    root = Path(root).resolve()
    checks: list[dict[str, str]] = []

    def record(name: str, status: str, detail: str) -> None:
        checks.append({"name": name, "status": status, "detail": detail})

    record("python", "PASS" if sys.version_info >= (3, 11) else "FAIL",
           f"{sys.version_info.major}.{sys.version_info.minor}.{sys.version_info.micro} (minimum 3.11)")
    state_path = root / "ai/PROJECT_STATE.json"
    state = None
    if not safe_required_path(root, "ai/PROJECT_STATE.json", False):
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
    if not isinstance(repo, str) or repo not in REQUIRED:
        record("repository", "FAIL", "unknown or unreadable repository identity")
    else:
        record("repository", "PASS", repo)
    if expected_repo is not None:
        record("identity", "PASS" if expected_repo == repo and expected_repo in REQUIRED else "FAIL",
               "matches expected repository" if expected_repo == repo and isinstance(repo, str) and repo in REQUIRED else "repository identity mismatch")
    if state is not None:
        record("state-schema", "PASS" if state.get("schema") == "project-state/v1" else "FAIL",
               "project-state/v1 expected")
        gates = state.get("gates")
        if not isinstance(gates, dict):
            record("governance", "FAIL", "gates object missing")
        else:
            inactive = [g for g in GATES if not active_gate(gates.get(g))]
            record("governance", "FAIL" if inactive else "PASS",
                   "inactive or missing: " + ", ".join(inactive) if inactive else "P0/publication hold/main push guard active")

    if isinstance(repo, str) and repo in REQUIRED:
        for rel in REQUIRED[repo]:
            expect_dir = rel in REQUIRED_DIRS[repo]
            valid = safe_required_path(root, rel, expect_dir)
            record("required:" + rel, "PASS" if valid else "FAIL",
                   ("directory" if expect_dir else "file") + (" present" if valid else " missing, wrong type or symlink"))
    archive_status, archives = tracked_archives(root)
    record("tracked-archives", "FAIL" if require_git and archive_status == "NOT_RUN" else archive_status,
           "tracked ZIP/7z: " + ", ".join(archives[:8]) if archives else
           ("no tracked ZIP/7z" if archive_status == "PASS" else "git checkout unavailable; not checked"))
    record("product-e2e", "NOT_RUN", "real browser, Windows device, sign-in and live service tests are separate gates")
    record("publication", "NOT_RUN", "no release, merge, publishing or subscription operations performed")
    summary = {k: sum(1 for c in checks if c["status"] == k)
               for k in ("PASS", "FAIL", "NOT_RUN")}
    result = "FAIL" if summary["FAIL"] else ("PARTIAL" if archive_status == "NOT_RUN" else "PASS")
    return {"schema": "gpt1-repository-preflight/v2", "repository": repo if isinstance(repo, str) else "UNKNOWN",
            "result": result, "scope": "structural/offline-only",
            "summary": summary, "checks": checks}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument("--json", action="store_true", help="emit machine-readable result")
    parser.add_argument("--expected-repository", choices=sorted(REQUIRED), help="assert repository identity")
    parser.add_argument("--require-git", action="store_true", help="FAIL if Git-tracked archives cannot be audited")
    args = parser.parse_args(argv)
    result = audit(args.root, expected_repo=args.expected_repository, require_git=args.require_git)
    if args.json:
        print(json.dumps(result, ensure_ascii=False, indent=2))
    else:
        for check in result["checks"]:
            print(f"{check['status']:7} {check['name']}: {check['detail']}")
        print(f"Overall: {result['result']} (structural/offline only)")
    return {"PASS": 0, "FAIL": 1, "PARTIAL": 2}[result["result"]]


if __name__ == "__main__":
    raise SystemExit(main())
