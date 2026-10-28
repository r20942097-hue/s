# v0.27 verification scope

This build corrects the semantics of the existing **global bounded export journal** and adds verified-eviction provenance. It does **not** implement durable session-scoped file counts, infer successes from the recorder ordinal, or alter media acquisition / storage behavior. Old v1 journals without provenance stay unknown. New journals begin with a known false marker; a verified-record eviction sets it to true in the same storage write. Retried part exports still count by unique partId only.

Safety note: a 'verified' export in this existing browser-download journal means a matching completed download's size, not decoded media or A/V synchronization. No lossless lifetime ledger is claimed.

Status: CANDIDATE / NO_GO. Actual Chrome/Firefox, long-run RPLAY, real media verification, crash/recovery remain unverified.
