# StreamHarbor / RPLAY v0.28 — observed session attribution (CANDIDATE / NO_GO)

- Attach independent random 32-hex session audit key to each NEW OPFS save; no identifier to popup or media URL.
- Persist the audit key in the same export-journal write as the requested part; no separate, potentially inconsistent counter store.
- Per-session observed-only projection over retained journal rows using the v0.27 reducer.
- Host restarts, recovered OPFS orphans, MP4 handoffs after stop remain un-attributed.
- Earlier export records without the key remain legacy/unknown. Attempt retries preserve the original key.
- Security: malformed keys fail closed. Session-status API does not return the key or filenames.
- Browser acceptance and durable cross-crash session attribution remain open.
