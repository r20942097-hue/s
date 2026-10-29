# GPT1 Toolchain Coverage Cross-Check — 2026-10-30

## Ground truth and interpretation
- **Public repositories / current Draft PRs:** `r20942097-hue/faaff#23`, `r20942097-hue/s#11`. These are engineering/validation surfaces, NOT the full RPLAY/StreamHarbor/YouTube Optimizer product source. Do not call skipped product-runtime CI PASS.
- **Local execution container** and **GitHub-hosted Actions runners** are independent, and neither establishes what is installed on the owner's Windows computer.
- `ai/toolchain_doctor.py` (faaff) / `scripts/toolchain_doctor.py` (s) checks PATH visibility and Python module presence only. It does NOT install tools, run binaries, verify CLI versions/credentials, inspect private host configuration, or execute browsers.
- Treat `NOT_FOUND_ON_PATH` as a discovery gap, **not proof the tool is absent or needs installation**. Every functional validation must be recorded separately.

## Cross-checked tool categories and actions
| Priority | Capability / candidate tool | What is confirmed | Next independent verification |
| --- | --- | --- | --- |
| P0 | Real signed-off source/ZIP mapping for RPLAY, StreamHarbor, YouTube | The public faaff integration branch contains tool code and mock/synthetic QA, not the full product runtime; complete live product E2E remains NOT_RUN | Identify authoritative private/local source commit, manifest, output ZIP and build recipe; run byte/provenance/rebuild gates in an isolated location |
| P0 | Firefox desktop + Chrome/Chromium extension E2E | No real Firefox extension/session E2E verified; static manifest and ZIP checks exist | Mozilla `web-ext lint/run` with actual Firefox; Chromium/Chrome extension load and real UI/sessions; avoid touching owner's real browser profile |
| P0 | Workflow code security | faaff CodeQL originally scanned Python only; CodeQL supports `actions` | CodeQL `actions` now added to Draft PR; require CI `analyze-actions` PASS and examine code-scanning findings |
| P1 | Static GitHub Actions lint | Existing custom workflow guard and official Actions dependency lock verify exist | Introduce `actionlint` with pinned trusted release and independently checked binary digest; compare with CodeQL actions results |
| P1 | GitHub Actions threat modeling | Only custom guard + CodeQL actions in faaff | Trial `zizmor` in isolated/PR CI; triage findings, avoid blanket ignores, pin downloads |
| P1 | Secrets and dependency scanning | faaff dependency-review workflow is present, and source ZIP rules reject some secrets; no dedicated general-purpose scanner confirmed in branch | Trial `gitleaks`, `osv-scanner` in isolated QA; do not put secrets or raw findings in public repo |
| P1 | Browser test harness | Playwright can test Chromium and its patched Firefox, but patched Firefox is not the actual branded Firefox | Use Playwright for fast UI tests, actual Firefox + `web-ext` for addon compatibility. Check browsers, codecs and MV3 behavior separately |
| P1 | Media validation | FFmpeg/FFprobe on this execution container; no user's Windows media pipeline verified | Validate duration, streams, pts/dts, audio, discontinuities and full decode on synthetic/authorized media |
| P2 | SBOM and signed provenance | The GitHub CLI-based read-only attestation verifier has mocked tests, and generated-source ZIP checks exist | Prefer an isolated `syft` SBOM and approved trusted-builder attestation; verify from independent run and strict expected commit/workflow |
| P2 | Containers | Docker absent from this execution container; product builds need not require Docker | Prefer GitHub-hosted runners or temporary container only if the requested build genuinely depends on one |

## Current task status
- Tool inventory script and offline regression tests are in the PR; CI prints a **non-mutating observational report** of actual runner PATH at each operating system/Python combination.
- Existing SHA-pinned Actions, dependency `actions.lock`, read-only tokens and `PUBLICATION_HOLD` remain in effect.
- `s` has no CodeQL workflow in the current branch; verify org/repo automatic code-scanning settings separately before proposing a new workflow. Adding one would change Actions dependencies and require regeneration/verification of `actions.lock`.
- `faaff` product runtime `source-check` explicitly marks the runtime source absent and skips the product matrix. Do not re-label as a successful product test.

## Safe usage
```bash
python ai/toolchain_doctor.py --profile core --json
python ai/toolchain_doctor.py --profile github-ci --json
python ai/toolchain_doctor.py --profile browser-media --json
python ai/toolchain_doctor.py --profile full-security --json
```
For s, use `scripts/toolchain_doctor.py`. Optionally append `--require-path-tools` to return failure if a required profile command isn't found on PATH. No command installs, authenticates, or runs external tools.

## Source references
- GitHub CodeQL supported `actions` language: https://docs.github.com/en/code-security/reference/code-scanning/workflow-configuration-options
- GitHub Actions security: https://docs.github.com/en/actions/reference/security/secure-use
- actionlint official: https://github.com/rhysd/actionlint
- zizmor official: https://github.com/zizmorcore/zizmor
- Mozilla web-ext official: https://github.com/mozilla/web-ext
- Playwright browser-specific limitations: https://playwright.dev/docs/browsers
- GitHub dependency review: https://github.com/actions/dependency-review-action

No `main` merge, release, public filter modification, private binary publication, or repository policy change is authorized by this audit.
