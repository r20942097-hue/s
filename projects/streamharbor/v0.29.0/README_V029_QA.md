# StreamHarbor v0.29 QA and design notes

**Status: CANDIDATE / NO_GO**. This change is an incremental correction to v0.28 and retains the existing Chrome/Firefox extension manifest version 2.56.0.

## v0.29 behavior

- The export manager makes the stored session attribution immutable: an explicit different key for an existing `partId` is rejected; a null-key retry retains the persisted key. An unattributed historical part is never silently upgraded.
- The existing 512-entry journal may evict settled verified rows (after OPFS cleanup). At eviction time, the journal atomically commits a bounded per-session **count of observed verified-row evictions since v0.29**. This metadata records observed ledger events, not necessarily unique files, playable media, or all historical records.
- The count index holds at most 128 session keys. A new untracked group after that bound sets `evictedSessionOverflow=true`. The status projection reports **bounded-partial**, not completeness. Existing indexed groups can still increment unless numeric saturation occurs. No key, part ID, name, download URL, or media bytes are returned by the session projection.
- A legacy journal without v0.29 counters does not claim zero prior evictions. `evictedVerifiedObserved=null` means no per-session eviction evidence is available for the requested key; it is not a measured zero.
- `sessionStatus(key)` now exposes `evictedVerifiedObserved`, `verifiedObservedLowerBound`, and `evictionCoverage` in addition to the retained-only status fields. `historicalCoverage` remains `incomplete` and `complete=false` in every result. The popup does not display or request raw session keys.
- Failed browser storage writes never modify the in-memory or persisted eviction counter, and never begin a download when journal staging fails.

## Remaining constraints

A new host recording control epoch generates a new audit ID; stable recording identity across browser crashes is not yet implemented. Aggregates before v0.29, attribution for recovered OPFS orphans, >128 group overflow, replay after journal record eviction, and loss of browser storage cannot be fully reconstructed. Verified means downloaded-file-size equality; it is not video decode, audio synchronization, or completeness proof. No live service/browser/long-duration acceptance has been performed.
