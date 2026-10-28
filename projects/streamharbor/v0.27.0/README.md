# StreamHarbor / RPLAY v0.27.0 — CANDIDATE / NO_GO

**Development change set, not a standalone extension.** Based on the v0.26 full-source baseline. Chrome and Firefox manifests remain at `2.56.0`.

## Changes

- Corrected the popup: global export-journal figures count **only retained records**, not lifetime exports or just the currently active session. The journal is bounded at **512 rows**, with settled verified entries evictable when full.
- Persist a tri-state `verifiedEvictions` marker atomically alongside export journal rows: fresh journals start `false`, eviction records `true`, prior v1 journals missing provenance remain `null` (unknown).
- Kept download-request, OPFS staging, cleanup and recovery behavior unchanged. Unknown counts never become zeros and failed journal writes never imply successful exports.
- Added `src/session_export_ledger.js`, a **unit-tested isolated reducer only**, with idempotent event replay, stale attempt guards and conflicting terminal event detection. It is **not wired to actual recording**, and performs no persistent IO. Do not interpret it as real per-session saved-file accounting.

## Offline verification

- Node.js **1,441 / 1,441 passed** in 140 named test files; baseline case names verified.
- Python **276 / 276 passed**.
- Total **1,717 passed**, 0 failed / skipped.
- Canonical source immutability, deterministic rebuild and Chrome/Firefox generated-copy parity: PASS.
- Full-source candidate ZIP: SHA-256 `8c441f769abed2169daa39b981c60a985eba9ad13a54005b588debe9b71366c5`; CRC and self-reference checks PASS.
- Chrome candidate ZIP: SHA-256 `13ce0bc9acbc5aaf668d046e45f09663ce916881fb8c52172f1d9b0714d1e867`.
- Firefox candidate ZIP: SHA-256 `532ba756d1e9177afec05d170ab37b8a7ecc159019bbb3c8ebb06988d661b16e`.

## Contents and release blockers

This GitHub directory contains changed production modules, isolated core, added/updated tests, named test baselines and QA notes. The **complete development source archive** and browser-installable ZIPs are saved separately in the user's ChatGPT Library at `/StreamHarbor/v0.27.0/`. The repository's `main` branch (filter lists) was **not** modified.

Real Chrome/Firefox/Floorp installation, live streams, long-duration recording, crash/recovery correctness, real session-scoped export attribution and A/V decoding/synchronization **have not passed acceptance**. Status remains **NO_GO**.

For safe integration, a future version must assign a durable session identity and explicitly link each export/finish event to it; never infer successful files from host part ordinals.
