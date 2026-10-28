# v0.25 QA scope and known limitations

**CANDIDATE / NO_GO**. User-visible popup counts are divided by data provenance. `partCount` is a count of the *most recent up to 100 entries returned by the recorder host*, not a session-wide total and not a disk-write count. It is shown only while recording (not solely during the draining flag), and suppressed while idle because `rec.status` may retain the previous session's final entries. `exports` counts are cross-session journal records; their completeness and file decoding are independently unverified.

Offline runtime integration via synthetic host and mock browser, node coverage guard, Python regression, deterministic generated builds, archive hash and cross-browser parity are necessary but not evidence of functioning live-stream recording, Windows filesystem resilience, crash recovery, or audio-video sync.
