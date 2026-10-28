# StreamHarbor / RPLAY v0.24.0 — CANDIDATE / NO_GO

- Make the four export journal counters unmistakably **global, cross-session**. They are NOT specific to the current recording.
- Record a conservative *start-of-recorder-read* timestamp; do not present the later ledger-read completion time as a fresh recorder observation.
- Return a separate `ledgerCapturedAt` timestamp for successful journal reads and `null` on unavailable journal. Never turn missing counts into zeros.
- Distinguish unknown timestamps from current time for compatibility with legacy no-timestamp test payloads.
- Preserve read-only popup and the background-sanitized, zero-secret response contract.
- Add both Chrome and Firefox VM tests plus UI, partial journal and timestamp validation regressions.
- Offline mocks and synthetic tests are not real browser or live site acceptance. No recorder acquisition pipeline changes.
