# StreamHarbor / RPLAY v0.24.0 (CANDIDATE / NO_GO)

Development snapshot. The `main` branch is unchanged and this folder is **not** a runnable browser extension on its own.

## Changes
- The browser-action popup explicitly labels export journal metrics as all-recordings history; they are not current-session counts.
- `capturedAt` records the conservative **start** of the recorder-status request instead of when the host reply completed.
- `ledgerCapturedAt` separately records the journal-status completion time; it is null when unavailable.
- Unknown or malformed ledger counts remain unknown (never zero-filled); active recording status remains visible.
- Chrome and Firefox maintain the same sanitized, read-only status projection.

## Files in this branch
Modified canonical modules under `src/`: `background.js`, `popup_state.js`, `popup.js`, `popup.html`, `popup.css`; new `tests/test_streamharbor_popup_v24.cjs`, plus the QA and changelog notes. All eight text files were compared to the development source by exact Git blob SHA.

**Important**: This GitHub folder is only the changed-source snapshot. It does not contain the complete 2.56.0 recorder engine, build scripts, historical test baseline or browser installation packages. Those are in the separately packaged v0.24.0 **SOURCE_CANDIDATE_NO_GO.zip** stored in the user's ChatGPT Library.

## Offline evidence
- Node.js: 1,395 / 1,395 passed
- Python: 276 / 276 passed
- Total: 1,671 passed; zero failures
- Manifest, JS syntax, regenerated runtime byte identity, canonical source check, browser-copy parity, ZIP CRC and hash checks: passed
- Chrome/Firefox browser-extension installation, live media recording, crash/long-run behavior, Windows storage and real A/V sync: **not accepted**
- Standalone Chromium visual smoke: blocked by administrator for both file:// and localhost, **not passed**

Full source archive SHA-256: `bebda61b21a179106a734b6dd63bafabd5a6ae5d8c752bafd4f6dba3c9f95144`.
Underlying extension manifests remain version `2.56.0`; `v0.24.0` is the StreamHarbor integration candidate version.

**Do not promote as stable based solely on offline tests.**
