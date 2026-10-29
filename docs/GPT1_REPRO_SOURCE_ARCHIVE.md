# GPT1 v2.3 — Reproducible source archive gate

Purpose: create or independently verify an **exact-copy source ZIP** from immutable Git blobs. This is not a generalized build system, signing operation, binary compiler, or release approval.

## Scope and canonical form

- Source bytes come from `git ls-tree` and `git cat-file blob` for one pinned, clean Git checkout; content is NOT copied from potentially transformed working-tree files.
- Zip member order: sorted by UTF-8 path bytes. Timestamp fixed to `1980-01-01 00:00:00`. Mode is Unix `0644` for all regular members. Zip compression is `ZIP_STORED` to avoid zlib cross-version variability.
- A conservative allowlist rejects absolute/traversal/Windows reserved names, duplicate or Unicode/NFC case-colliding source/member paths, Git symlinks and gitlinks, missing Git files, modified or untracked worktree state.
- Budgets: maximum 128 mapped files, 4 MiB per Git blob, 32 MiB total payload, 128 KiB recipe. This targets small extension/source bundles, **not** media files or compiled product binaries.
- Existing release gates remain `CANDIDATE_NO_GO`. Source checkout remote/publisher ID, signed attestation, review, malware/runtime tests and actual product builds are NOT_VERIFIED by this feature.

## Explicit input recipe

Review the file mappings and pinned Git SHA separately; the recipe is **not** self-authenticating.

```json
{
  "schema": "gpt1-repro-source-zip/v1",
  "source_commit": "0123456789abcdef0123456789abcdef01234567",
  "files": [
    {"source": "src/script.js", "member": "extension/script.js"},
    {"source": "src/manifest.json", "member": "extension/manifest.json"}
  ]
}
```

Use the SHA of an **actual independently reviewed source commit** instead of the placeholder above. The original Git checkout must be completely clean, and the recipe should be stored **outside the checkout**.

## Build one new candidate ZIP (never overwrite)

```bash
python ai/repro_source_archive.py --root /path/to/clean/git-checkout \
    --recipe /outside/approved-recipe.json --output /outside/new-candidate.zip --json
```

For repository `s`, change `ai/` to `scripts/`. The write mode uses exclusive creation, and refuses any output located inside the source repository.

## Rebuild and compare a separately reviewed candidate (read only)

```bash
python ai/repro_source_archive.py --root /path/to/clean/git-checkout \
    --recipe /outside/approved-recipe.json --candidate /outside/new-candidate.zip \
    --expected-sha256 <INDEPENDENT_64_CHARACTER_SHA256> --json
```

`REPRODUCIBLE` requires byte-for-byte agreement, not merely an equal file listing, and also a matching independent expected ZIP SHA-256. This verifies one **specified canonical packaging recipe**, not arbitrary existing ZIP formats. An existing product ZIP with other metadata, directory entries, zlib compression or custom build transformations may legitimately fail even if source code is semantically equal.

## Tests and CI

- `python -m unittest discover -s ai/tests -p test_repro_source_archive.py -v` (use `tests/` for `s`).
- 31 checks per repository include real local Git commits, byte tampering, traversal, Windows names, NFC/case collisions, modified worktrees, overwrite prevention and a **fixed SHA-256 golden ZIP fixture**.
- Linux/Windows × Python 3.11/3.14 CI executes these tests and compares the canonical fixture digest across platforms.
- This gate does not produce attestations for synthetic tests. GitHub explicitly discourages signing frequent test artifacts; use `actions/attest` only in separately reviewed approved release workflows.

References:
- https://docs.github.com/en/actions/concepts/security/artifact-attestations
- https://github.com/actions/attest
- https://git-scm.com/docs/git-cat-file
- https://docs.python.org/3/library/zipfile.html

Governance: both Draft PRs stay unmerged; `main`, public filter distribution and product releases remain unchanged.
