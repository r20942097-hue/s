# StreamHarbor / RPLAY v0.23.0 — CANDIDATE / NO_GO

This directory is a **development snapshot**, not an installable extension and not a release. Its `src/popup_state.js` and `src/popup.js` are the updated read-only popup controllers.

## Changes

- Show which pending-ledger component is missing rather than treating missing values as zero.
- Differentiate invalid or missing components from safe-integer overflow.
- Retain available recording state and measured counts, and clear stale explanations on refresh failures.
- Additional accessible ledger guidance is rendered in the popup.

## Integration requirements

Apply these controllers onto the StreamHarbor v0.22 full-source baseline. In `src/popup.html`, update the badge to v0.23, add `<p id="popup-ledger-note" class="ledger-note" aria-live="polite">保存台帳を確認中…</p>` immediately after the metrics grid, and associate the pending count with the note through `aria-describedby="popup-ledger-note"`. In `src/popup.css`, add:

```css
.ledger-note{font-size:11px;line-height:1.5;margin:9px 0 0;color:var(--muted);overflow-wrap:anywhere;border-top:1px solid var(--line);padding-top:8px}
```

The **complete tested source archive**, browser builds and exact v0.22-to-v0.23 patch are distributed separately. These GitHub files alone cannot be installed or used to reproduce the full test suite.

## Verification

Offline v0.23: 1,385 Node.js tests + 276 Python tests, all pass. A 65-file canonical source immutability check and generated-copy parity check also pass. Real-browser, real-stream, long-run, crash recovery and A/V synchronization checks remain open. The underlying extension manifest version remains 2.56.0. Status is **CANDIDATE / NO_GO**.

The repository's `main` branch contains filter lists and was **not** modified.
