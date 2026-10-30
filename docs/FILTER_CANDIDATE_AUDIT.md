# Filter candidate evidence and release gate

This document describes the optional extra list introduced on 2026-10-30, on a Draft PR. The main branch and public subscriptions are **unchanged** until an authorized merge.

## Scope
- **Stable**: root ad.txt, ad-ubo.txt, tracking.txt, font filters: unchanged.
- **Existing v2**: ad.txt, tracking.txt, strict.txt: unchanged by the *additional* four-candidate stage. PR #14 previously added three narrowly-scoped hosts to v2/tracking.txt.
- **Optional experimental**: v2/tracking-extra.txt is **not included** by any other subscription. It contains four host-only third-party network rules and is not enabled by default.
- Existing subscription URLs are immutable. The proposed new URL would only become reachable from main if the repository owner explicitly approves the PR.

## Evidence and reproducibility

The exact records are in verification/filter-candidates.json. Each entry has:
- An exact rule and output target, a review status and disruption risk.
- A historical, immutable AdGuard Git commit, file path and line number where the specific rule was observed.
- An independently named allowlist inspected for literal host mentions. Absence there is only a narrow negative observation, **not** comprehensive clearance.
- A reason why other candidate hosts were held or rejected.

Read-only validation (stdlib Python >=3.11):

    python -m unittest discover -s tests -p 'test_*.py' -v
    python scripts/validate_lists.py
    python scripts/generate_lists.py --check
    python scripts/audit_filter_candidates.py

Online immutable source check (no list is automatically modified):

    python scripts/audit_filter_candidates.py --fetch-upstream
    python scripts/audit_filter_candidates.py --fetch-upstream --report /tmp/filter-candidate-audit.json

Read-only upstream-delta review queue (suggestions only; **not** adopted as filters):

    python scripts/scan_upstream_delta.py --fetch-upstream --limit 40
    python scripts/scan_upstream_delta.py --fetch-upstream --report /tmp/filter-delta-review.json

This scan now distinguishes **complete local parent coverage** from a higher-risk **parent-domain expansion**. It also separates literal text references in the selected allowlist from actual `@@` exception-form lines. The scanner indexes literal references once; regex-escaped or wildcard exceptions and runtime matching are not modeled. The output is a review queue, not a ranked list of proven-safe filters.

Independent cross-project comparison (requires verification of all sources):

    python scripts/scan_upstream_delta.py --fetch-upstream --crosscheck-independent --limit 40
    python scripts/scan_upstream_delta.py --fetch-upstream --crosscheck-independent --report /tmp/filter-crosscheck.json

The independent source registry is `verification/filter-independent-baselines.json`, with two source files pinned to one exact EasyPrivacy Git commit and each Git blob digest verified before use. Cross-check output labels an exact/ancestor host *observed in the selected EasyPrivacy files*. A match does not guarantee an installed list blocks it, and absence does not prove a new tracker. The sources may already appear in many users' baseline filters. The script never writes to this repository, adopts rules, or changes publication.

The online check fetches only two explicitly pinned GitHub source files. It validates SHA-1 using the Git blob envelope (not bare SHA1), exact line text, candidate/output parity, and literal host references in the selected upstream allowlist. It imposes a bounded file size and a network timeout. A network failure results in FAIL, never a silent success. For stronger cryptographic attestations, SHA-1 Git blob identity does not replace signed supply-chain provenance.

The GitHub Actions test job runs the online pinned-source check. The engine job parses every .txt list in root and v2 and checks uBlock Origin and Ghostery network behavior using synthetic first-party, third-party and boundary requests. Both are necessary but do not provide proof about live websites.

## Quality gates
1. All accepted rules must remain narrow and third-party-only. No broad exception weakening and no hidden auto-promote.
2. Existing network rules and stable paths remain byte-identical.
3. The observed pinned source line must match each rule exactly, and the selected pinned allowlist must not mention its hostname.
4. Tests, registry/output parity, engine parsing and synthetic matching must pass.
5. **Firefox/Chromium real websites, login, forms, video, checkout, conversion tracking and consent flows are NOT_RUN.** Candidate is NO_GO for default enrollment or stable promotion until appropriate tests and owner approval.
6. A filter already covered by a maintained upstream list may have low incremental value, even if our own list does not contain it. Manual subscription choices must avoid unnecessary duplicates.

## URL query parameter stripping
A separate URL-tracking list was researched but is **not shipped** by this PR. uBlock Origin documents modifier syntax such as \`*$removeparam=utm_source\`, but its support in MV3 is partial; modifying links can affect payment, login and signed requests. A future opt-in proposal requires engine-level modifier tests, compatibility matrices for Firefox/Chromium/uBO Lite/AdGuard, and regression fixtures before publishing.

## Rollback and change control
Close the Draft PR without merging. No stable file, URL, Release, downstream mirror or branch protection setting needs to be modified. If approved in the future, merge via reviewed PR only, then separately update the pinned s source in faaff with provenance.
