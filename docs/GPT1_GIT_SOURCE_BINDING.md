# GPT1 v2.1 — Git committed-source ↔ candidate ZIP byte binding

Scope: local Git object **content equality only**, with an independently reviewed SHA-256 manifest. **NOT release approval or upstream source authentication.**

## Two independent boundaries

1. `source_zip_parity.py` requires a complete 1:1 mapping of every regular ZIP member to a named source file, and checks the artifact SHA-256 and each source/member SHA-256. The claim file remains a separate, reviewable input; it cannot be self-authenticated.
2. `git_source_binding.py` checks that the source root is a Git checkout root; `HEAD` matches the manifest's required 40-digit `source_commit`; the entire tracked/untracked working tree is clean; and the mapping's Git tree entries are ordinary committed file blobs. Every committed blob's raw SHA-256 must match the source/ZIP claim.

Git origin URL is checked for an **expected configured repository** (`r20942097-hue/faaff` or `r20942097-hue/s`), but Git config is locally mutable. A matching origin string is NOT proof that those bytes were fetched from authenticated GitHub, nor proof of a trustworthy author.

## How to run (separate checkout and artifact files)

```bash
python ai/git_source_binding.py \
  --claim /trusted/evidence/claim.json \
  --source-root /path/to/clean/repository \
  --artifact /trusted/candidates/candidate.zip \
  --expected-repo r20942097-hue/faaff \
  --json
```

For `s` change the Python path to `scripts/git_source_binding.py` and the repository argument to `r20942097-hue/s`. The claim file uses the existing `gpt1-source-zip-parity/v1` schema and **must** contain the intended source commit SHA (not null).

## Policy

- Fail closed if the ZIP structure/digest is wrong, any source mapping is missing, extra files exist, source is symlinked, Git checkout has local modifications or untracked files, HEAD differs, origin is unexpected, a committed blob differs, or Git cannot be run.
- SHA-256 of the raw `git cat-file blob` contents must match the expected source/member SHA; Git working-tree filters are not accepted as proof of raw committed bytes when the content differs.
- The verifier is read-only; it does not use `git fetch`, execute Git hooks, change source directories, push commits, generate signatures or publish ZIPs.
- Only SHA-1 Git object-format repositories (40-digit object identifiers) supported; 16 MiB per raw blob, up to 1,000 mapped files. Limits are conservative, not a general-purpose large-media build solution.
- The ZIP may contain nested ZIPs as opaque copied bytes; use the specialized ZIP safety gate separately to validate nested archives and compression bombs.
- `MATCH` means **byte equality under a locally configured origin and checked-out commit**. It does not authenticate that the commit belongs to GitHub, attest the builder workflow, or verify browser behavior.
- All outcomes keep `CANDIDATE_NO_GO` and report `signed_attestation=NOT_RUN`, `upstream_repository_authenticated=NOT_RUN` and `live_browser_e2e=NOT_RUN`.

## CI verification

```bash
python -m unittest discover -s ai/tests -p test_git_source_binding.py -v
# s variant
python -m unittest discover -s tests -p test_git_source_binding.py -v
```

CI uses temporary Git repositories created for offline regression fixtures; it never clones or commits the user's private product ZIPs. Real product source authenticity and release evidence require a later independent GitHub API/cryptographic verification gate.

References:
- https://git-scm.com/docs/git-ls-tree
- https://git-scm.com/docs/git-cat-file
- https://docs.github.com/en/actions/concepts/security/artifact-attestations
- https://slsa.dev/spec/v1.0/provenance

Safety: `main`, public subscriptions, release governance and production settings remain unchanged. Both PRs are Draft.
