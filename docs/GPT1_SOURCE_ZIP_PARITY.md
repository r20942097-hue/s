# GPT1 — Source to ZIP Byte Parity (v1.9)

## Intended use

Compare **every ordinary file** in a candidate ZIP against one specifically mapped source file.
The scanner never extracts or executes the ZIP and does not write to source files.
Use this for **byte-for-byte copied-source packages only**. Bundled, transpiled, obfuscated, compressed-asset or compiled outputs require a deterministic rebuild and a separate source-to-build provenance process.

## Example claim file

Replace both digest placeholders with the actual **independently reviewed** SHA-256 values. Never treat a claim created by the same untrusted producer as proof of origin.

```json
{
  "schema": "gpt1-source-zip-parity/v1",
  "product": "rplay",
  "artifact_sha256": "<64 LOWERCASE HEX CHARACTERS>",
  "source_commit": null,
  "files": [
    {"source": "Chrome/manifest.json", "member": "Chrome/manifest.json", "sha256": "<64 LOWERCASE HEX CHARACTERS>"}
  ]
}
```

`source_commit` can be a full 40-character SHA **record** or null. This tool does not verify the Git object or establish a clean checkout.

## Run

`python SOURCE_ZIP_PARITY_MODULE --claim evidence.json --source-root /path/to/checked-out-sources --artifact candidate.zip --json`

Replace `SOURCE_ZIP_PARITY_MODULE` with `ai/source_zip_parity.py` for `faaff`, or `scripts/source_zip_parity.py` for `s`.

## Status semantics

- `content_parity=MATCH`: every non-directory ZIP entry is accounted for by an explicit source mapping; the mapped source file, entry bytes and reviewed digest agree, and the outer ZIP checksum matches the claim.
- `content_parity=MISMATCH`: a required part of the claim is missing, malformed, unexpectedly present, unsafe, unreadable or changed.
- `decision=CANDIDATE_NO_GO` **always**, even if the byte-parity check matches.
- `git_commit_verified=NOT_RUN`, `signed_attestation_verified=NOT_RUN`, `live_browser_e2e=NOT_RUN` always.

Because ZIP format timestamps/compression choices are excluded from per-entry comparisons, a byte match **does not prove the ZIP was reproducibly built**. The recorded artifact SHA is checked against the supplied ZIP, but no external authentication of the manifest is performed.

## Safety and resource limits

- Explicit one-to-one mapping, full entry coverage, conservative portable paths, casefold/Unicode collision checks, no ZIP symlinks or encrypted entries.
- Source symlinks are rejected, including their directory components beneath the declared source root.
- Supports stored and deflate compression; maximum ZIP size 768 MiB, maximum individual entry 128 MiB, up to 15,000 ZIP entries and explicit mappings.
- Apply `ai/artifact_gate.py` or another dedicated nested ZIP safety check before accepting bundles with ZIP files inside; this parity utility treats a nested ZIP as opaque copied bytes.
- This is not a replacement for a cryptographically verified SLSA provenance or GitHub attestation. An actual signed build requires separately authorized GitHub Actions permissions, artifact generation and independent `gh attestation verify` checks.

## Release governance

Do not commit product ZIPs, credentials, signed streaming URLs, recordings or private project sources to either public repository. Both Draft PRs leave `main` untouched. Publication and product GO remain blocked.

Official references: https://docs.github.com/en/actions/concepts/security/artifact-attestations ; https://cli.github.com/manual/gh_attestation_verify ; https://slsa.dev/spec/v1.0/provenance
