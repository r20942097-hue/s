"""Read-only live GitHub commit/tree identity check for a checked-out CI HEAD.

This confirms that local Git HEAD and root tree equal a commit object from a
specific immutable GitHub repository ID. It does not prove signed authorship,
reproducible builds, ZIP provenance, or release authorization.
"""
from __future__ import annotations
import argparse
import json
import re
import subprocess
import sys
from pathlib import Path

REPOSITORIES = {"r20942097-hue/faaff": 1389881401,
                "r20942097-hue/s": 1389881111}
SHA = re.compile(r"[0-9a-f]{40}\Z")
MAX_RESPONSE_BYTES = 4096


def _run(command: list[str], timeout: int = 30) -> str:
    # No shell expansion, no credentials printed; fail closed on unexpected output.
    result = subprocess.run(command, capture_output=True, timeout=timeout, check=False)
    if result.returncode != 0 or len(result.stdout) > MAX_RESPONSE_BYTES:
        raise ValueError("Git or GitHub API unavailable/oversized response")
    return result.stdout.decode("utf-8", "strict").strip()


def _api(endpoint: str, jq: str) -> object:
    if (not endpoint.startswith("repos/") or "//" in endpoint
            or ".." in endpoint or any(ch.isspace() for ch in endpoint)):
        raise ValueError("unsafe GitHub API endpoint")
    # Explicitly pin the GitHub.com API rather than trusting GH_HOST / GH_REPO.
    response = _run(["gh", "api", "--hostname", "github.com",
                     endpoint, "--jq", jq])
    return json.loads(response)


def check(root: Path, repo: str, expected_commit: str) -> dict:
    errors: list[str] = []
    details = {"schema": "gpt1-live-github-commit-identity/v1",
               "status": "FAIL", "decision": "CANDIDATE_NO_GO",
               "repository": repo if isinstance(repo, str) else None,
               "commit": expected_commit if isinstance(expected_commit, str) else None,
               "live_github_api": "NOT_VERIFIED",
               "git_commit_signature": "NOT_EVALUATED",
               "product_zip_provenance": "NOT_RUN",
               "browser_e2e": "NOT_RUN", "errors": errors}
    if not isinstance(repo, str) or repo not in REPOSITORIES:
        errors.append("repository not allowlisted")
        return details
    if not isinstance(expected_commit, str) or SHA.fullmatch(expected_commit) is None:
        errors.append("invalid expected 40-digit commit SHA")
        return details
    root = Path(root)
    if root.is_symlink() or not root.is_dir():
        errors.append("checkout missing or symlinked")
        return details
    try:
        root = root.resolve(strict=True)
        top = Path(_run(["git", "-C", str(root), "rev-parse", "--show-toplevel"])).resolve(strict=True)
        if root != top:
            raise ValueError("checkout root differs from Git worktree root")
        actual_commit = _run(["git", "-C", str(root), "rev-parse", "--verify", "HEAD"])
        local_tree = _run(["git", "-C", str(root), "rev-parse", "HEAD^{tree}"])
        if actual_commit != expected_commit or SHA.fullmatch(local_tree) is None:
            raise ValueError("local HEAD/tree does not match claim")
        identity = _api(f"repos/{repo}", "{id, full_name}")
        if (not isinstance(identity, dict) or isinstance(identity.get("id"), bool)
                or identity.get("id") != REPOSITORIES[repo]
                or identity.get("full_name") != repo):
            raise ValueError("immutable GitHub repository ID/name mismatch")
        remote = _api(f"repos/{repo}/git/commits/{expected_commit}",
                      "{sha, tree: .tree.sha, verified: .verification.verified}")
        if (not isinstance(remote, dict) or remote.get("sha") != expected_commit
                or remote.get("tree") != local_tree):
            raise ValueError("remote commit/tree not equal to local Git objects")
        # Report GitHub's signature assessment distinctly, but do not turn a
        # (possibly unsigned) commit into a product or release success.
        if isinstance(remote.get("verified"), bool):
            details["git_commit_signature"] = ("GITHUB_VERIFIED" if remote["verified"]
                                               else "NOT_GITHUB_VERIFIED")
        details["status"] = "MATCH"
        details["live_github_api"] = "REPOSITORY_ID_AND_COMMIT_TREE_MATCH"
        details["local_tree"] = local_tree
    except (OSError, ValueError, KeyError, TypeError, UnicodeError, json.JSONDecodeError,
            subprocess.TimeoutExpired, FileNotFoundError):
        errors.append("Git checkout or live GitHub API identity/tree verification failed")
    return details


def main(argv=None) -> int:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--root", type=Path, default=Path.cwd())
    p.add_argument("--repo", required=True, choices=sorted(REPOSITORIES))
    p.add_argument("--commit", required=True)
    p.add_argument("--json", action="store_true")
    a = p.parse_args(argv)
    result = check(a.root, a.repo, a.commit)
    if a.json:
        print(json.dumps(result, ensure_ascii=False, indent=2))
    else:
        print(result["status"], result["live_github_api"], result["errors"])
    return 0 if result["status"] == "MATCH" else 1


if __name__ == "__main__":
    sys.exit(main())
