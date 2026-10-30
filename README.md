# ブラウザー用フィルター

広告・追跡ブロックの補助フィルターと、日本語本文のフォント調整を管理します。広告・追跡一覧は、保守されている一般用途の基本リストと併用してください。

## プロファイル一覧

| 用途 | ファイル | 対象・位置づけ |
|---|---|---|
| 広告ブロック | [ad.txt](ad.txt) | 基本一覧。uBOではad-ubo.txtも読み込み |
| uBO専用拡張 | [ad-ubo.txt](ad-ubo.txt) | ad.txtの補助。配置を変更しない |
| 追跡ブロック | [tracking.txt](tracking.txt) | 任意追加。サイト機能に影響する場合あり |
| 日本語本文のフォント調整 | [japanese-text-softener.txt](japanese-text-softener.txt) | uBlock Origin向け標準版 |
| より深いフォント調整 | [japanese-text-softener-deep.txt](japanese-text-softener-deep.txt) | 標準版を含む追加プロファイル |
| 外部Twitch拡張 | [twitch-custom-optional.txt](twitch-custom-optional.txt) | 追加リソースが必要。既定では無効 |
| 次世代フィルター | [v2/README.md](v2/README.md) | 候補版。実サイト検証後に評価 |
| 実験用追跡フィルター | [v2/tracking-extra.txt](v2/tracking-extra.txt) | 4件の限定ホスト。**任意・既定無効**。実サイト検証未実施 |

