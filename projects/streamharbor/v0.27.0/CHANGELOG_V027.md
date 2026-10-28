# StreamHarbor v0.27.0 / journal-scope integrity

- Audit discovered that the export journal is bounded to 512 retained records, not a lifetime total.
- Read-only popup now says **保持中の記録**; kept global nature clear and did not equate counts with a single active recording.
- Journal stores optional v1-compatible eviction provenance atomically beside records. Old v1 journals have unknown history; never infer prior completeness.
- Propagate bounded retention and deletion state through the background with safe scalar values only. No filenames, IDs or source URLs in popup payload.
- Preserve existing export retry, OPFS cleanup and download completion behavior.
- Real per-recording durable success ledger needs a stable recording identity and explicit event linkage and remains **not implemented**.
