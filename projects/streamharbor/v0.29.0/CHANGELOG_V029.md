# StreamHarbor v0.29.0 (development candidate)

- **Session attribution freeze**: refuse a conflicting non-null session key during existing part retries; preserve original key on null-key OPFS recovery.
- **Bounded retained-eviction counters**: persist verified-row eviction observations per session key with 128-key bound and overflow signal, in the same browser-storage transaction as journal row deletion.
- **Conservative read-only session summary**: report observed retired verified count (when present), lower-bound count (when safe), and explicit incomplete-history source/coverage.
- **Migration and safety**: distinguish legacy journal absence from confirmed observations; reject malformed persisted metadata; never leak raw media paths or tokens in exported diagnostics.
- **QA**: add new v0.29 regression tests including injected journal write failures and restart, preserve Node/Python baseline and Chrome/Firefox build copy verification.

`CANDIDATE / NO_GO`: recording, streaming, Windows disk quota, browser startup, crash/restart and A/V synchronization acceptance remain outstanding.
