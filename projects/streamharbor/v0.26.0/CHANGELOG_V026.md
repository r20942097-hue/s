# v0.26.0 — part-ordinal diagnostics (candidate, NO_GO)

- Offscreen host emits a bounded, per-track `partSequence` derived from `partIndex` plus an open part for active sessions only. Validate that values are safe nonnegative integers; integer overflow fails closed.
- Extension background emits only sanitized ordinal counters to the authorized popup. No URLs, session identifiers, or filenames are included in the response.
- Popup keeps the **last 100 returned entries** distinct from **video/audio allocated part numbers** and the **global export journal**. A part ordinal is explicitly not a saved-file count, is not evidence of usable A/V media and may not be complete after recovery.
- During idle, error, timeout or invalid states the ordinal is unknown, never a stale previous-session count. Absence of a separate audio recorder is shown as `対象外` rather than numeric zero.
- Add tests/test_streamharbor_popup_v26.cjs and extend the test name/file baseline.

No stable release is authorized by these offline tests alone.
