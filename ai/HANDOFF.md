# HANDOFF — 次のAIへ（2026-10-31 更新）

## 2026-10-31 確認済みの最新判断

- **正本:** `AGENTS.md` に自律調査・自然言語の内部最適化・確認最小化の原則を反映。
- **正式反映:** PR #15（`AGENTS.md`のみ）が `main` に squash merge。マージコミット `c0fd5f57b7050ecd622c936f338d23ff66af3826`。最新 HEAD は必ず再取得し、 `PROJECT_STATE.json` の `governance` を参照する。
- **検証:** PR上の必須 `test` と `engine` が SUCCESS。今回は文書のみで、`japanese-text-softener.yml` の push paths 条件に該当しないため、merge後mainでの新規ワークフロー実行はない。これはFAILでもPASSでもなく NOT_RUN。
- **権限:** RulesetはPR・必須CI・force-push/削除禁止を技術的に強制。レビュー承認0は所有者の明示承認ルールを代替しない。
- **下流同期:** `faaff/ai/imports/s.json` の `excluded_paths` に `AGENTS.md`、`CLAUDE.md`、`ai/HANDOFF.md`、`ai/PROJECT_STATE.json` が含まれる（他の `ai/*` もすべて除外されるとは限らない）。これらだけの変更では `faaff` のピン留めファイルを更新しない。同期対象ファイルの実差分がある場合のみ別PRで検証する。
- **次に優先:** 既存テスト・購読URL・生成フィルターを保持しつつ、公開変更とAI運用文書変更を分離。P0/公開HOLDを勝手に解除しない。

## Python 3.15.2 compatibility gate (2026-10-31)

- `.github/workflows/japanese-text-softener.yml` に **Python 3.15.2 compatibility** を独立ジョブとして追加。既存の Ruleset 必須 `test` / `engine`（Python 3.13）のジョブ名・動作は変更していない。
- 3.15.2で unittest、リスト構文検証、生成結果の一致チェックを実行。最初の実行は [Actions run 41089156383](https://github.com/r20942097-hue/s/actions/runs/41089156383) で、`test`、`engine`、`Python 3.15.2 compatibility` が SUCCESS。
- これは標準ライブラリを使うフィルター検証の互換性証拠であり、Windows PCやブラウザー、全Pythonパッケージとの互換性を証明しない。
- Pythonの更新は提案・CI検証と端末本番環境への適用を分離し、ユーザーPCの既存インストールを自動で置き換えない。

## 2026-10-28 の履歴（旧記録・新しい判断は上記を優先）

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
