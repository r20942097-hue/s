# HANDOFF — 次のAIへ（2026-10-28 更新）

1. まず [`AGENTS.md`](../AGENTS.md) を読む。権限は「常に可」「要承認」の2段階。`main` への直接 push は禁止（Ruleset で技術的にも保護）。
2. 現在の状態は [`PROJECT_STATE.json`](PROJECT_STATE.json)。最新の `main` head は `git rev-parse origin/main` で確認する。
3. 2026-10-28 の整理内容:
   - 閉じたPRのブランチ（`codex/adblock-v2-validation`, `codex/weekly-filter-overlap-review`）を削除（git bundle でバックアップ済み）。
   - `index.html`（ゲーム、配布物ではない）を `main` から削除。
   - CI（Filter list checks）に ZIP/7z 混入チェックを追加し、PR では全変更で実行するよう変更。
   - Dependabot 脆弱性アラートと自動セキュリティ修正を有効化、merge 後のブランチ自動削除を有効化。
4. 購読URL（`https://raw.githubusercontent.com/r20942097-hue/s/main/<ファイル名>`）のファイル名・パスは変更しない。
5. 本リポジトリを変更したら、`r20942097-hue/faaff` の `ai/imports/s.json`（固定取り込み）を別PRで更新する。
6. 未対応: `PROJECT_STATE.json` の `open_items` を参照。
