"""Offline GitHub Actions workflow safety guard (structural policy, not a YAML parser).

This does not authenticate action publishers or replace gh actions-lock --verify.
Python 3.11+, no dependencies, network access, file edits or credential use.
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

ACTION = re.compile(r"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+(?:/[A-Za-z0-9_.-]+)*@[0-9a-f]{40}$")
USE = re.compile(r"^\s*(?:-\s*)?uses:\s*([^\s#]+)")
ROOT_PERMISSIONS = re.compile(r"^permissions:\s*$")
BAD_EVENTS = re.compile(r"(?<![A-Za-z_])(?:pull_request_target|workflow_run)(?![A-Za-z_])")
REPO = {"r20942097-hue/faaff", "r20942097-hue/s"}
CODEQL = ".github/workflows/codeql.yml"


def _is_checkout_step_safe(lines: list[str], position: int) -> bool:
    base = len(lines[position]) - len(lines[position].lstrip(" "))
    for line in lines[position + 1:]:
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        indent = len(line) - len(line.lstrip(" "))
        if indent < base or (indent == base and re.match(r"^\s*(?:-\s|name:|run:|uses:)", line)):
            break
        if re.match(r"^\s*persist-credentials:\s*(?:false|['\"]false['\"])\s*(?:#.*)?$", line):
            return True
    return False


def audit_workflow(path: Path, relative: str) -> dict:
    problems: list[str] = []
    actions: list[str] = []
    if path.is_symlink() or not path.is_file():
        return {"path": relative, "result": "FAIL", "errors": ["missing or symlinked workflow"], "actions": []}
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except (OSError, UnicodeError):
        return {"path": relative, "result": "FAIL", "errors": ["unreadable workflow"], "actions": []}

    if not lines:
        problems.append("empty workflow")
    content = [line.split("#", 1)[0] for line in lines]
    if any(BAD_EVENTS.search(line) for line in content):
        problems.append("privileged trigger requires separate security review")
    if any(re.match(r"^permissions:\s*(?!$)", line) for line in content):
        problems.append("workflow permissions must be an explicit mapping")
    roots = [i for i, line in enumerate(lines) if ROOT_PERMISSIONS.fullmatch(line)]
    if len(roots) != 1:
        problems.append("expected exactly one top-level permissions mapping")
    else:
        i = roots[0] + 1
        granted: dict[str, str] = {}
        while i < len(lines):
            line = lines[i]
            if line.strip() and not line[0].isspace():
                break
            m = re.match(r"^\s{2}([a-z-]+):\s*(\S+)\s*(?:#.*)?$", line)
            if m:
                key, value = m.groups()
                if key in granted:
                    problems.append("duplicate workflow permission " + key)
                granted[key] = value
            i += 1
        wanted = {"contents": "read"}
        if relative == CODEQL:
            wanted["security-events"] = "write"
        if granted != wanted:
            problems.append("workflow permissions deviate from reviewed least-privilege baseline")
    for i, line in enumerate(lines):
        if re.match(r"^\s+permissions:\s*", line) and not line.lstrip().startswith("#"):
            problems.append("job-level permissions override requires review")
        match = USE.match(line)
        if match is None or line.lstrip().startswith("#"):
            continue
        action = match.group(1)
        actions.append(action)
        if not ACTION.fullmatch(action):
            problems.append(f"unreviewed/non-SHA uses reference: {action}")
        if action.startswith("actions/checkout@") and not _is_checkout_step_safe(lines, i):
            problems.append("checkout without persist-credentials: false")
    return {"path": relative, "result": "FAIL" if problems else "PASS",
            "errors": sorted(set(problems)), "actions": actions}


def audit(root: Path, expected_repository: str) -> dict:
    if expected_repository not in REPO:
        return {"status": "FAIL", "errors": ["unrecognized repository"], "workflows": []}
    root = Path(root).resolve()
    directory = root / ".github/workflows"
    if not directory.is_dir() or directory.is_symlink():
        return {"status": "FAIL", "errors": ["workflow directory missing or linked"], "workflows": []}
    paths = sorted([*directory.glob("*.yml"), *directory.glob("*.yaml")], key=lambda p: p.name)
    if not paths:
        return {"status": "FAIL", "errors": ["no GitHub workflow files"], "workflows": []}
    results = [audit_workflow(path, ".github/workflows/" + path.name) for path in paths]
    failures = sum(r["result"] == "FAIL" for r in results)
    return {"schema": "gpt1-workflow-supply-chain-guard/v1",
            "status": "FAIL" if failures else "PASS",
            "scope": "offline workflow SHA/permissions/trigger review only (not YAML or lock authenticity)",
            "repository": expected_repository,
            "workflows_checked": len(results),
            "external_uses_checked": sum(len(r["actions"]) for r in results),
            "failures": failures, "workflows": results,
            "lockfile_authenticated": "NOT_RUN", "release_approval": "NOT_RUN"}


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument("--expected-repository", required=True, choices=sorted(REPO))
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args(argv)
    result = audit(args.root, args.expected_repository)
    if args.json:
        print(json.dumps(result, ensure_ascii=False, indent=2))
    else:
        print(result["status"], result.get("workflows_checked", 0), "workflows")
        for record in result["workflows"]:
            for error in record["errors"]:
                print("ERROR", record["path"], error)
    return 0 if result["status"] == "PASS" else 1


if __name__ == "__main__":
    sys.exit(main())
