# GPT1 v2.0 — Signed Artifact Attestation Verification Gate

Status: **CANDIDATE / NO_GO**. This is a read-only verification capability; it does not attest, sign, upload, release, or certify any product.

## Purpose and verified source

- `gh attestation verify` checks cryptographic signatures against the current artifact file and GitHub repository; the verifier specifies the expected signer workflow, source ref and source digest.
- The script independently compares the on-disk artifact to an **externally reviewed** SHA-256, and compares the verified certificate's immutable repository identifier to the **current** repository ID returned by `gh api repos/OWNER/REPO`.
- `gh` is required at real verification time. Unit tests substitute synthetic subprocess responses; synthetic CLI output is not a signature.
- No arbitrary attestation JSON or unsigned metadata is accepted as proof. A successful CLI exit alone is not enough: `verificationResult.signature.certificate.sourceRepositoryIdentifier`, the SLSA predicate type, and a subject SHA-256 must match.
- The verification command does NOT use `--bundle` so GitHub's API fetch checks the repository's current name/identity rather than only historic names inside a downloaded bundle.

## Usage

From an isolated trusted runner with GitHub CLI and read-only GitHub API access:

```bash
python ai/attestation_verifier.py \
  --artifact /path/to/release-artifact.zip \
  --repo r20942097-hue/faaff \
  --signer-workflow .github/workflows/ACTUAL_SIGNING_WORKFLOW.yml \
  --source-sha FULL40CHAR_GIT_COMMIT_SHA \
  --source-ref refs/heads/main \
  --sha256 INDEPENDENTLY_REVIEWED_64CHAR_SHA256 \
  --json
```

For `s`, use `python scripts/attestation_verifier.py`, `--repo r20942097-hue/s`, and its **actual** signing workflow. The example signer workflow above is a placeholder, not an existing or approved release job.

## Controls

- Repository allowlist is limited to `r20942097-hue/faaff` and `r20942097-hue/s`. The signer must be an explicitly supplied `.github/workflows/*.yml` within the same repository.
- Source SHA is a full 40-character lowercase hex Git commit, source ref is an explicit GitHub `refs/heads/...` or `refs/tags/...`, and artifact SHA-256 must match independent expected evidence.
- GitHub CLI runs with `--repo`, `--signer-workflow`, `--source-digest`, `--source-ref`, `--deny-self-hosted-runners`, `--predicate-type https://slsa.dev/provenance/v1`, and `--format json`.
- No shell invocation, no command printing of credentials, 90-second subprocess timeout, 1 GiB input cap and 4 MiB verification JSON cap.
- Unavailable CLI, no attestations, malformed data, subject mismatch, repository rename collision, or an untrusted signed-workflow identity returns FAIL.
- `VERIFIED` describes a matching **signed provenance claim** only. It does NOT attest source quality, build reproducibility, complete dependencies, absence of malicious code, E2E/browser functionality, or permission for publication.

## Testing

```bash
python -m unittest discover -s ai/tests -p test_attestation_verifier.py -v
gh attestation verify --help
```

Use `tests/` instead of `ai/tests/` for repository `s`. CI tests synthetic verifier responses and checks CLI availability on Ubuntu and Windows, Python 3.11/3.14. It does **not** produce a signed attestation or call the verification command against a real release.

## Future release gate (owner approval required)

1. Approve an actual product build and identify a trusted builder workflow, source SHA and release candidate.
2. Create provenance from the **trusted** builder with narrowly scoped `id-token: write` and `attestations: write` permission, under a separate reviewed PR.
3. Verify the produced artifact from a distinct job with expected SHA, signed provenance policy, current repo ID and GitHub-hosted runner requirement.
4. Review the producer's workflow and SLSA predicate separately; attestation signing alone does not make the software secure.

References:
- https://cli.github.com/manual/gh_attestation_verify
- https://docs.github.com/en/actions/concepts/security/artifact-attestations
- https://docs.github.com/en/actions/how-tos/secure-your-work/use-artifact-attestations/verify-attestations-offline
- https://slsa.dev/spec/v1.0/provenance

Governance: both original Draft PRs remain unmerged; main, publication, subscriptions, source binaries and repository rules remain unchanged.
