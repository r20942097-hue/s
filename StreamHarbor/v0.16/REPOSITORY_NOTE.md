# StreamHarbor / RPLAY v0.16 — GitHub source snapshot

Status: **CANDIDATE / NO_GO**. This branch is an isolated, source-only preservation of the v0.16 development candidate.

## Included here
- `src/player.user.js`: editable core player userscript source.
- `dist/rplay-stable-player.user.js`: generated userscript artifact (text).
- `patches/v0.15-to-v0.16.patch`: source/test change patch relative to v0.15.
- `README.md`, `CHANGELOG.md`, `QA.md`: build context and test scope.
- `SHA256SUMS.txt`: digest list for the original locally exported **archives**, **not** a digest of this Git subtree.

## Intentionally not included
The complete 436-file source ZIP, browser-extension ZIPs, merged release bundle, media assets, tests and third-party dependencies are **not** present in this Git branch. Repository policy disallows ZIP/binary artifacts and prohibits direct updates to the `main` publication branch. The original archives remain separate ChatGPT conversation artifacts.

This snapshot alone is **not a self-contained build**, and this does not claim release readiness.

## Verification boundary
Reported at export: Node.js 1,318 PASS and Python 276 PASS. This Git export was not separately tested in a real browser. Crash recovery, live-stream recording, audio/video sync and Windows use require independent checks.

The filter-subscription content and published paths on `main` remain unchanged.
