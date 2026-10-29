"""Verify GitHub artifact attestation against strict expected build identity.

Uses GitHub CLI cryptographic verification (not homegrown signature checking).
Read-only. Never publishes, signs, uploads, or approves the artifact.
A verified attestation is NOT a safe-software or release-GO determination.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import subprocess
import sys
from pathlib import Path

ALLOWED_REPOS = frozenset({"r20942097-hue/faaff", "r20942097-hue/s"})
SHA40 = re.compile(r"[0-9a-f]{40}\Z")
SHA256 = re.compile(r"[0-9a-f]{64}\Z")
WORKFLOW = re.compile(r"\.github/workflows/[a-zA-Z0-9_.-]+\.ya?ml\Z")
REF = re.compile(r"refs/(?:heads|tags)/[A-Za-z0-9_./-]+\Z")
PREDICATE = "https://slsa.dev/provenance/v1"
MIN_GH_VERSION = (2, 102, 0)  # GHSA-wjmr-j3rp-mh2g and GHSA-4mq3-hpgx-9cx8
GH_VERSION = re.compile(r"^gh version ([0-9]+)\.([0-9]+)\.([0-9]+)(?:\s|$)")
MAX_ARTIFACT_SIZE = 1024 * 1024 * 1024
MAX_JSON_BYTES = 4 * 1024 * 1024


def _failure(reason: str, status: str = "FAIL") -> dict:
    return {"schema": "gpt1-attestation-verification/v1", "status": status,
            "decision": "CANDIDATE_NO_GO", "errors": [reason],
            "cryptographic_verification": "NOT_VERIFIED",
            "git_checkout_verified": "NOT_RUN", "runtime_e2e": "NOT_RUN"}


def _sha256_file(path: Path) -> str:
    if path.is_symlink() or not path.is_file() or path.stat().st_size > MAX_ARTIFACT_SIZE:
        raise ValueError("artifact missing, linked or oversized")
    digest = hashlib.sha256()
    size = 0
    with path.open("rb") as stream:
        while chunk := stream.read(256 * 1024):
            size += len(chunk)
            if size > MAX_ARTIFACT_SIZE:
                raise ValueError("artifact size limit exceeded")
            digest.update(chunk)
    return digest.hexdigest()


def _invoke(args: list[str]) -> str:
    # No shell, no token in arguments, bounded command duration and output.
    r = subprocess.run(args, capture_output=True, text=True, timeout=90, check=False)
    if r.returncode != 0:
        raise RuntimeError("GitHub CLI returned nonzero status")
    if len(r.stdout.encode("utf-8")) > MAX_JSON_BYTES:
        raise ValueError("CLI output too large")
    return r.stdout


def require_safe_gh() -> str:
    """Reject GitHub CLI releases with vulnerable source-ref or signer matching."""
    line = _invoke(["gh", "--version"])
    match = GH_VERSION.match(line)
    if match is None:
        raise ValueError("unrecognized GitHub CLI version")
    version = tuple(int(p) for p in match.groups())
    if version < MIN_GH_VERSION:
        raise ValueError("GitHub CLI predates fixed attestation verification")
    return ".".join(match.groups())


def verify(artifact: Path, repo: str, workflow: str, source_sha: str,
           source_ref: str, expected_sha256: str, signer_sha: str) -> dict:
    """Validate arguments first, then cryptographically verify with GitHub CLI."""
    if not isinstance(repo, str) or repo not in ALLOWED_REPOS:
        return _failure("repository is not allowlisted", "INVALID")
    if (not isinstance(workflow, str) or not WORKFLOW.fullmatch(workflow)
            or not isinstance(source_sha, str) or not SHA40.fullmatch(source_sha)
            or not isinstance(source_ref, str) or not REF.fullmatch(source_ref)
            or ".." in source_ref.split("/")
            or not isinstance(expected_sha256, str) or not SHA256.fullmatch(expected_sha256)
            or not isinstance(signer_sha, str) or not SHA40.fullmatch(signer_sha)
            or "//" in source_ref or source_ref.endswith("/")):
        return _failure("invalid signer workflow, source identity, ref or digest", "INVALID")
    try:
        actual = _sha256_file(Path(artifact))
    except (OSError, ValueError):
        return _failure("artifact unreadable or unsafe")
    if actual != expected_sha256:
        return _failure("artifact SHA-256 differs from independent expected digest")
    signer = repo + "/" + workflow
    args = ["gh", "attestation", "verify", str(artifact),
            "--repo", repo, "--signer-workflow", signer,
            "--source-digest", source_sha, "--source-ref", source_ref,
            "--signer-digest", signer_sha,
            "--cert-oidc-issuer", "https://token.actions.githubusercontent.com",
            "--predicate-type", PREDICATE, "--deny-self-hosted-runners",
            "--limit", "5", "--format", "json"]
    try:
        cli_version = require_safe_gh()
        verified_output = json.loads(_invoke(args))
        if not isinstance(verified_output, list) or not (1 <= len(verified_output) <= 5):
            raise ValueError("no verified attestations")
        id_output = _invoke(["gh", "api", f"repos/{repo}", "--jq", ".id"]).strip()
        if not id_output.isdecimal() or int(id_output) <= 0:
            raise ValueError("GitHub repository ID unavailable")
        current_id = int(id_output)
        for entry in verified_output:
            if not isinstance(entry, dict):
                raise ValueError("malformed verification result")
            result = entry.get("verificationResult")
            if not isinstance(result, dict):
                raise ValueError("missing verificationResult")
            timestamps = result.get("verifiedTimestamps")
            if not isinstance(timestamps, list) or not timestamps or not all(
                isinstance(t, dict) and t for t in timestamps
            ):
                raise ValueError("no verified signed timestamps")
            signature = result.get("signature")
            cert = signature.get("certificate") if isinstance(signature, dict) else None
            repo_id = cert.get("sourceRepositoryIdentifier") if isinstance(cert, dict) else None
            if isinstance(repo_id, bool) or str(repo_id) != str(current_id):
                raise ValueError("signing repository ID differs from current GitHub repository")
            statement = result.get("statement")
            if not isinstance(statement, dict) or statement.get("predicateType") != PREDICATE:
                raise ValueError("missing SLSA v1 statement")
            subjects = statement.get("subject")
            if (not isinstance(subjects, list) or not any(
                isinstance(sub, dict) and isinstance(sub.get("digest"), dict)
                and sub["digest"].get("sha256") == actual for sub in subjects
            )):
                raise ValueError("signed subject digest mismatch")
    except (subprocess.TimeoutExpired, FileNotFoundError, OSError, RuntimeError,
            ValueError, TypeError, json.JSONDecodeError):
        # Do not echo CLI stderr or potentially sensitive certificate/claim metadata.
        return _failure("GitHub CLI verification, current repository ID or SLSA policy failed")
    return {"schema": "gpt1-attestation-verification/v1", "status": "VERIFIED",
            "decision": "CANDIDATE_NO_GO",
            "scope": "gh-verified GitHub signature + current repo ID + SLSA subject policy",
            "artifact_sha256": actual, "repository": repo,
            "signer_workflow": signer, "signer_digest": signer_sha,
            "source_digest": source_sha,
            "source_ref": source_ref, "attestations_checked": len(verified_output),
            "gh_cli_version": cli_version,
            "cryptographic_verification": "GH_CLI_VERIFIED",
            "git_checkout_verified": "NOT_RUN", "runtime_e2e": "NOT_RUN",
            "errors": []}


def main(argv=None) -> int:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--artifact", type=Path, required=True)
    p.add_argument("--repo", choices=sorted(ALLOWED_REPOS), required=True)
    p.add_argument("--signer-workflow", required=True, help="relative .github/workflows/*.yml path")
    p.add_argument("--signer-sha", required=True, help="expected signing workflow commit (40 lowercase hex)")
    p.add_argument("--source-sha", required=True, help="expected source commit (40 lowercase hex)")
    p.add_argument("--source-ref", required=True, help="expected GitHub source ref")
    p.add_argument("--sha256", required=True, help="independently obtained artifact SHA-256")
    p.add_argument("--json", action="store_true")
    a = p.parse_args(argv)
    result = verify(a.artifact, a.repo, a.signer_workflow, a.source_sha, a.source_ref, a.sha256, a.signer_sha)
    if a.json:
        print(json.dumps(result, ensure_ascii=False, indent=2))
    else:
        print(result["status"], result["decision"])
        for err in result["errors"]:
            print("ERROR:", err)
    return 0 if result["status"] == "VERIFIED" else 1


if __name__ == "__main__":
    sys.exit(main())
