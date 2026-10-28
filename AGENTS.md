# AGENTS.md — `s`（ブラウザー用フィルター配布リポジトリ）

AIコーディングエージェント（Codex / Claude / Cursor / Copilot / Grok Bot など）共通の作業指示です。
`CLAUDE.md`・`.cursor/rules/`・`.github/copilot-instructions.md` はこのファイルを参照するだけの入口です。内容はここに一本化してください。

## このリポジトリの役割
- 広告・追跡ブロック補助フィルターと、日本語本文フォント調整フィルターの**公開配布元（release authority）**です。
- 購読URLは `https://raw.githubusercontent.com/r20942097-hue/s/main/<ファイル名>` です。利用者が購読中のため、**既存ファイルのパス・ファイル名を変更・削除・移動しないでください**（`v2/` 配下を含む）。
- 統合・開発ハブは [`r20942097-hue/faaff`](https://github.com/r20942097-hue/faaff) です。`faaff/integrations/browser-filters/source/s/` に本リポジトリの**固定コミットの写し**があり、`faaff/ai/imports/s.json` でGit blobハッシュ照合されています。本リポジトリを変更したら、faaff側の取り込み更新は別PRで行います（自動同期はありません）。

## 正本と生成物
- 広告・追跡ネットワークルールの正本は **`filter-profiles.json`** です。
- 生成先のtxt（`ad.txt`、`tracking.txt`、`v2/ad.txt`、`v2/tracking.txt`、`v2/strict.txt`）は**直接編集しない**でください。`filter-profiles.json` には faaff 側 `browser_filter_lists/filters/universal-web-*.txt` 向けの出力定義もありますが、それらは本リポジトリでは生成・配布しません。`python scripts/generate_lists.py` で再生成します。手編集すると `--check` が失敗します。
- 手動管理ファイル: `ad-ubo.txt`、`japanese-text-softener.txt`、`japanese-text-softener-deep.txt`、`twitch-custom-optional.txt`。
- ライセンスは各ファイルのヘッダーで宣言されています（ルートのフィルター: CC0-1.0、`v2/`: GPL-3.0-only）。ヘッダーを削除・変更しないでください。

## 検証コマンド（Python 3.11以上、外部ライブラリ不要）
```sh
python -m unittest discover -s tests -p 'test_*.py' -v
python scripts/validate_lists.py
python scripts/generate_lists.py --check
```
任意の実エンジン検証（Node.js 24、初回はネットワーク必要。作業ディレクトリはリポジトリ外）:
```sh
python scripts/prepare_engine.py --directory ../work/filter-engine
npm ci --prefix verification/ghostery --ignore-scripts --no-audit --no-fund
node scripts/check_engine.mjs --engine-dir ../work/filter-engine --ghostery-entry verification/ghostery/node_modules/@ghostery/adblocker/dist/esm/index.js
```
CI: `.github/workflows/japanese-text-softener.yml`（Filter list checks）。サードパーティActionはフルSHAで固定します。

## 作業ルール（要約）
- 現在の統制ゲート: **P0 / PUBLICATION_HOLD / NO_NEW_INTERNAL_PUSH**（名称は維持）。
  - `NO_NEW_INTERNAL_PUSH` は「**`main` への直接 push 禁止**」を意味します。作業ブランチへの push は下記「常に可」に含まれます。
  - `PUBLICATION_HOLD` は Release 作成・公開範囲変更・購読URLの変更を所有者承認まで保留する意味です。
- 変更は隔離ブランチで行い、PRで提案します。force-push・自動マージ禁止。`main` はリポジトリ Ruleset（PR必須・必須チェック・force-push/削除禁止）で保護されています。

## 権限の2段階（AIエージェント向け）
### 常に可（承認不要）
- リポジトリ内のあらゆるファイル・Issue・PR・CI結果・設定の**読み取り**
- 提案用／機能用ブランチ（例: `proposal/*`、`feature/*`、`codex/*`）の作成と、そのブランチへの push
- Draft PR・通常 PR の作成と説明文の更新
- CI の再実行、ローカルでの検証コマンド実行
### 要承認（所有者の明示承認が必要）
- `main` への merge（`main` への直接 push は常に禁止）
- 原本のブランチ・ファイルの削除
- リポジトリ公開範囲（visibility）・公開設定の変更、Release 作成
- force-push・履歴書き換え（filter-repo / rebase 後の push など）
- 本番デプロイ
- ZIP・バイナリ成果物の追加（CI は追跡中の `*.zip` / `*.7z` を検出すると FAIL します）
- 状態は **PASS / FAIL / BLOCKED / NOT_RUN / NEEDS_HUMAN / PARTIAL** を区別して報告します。実行していない検査（実ブラウザ・ログイン・動画再生・実機）をPASSと書かないでください。合成テストの成功は実サイトE2Eの成功ではありません。
- 上流監査の結果だけでルールを自動採用しないでください。v2を安定版へ自動昇格しないでください。
- 認証情報・トークン・Cookie・個人データ・録画・ZIP成果物・キャッシュをコミットしないでください。
- 以前ルートにあった `RPLAY_*.zip` 等（フィルター配布と無関係）は、所有者判断により 2026-10-28 に `main` から外しました（Google Drive `制作物管理/99_保全・確認待ち/RPLAY_ZIP退避_2026-10-28` に退避済み、git 履歴には残存）。ZIP を再追加しないでください。以前ルートにあった `index.html`（ゲーム「Core Breaker」、配布物ではない）も 2026-10-28 に `main` から外しました（原本は Google Drive に保管、git 履歴には残存）。

## 詳細な共通ルール・プロジェクト台帳
- 現在の状態（機械可読）: [`ai/PROJECT_STATE.json`](ai/PROJECT_STATE.json)、次のAIへの引き継ぎ: [`ai/HANDOFF.md`](ai/HANDOFF.md)
- AI作業環境 統合マスター入口（Google Drive、要アクセス権）: https://docs.google.com/document/d/1ajeph-Kynrpmza3cn06SdKrCYkW-FF3x1ZgRaTzbrkE/edit
- 報告時は、変更パス・実行コマンドと結果・未検証項目・購読URLへの影響・ブランチ/コミットを明記してください。