購読URLは `https://raw.githubusercontent.com/r20942097-hue/s/main/` に各ファイル名を付けたものです。リポジトリの公開状態は確認済みです。20261011.1の更新差分と検証結果は [PR #3](https://github.com/r20942097-hue/s/pull/3) で確認できます。購読先は既定ブランチへの反映後に更新されます。

## 検証

Python 3.11以上で実行します。必須の外部Pythonライブラリはありません。

```sh
python -m unittest discover -s tests -v
python scripts/validate_lists.py
python scripts/generate_lists.py --check
```

標準検査はメタデータ、重複、include欠損・循環・範囲外参照、日本語表示ルールの回帰、生成一覧の同期を確認します。

`filter-profiles.json`を編集して`python scripts/generate_lists.py`で生成します。生成先のtxtを直接編集すると同期検査で失敗します。`ad-ubo.txt`と日本語フォント一覧は手動管理です。

生成前に、ヘッダー・ラベル・ルールの改行や制御文字、Versionの不一致、不正なホスト名を検査します。出力名・include名の各要素は255文字以下とし、出力名はWindowsでも使える相対パスに限定し、大文字小文字の衝突、予約デバイス名、ファイルとディレクトリの衝突を拒否します。検出した入力不備によって既存の生成物を部分更新しないよう、出力先を先に確認します。

任意の実エンジン検証にはNode.js 24と、初回のネットワーク接続が必要です。Python 3.12以上を推奨します。

```sh
python scripts/prepare_engine.py --directory ../work/filter-engine
node scripts/check_engine.mjs --engine-dir ../work/filter-engine
```

上流監査は固定した資料をハッシュ照合して参照箇所を抽出します。結果だけでルールを自動採用しません。

```sh
python scripts/audit_upstream.py --cache ../work/upstream-audit --fetch --report ../work/upstream-audit.json
```

任意の新規候補監査・差分抽出（外部サイトの候補を自動採用しません）：

```sh
python scripts/audit_filter_candidates.py --fetch-upstream
python scripts/scan_upstream_delta.py --fetch-upstream --crosscheck-independent --limit 40
python scripts/check_upstream_drift.py
python scripts/check_stable_fidelity.py --verify-base-tree  # 履歴Gitコミットを取得済みの環境
python scripts/compare_subscription_coverage.py --crosscheck-independent
# CIでは scripts/summarize_filter_gates.py が4検査結果を Job Summary に統合
```

**追跡防止機能は維持しています。** 安定版 `tracking.txt` の9件とDraft版 `v2/tracking.txt` の38件は分析・セッション記録・広告計測・ビーコン通信を対象とします。[追跡防止方針](docs/TRACKING_PROTECTION_POLICY.md)で、その維持、重複除去、将来のURL追跡パラメーター・CNAME対策の採用条件を説明しています。

**既定uBO Liteのblockルールと重複する7件は、Draftのv2活動リストから除外しました。** 活動候補0件とし、元の証拠は隔離台帳に保存。別途、既定uBO Liteで選択80ホストを画像・script・XHRで照合し、45件が既定遮断一致、34件が未一致、1件が未解決でした。追加ルールは未承認のままです。[根拠・候補一覧](docs/STOCK_GAP_REVIEW.md)。

公式uBO Liteへの隔離済み旧候補7件の実登録・解除試験が成功しました。隔離された一時HTTP配信とChromium環境で、7候補＋1テスト専用ルールを読み込み、登録前0→登録後block一致→解除後0のDNR照合を確認しています。これらは**仮想リクエストに対する拡張機能の判定**であり、実サイトの互換性や広告遮断効果の実測ではありません。

公式uBO Liteの既定DNRルールについて、候補7ホストの仮想第三者画像通信を確認した結果、**全7件が既定の`block`アクションに一致**しました。追加効果を無条件に認めないため、候補は採用保留のままです。対応リストはPeter Lowe 3件、EasyList 1件、EasyPrivacy 3件。実サイト通信・Firefox版uBOでは未検証です。詳細は [受入基準](docs/RELEASE_ACCEPTANCE.md) を参照してください。

公式uBO Liteの2026年10月26日版をSHA-256で固定し、CI中に一時取得してPlaywright Chromiumへ読み込む検証を追加しました。起動時の6つの既定DNRルールセットを確認していますが、**このPRの候補7ルールをuBO Liteへ登録する検証ではありません**。実サイトE2Eも未実施です。詳細は [受入ゲート](docs/RELEASE_ACCEPTANCE.md) を参照してください。

Chromiumの実際のMV3ネットワーク遮断機能を、**CI一時生成の試験用拡張**で検証する工程を追加しました。これは本物の拡張エンジンの動作を試すもので、既定のuBlock Origin／uBO Liteを読み込む試験ではありません。7候補のEasyPrivacy照合も個別に記録しますが、実効的な追加遮断の証明ではありません。

完成条件・公開前の未完了工程は [受入ゲート](docs/RELEASE_ACCEPTANCE.md) を参照してください。GitHub Actionsのbrowser fixtureは**実際のChromium/Firefox**で合成ページを検証しますが、模擬遮断にはPlaywrightのroute.abortを使用しており、実フィルター拡張のサイト互換性を実証しません。

隔離された合成ブラウザーテストをローカルで実行する場合（Playwright 1.64.1とそのChromium/Firefoxバイナリが別途必要）:

~~~sh
python scripts/browser_fixture_smoke.py
~~~

変更内容は[更新記録](CHANGELOG.md)、検証に使うバージョンは[エンジン固定情報](verification/engine-lock.json)です。公開ページの通信確認や合成画面テストは、認証・動画再生のE2Eとは区別します。

## ライセンス

ルートのフィルターはCC0-1.0、v2フィルターはGPL-3.0-onlyと各ファイルに宣言されています。詳細はファイルのヘッダーを確認してください。

## 任意の第2エンジン

Ghosteryの直接・間接依存は`verification/ghostery/package-lock.json`に固定しています。依存更新時は`engine-lock.json`の版・整合性情報も実際に確認して更新してください。

```sh
npm ci --prefix verification/ghostery --ignore-scripts --no-audit --no-fund
node scripts/check_engine.mjs --engine-dir ../work/filter-engine --ghostery-entry verification/ghostery/node_modules/@ghostery/adblocker/dist/esm/index.js
```

npm依存は検証用で、フィルターの購読や標準Python検査には不要です。CIは固定した2エンジンで確認します。
