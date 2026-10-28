# StreamHarbor / RPLAY v0.26.0 — CANDIDATE / NO_GO

**Source-delta development snapshot, not a standalone installable extension.** This folder contains the modified UI/host modules, one new test file and QA documents. The canonical full-source archive and Chrome/Firefox browser ZIPs are saved separately in the user's ChatGPT Library under `/StreamHarbor/v0.26.0/`. The `main` branch was not modified.

## What changed

- The host returns a sanitized, bounded `partSequence` for active sessions, derived from the video and separate-audio `partIndex` plus an open part. A part ordinal is **not** a count of confirmed saved files, nonempty media, decoded media, or durable session inventory.
- The popup separates the **last up-to-100 parts returned in the status window** from host part ordinals and the **global export journal**.
- Invalid, missing or unsafe integers are not zero-filled. Previous-session ordinals are hidden when idle. Absent separate audio shows `対象外`.
- No new paths, media URLs, session identifiers or credentials are exposed in popup status.
- The streaming, storage and recorder data path were not changed. The underlying extension manifest is still `2.56.0`.

## Offline verification (2026-10-29 JST)

- Node.js: **1,422 / 1,422 passed**, includes 15 new v0.26 tests.
- Python: **276 / 276 passed**.
- Source immutability, reproducible generated code, Chrome/Firefox parity, manifest/JS syntax, ZIP CRC and SHA-256: **PASS**.
- Complete archive SHA-256: `623e62ba871a49373fec5f4801eedfab3f8a008f45204672b8478287251f34ee`.
- Chrome archive SHA-256: `8cc78e19153fbd3cafe35a436eb45e1850379cc252743ccfee3f367f5fece2f8`.
- Firefox archive SHA-256: `6317993fac4789f52fa9ba2307d702673282c7fbb616e71682e2900e41457000`.

## Release blockers

Real Chrome/Firefox/Floorp installation, live RPLAY/HLS capture, more-than-100 actual segment observation, long sessions and crash/restart behavior, Windows quota/storage exhaustion and end-to-end A/V decoding/synchronization **remain unverified**.

**Do not promote as stable.**
