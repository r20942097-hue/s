# StreamHarbor / RPLAY v0.25.0 — development candidate (NO_GO)

This is a **source-delta snapshot** based on v0.24.0, not a standalone installable extension. Do not use the files here without the reviewed full-source archive and matching build artifacts.

## Change summary
- Separate current recording-session's **recent returned part entries** from global export journal totals in the popup UI.
- A current recording can report at most the last 100 returned part entries; when 100 are returned, the popup displays **100件以上** instead of claiming an exact total.
- While idle, the popup suppresses retained previous-session parts; incomplete global ledger values remain unknown rather than zero.
- Recorder transport/storage logic and the underlying extension manifest (2.56.0) are unchanged.

## Verified offline
- Node.js: **1,407 passed, 0 failed** (including the newly added 12 v0.25 scenarios).
- Python: **276 passed, 0 failed**.
- 65 canonical sources, 90 JavaScript syntax checks across Chrome/Firefox, deterministic runtime rebuild, browser-copy parity, ZIP CRC and SHA-256: passed.
- Exact Git blob SHA matches the tested local source files in this folder.

## Scope and release gates
The complete source archive, browser ZIPs, test baselines, and validation evidence are saved in the user's ChatGPT Library under `/StreamHarbor/v0.25.0/`. This GitHub folder contains only the changed modules, new popup test, changelog and QA notes.

**CANDIDATE / NO_GO**: actual Chrome/Firefox/Floorp installation, live RPLAY/other media recording, long-duration/restart recovery, Windows storage/quota, and real A/V sync have not passed acceptance tests. No code from this candidate is merged to the filter-list `main` branch.
