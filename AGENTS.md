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
- 現在の統制ゲート: **P0 / PUBLICATION_HOLD / NO_NEW_INTERNAL_PUSH**。所有者の明示承認なしに push・PR作成・merge・Release・公開設定変更・CI再実行をしないでください。
- 変更は隔離ブランチで行い、PRで提案します。force-push・自動マージ禁止。
- 状態は **PASS / FAIL / BLOCKED / NOT_RUN / NEEDS_HUMAN / PARTIAL** を区別して報告します。実行していない検査（実ブラウザ・ログイン・動画再生・実機）をPASSと書かないでください。合成テストの成功は実サイトE2Eの成功ではありません。
- 上流監査の結果だけでルールを自動採用しないでください。v2を安定版へ自動昇格しないでください。
- 認証情報・トークン・Cookie・個人データ・録画・ZIP成果物・キャッシュをコミットしないでください。
- 以前ルートにあった `RPLAY_*.zip` 等（フィルター配布と無関係）は、所有者判断により 2026-10-28 に `main` から外しました（Google Drive `制作物管理/99_保全・確認待ち/RPLAY_ZIP退避_2026-10-28` に退避済み、git 履歴には残存）。ZIP を再追加しないでください。`index.html` も本リポジトリの配布物ではありません。

## 詳細な共通ルール・プロジェクト台帳
- AI作業環境 統合マスター入口（Google Drive、要アクセス権）: https://docs.google.com/document/d/1ajeph-Kynrpmza3cn06SdKrCYkW-FF3x1ZgRaTzbrkE/edit
- 報告時は、変更パス・実行コマンドと結果・未検証項目・購読URLへの影響・ブランチ/コミットを明記してください。
