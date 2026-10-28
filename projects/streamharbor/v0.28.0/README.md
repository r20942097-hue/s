# StreamHarbor / RPLAY v0.28.0 — CANDIDATE / NO_GO

Development integration snapshot based on the v0.27.0 full-source archive. **Do not install these individual source files as an extension**. The complete build, generated Chrome/Firefox extension ZIPs, QA evidence and checksum sidecars are stored in the user's ChatGPT Library at `/StreamHarbor/v0.28.0/`.

## Implemented

- Host assigns a **fresh independent cryptographic 32-hex audit key** when a recording control epoch begins; it is not the authorization session ID.
- Each new OPFS save captures its attribution key at save start. Retries and late outcomes cannot reassign the original part.
- The export journal stores `sessionKey` atomically with the requested part record before starting a browser download.
- `exportManager.sessionStatus(key)` projects the **retained** journal for one key through the v0.27 observed-event reducer. It never returns the key, filenames, URLs, or raw part identifiers.
- Older records and recovered OPFS orphans without verifiable provenance remain **unattributed**. A restarted host obtains a new observation epoch.
- Chrome service worker and Firefox event page load the shared reducer before export manager. The source patch also updates build, validation and regression contracts.

## Offline evidence (2026-10-29 JST)

- Node.js: **1,455 passed**, including 14 new v0.28 tests; 141 named-test files checked
- Python: **276 passed**
- Total: **1,731 passed, 0 failures, 0 skips**
- Canonical source immutability, deterministic regenerated runtime, Chrome/Firefox parity, ZIP CRC, external SHA-256 and named-test coverage audit: **PASS**.
- Source ZIP SHA-256: `164592a693099fa6276791c1ab744f836b0c6b6f8ef1c8f4b2be52b4f3bf0702`.
- Chrome ZIP SHA-256: `05c5326159bca829f956bb425eb258b312cffb7b1e8156a269273327e65c09d9`.
- Firefox ZIP SHA-256: `73c42dacf60d76b68d5db41fae45d75fa8f6825753883d8efe8bc2b90d534ced`.
- `v027_to_v028.patch` dry-run application to the v0.27 source tree: **PASS**.

## Limitations / next gates

This is an **observed, bounded-journal projection**, not durable full-session accounting across host crashes and verified-record eviction. The existing 512-row journal can discard cleaned verified exports. A `verified` journal record confirms a matched browser download file size only, **not** playable/decoded or synchronized A/V. The new projection is internal and not yet displayed in the popup UI.

Real Chrome/Firefox/Floorp installation, live RPLAY and other sites, long-running recording, crash/restart attribution, Windows quota, file completion and A/V sync are **not accepted**. Underlying extension manifest remains `2.56.0`; StreamHarbor integration candidate is v0.28.0. **Keep CANDIDATE / NO_GO and keep `main` unchanged.**
