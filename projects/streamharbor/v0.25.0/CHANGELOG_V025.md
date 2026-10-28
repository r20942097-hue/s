# StreamHarbor / RPLAY v0.25.0 — CANDIDATE / NO_GO

- Split live recording session observation (recent displayed part entries, max 100) from global export journal counters (verified/pending/failed).
- Do not misattribute retained prior-session parts while recorder is idle; recording state is required to show the window count.
- A 100-entry window is shown as a lower bound (**100件以上**), not a proven total; pending/in-progress part entries are not implied to be saved files.
- Show independent diagnostic notes for session-window bounds and ledger incomplete counts; clear both on runtime failure.
- Preserve no-secrets read-only extension messaging and both browser targets; no recording pipeline or retention change.
- New Chrome/Firefox and DOM model regression checks; offline test coverage remains no substitute for live browser QA.
