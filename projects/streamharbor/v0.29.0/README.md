# StreamHarbor / RPLAY v0.29.0 — CANDIDATE / NO_GO

This is an auditable development delta based on the v0.28.0 canonical source, **not** an installable extension by itself. Complete source, Chrome and Firefox ZIPs and their external checksum sidecars are saved in the user's ChatGPT Library under `/StreamHarbor/v0.29.0/`. The repository `main` branch is unchanged.

## Changes

- Fix the service-worker export journal so an existing `partId` cannot silently migrate to a different session attribution on retry. An unattributed old part stays unattributed; a null-key retry preserves its stored attribution.
- Preserve **observed evicted verified-row counts since v0.29** in the same browser.storage transaction that retires eligible rows from the 512-record export journal. The per-session index is capped at 128 groups and tracks overflow.
- The internal `sessionStatus(key)` returns only sanitized observed counters, an explicit limited-coverage classification and `complete:false`. Missing/legacy count evidence returns null; it does not claim lifetime zero. No raw keys, file paths, signed media URLs or login data are projected.
- Correct the browser-action popup candidate badge from v0.27 to v0.29.
- Add `test_session_eviction_audit_v29.cjs` (13 tests, including failure injection, identity conflict, restart and overflow), and update the canonical named-test inventory. The diff contains both baseline updates.

## Offline verification (2026-10-29 JST)

- Node.js **1,468 passed / 0 failed**; all named cases matched the reference baseline across 142 files.
- Python **276 passed / 0 failed**, with Python source snapshot checks.
- Total **1,744 passed / 0 failed**.
- 86 Chrome/Firefox extension JavaScript syntax checks, manifest validation, shared runtime copy comparison: PASS.
- 129 generated runtime artifacts unchanged after re-running the canonical build script: PASS.
- v0.28 → v0.29 patch dry-run against the original full source: PASS.
- Source ZIP SHA-256: `f285fcd8fa74eeb8147ac8211cea0c48614a33cf87f02ad1aa83555c1e48c86a`.
- Chrome ZIP SHA-256: `885cfa3f915a2845ca73c5cbaef71cf2c183efb5d84d9b6ed87e0b3af6067c05`.
- Firefox ZIP SHA-256: `cc5d494ead18aae9f8fa5d40c51f9ce7e9c9b923f7aa4344371396665412a216`.
- ZIP CRC, no duplicate archive paths, package SHA-256 and no self-referential archive checks: PASS.
- The monolithic `scripts/validate.py` timed out; its component checks above were instead run separately and recorded in `evidence/v029/VALIDATION.json`. Do not claim a complete monolithic validation run.

## Outstanding NO_GO gates

Actual Chrome/Firefox/Floorp installation; live RPLAY/HLS capture; >512 actual part exports; Windows storage/quota; crash/restart attribution continuity; video decode and real A/V synchronization. “Verified” is browser downloaded-file-size equality, **not** playable media. Prior-to-v0.29 removals cannot be recovered, and the 128-session summary cap can leave incomplete evidence. Underlying extension manifest stays `2.56.0`; integration candidate label is `v0.29.0`.

**Do not merge into stable/main as a release.**
