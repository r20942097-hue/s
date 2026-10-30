# フィルターv2の完成条件・受入基準（2026-10-30）

現在の判定は **CANDIDATE / PUBLICATION_HOLD / NO_GO**。自動テストの成功は安全な正式公開を意味しません。既存URLとmainの公開ファイルを維持し、所有者の明示承認があるまでマージ・Release・本番同期を行いません。

正本の確認・議論は [Draft PR #14](https://github.com/r20942097-hue/s/pull/14) に集約します。

## 受入ゲートと未完了の工程

| 工程 | 受入要件 | 状態 |
|---|---|---|
| A. 原本保全 | 安定版8ファイルの固定Git tree一致、生成・検証、ZIP防止 | CI PASS |
| B. 候補監査 | 固定AdGuard・EasyPrivacy出典、例外、重複、2エンジン合成通信 | CI PASS |
| C1. ブラウザー試験環境 | 隔離Chromium/Firefoxで合成ページ・模擬遮断・フォームを試験 | CI PASS |
| C2. Chromium MV3標準遮断 | 使い捨ての最小拡張をインストールし、ブラウザー標準DNRで第三者画像を遮断、同一サイト通信を許可 | CI PASS（実uBOではない） |
| C3. 公式uBO Lite実物の起動 | SHA-256固定の公式Chromium ZIPを一時展開し、拡張サービスワーカーと既定DNRルールセットを確認 | CI PASS（独立起動試験、購読候補の検証ではない） |
| D. 本物の拡張による実サイト試験 | 実際のuBlock Origin・対応ブラウザーで各購読構成を検証 | NOT_RUN |
| E. 実質的な増分効果と安全性 | 既定リストとの差分とログイン・動画・フォームへの影響確認 | NOT_RUN |
| F. 最終公開承認 | 変更ファイルと実サイト証拠をレビューし、所有者が明示承認 | NEEDS_HUMAN |

A～C3がPASSでもD～FはPASSにならず、正式公開のGOを自動発行しません。

## ブラウザー試験の手順

- ChromiumはPlaywrightが配布するChromiumと一時プロファイルを使用します。コマンドライン経由の拡張機能の読み込みはGoogle Chrome/Edgeに依存せず、公式のlaunchPersistentContext方式で検証します。
- Firefoxは対象バージョンとuBlock Originの対応版を独立プロファイルに導入し、ブラウザー・拡張・購読リストの各バージョンを記録します。
- ベースライン（既定リスト）→候補あり→候補なしを同一条件で比較し、既定リストですでに遮断されるホストを今回の増分効果に含めません。
- 実サイトでは非ログイン閲覧、ログイン、検索、フォーム、決済前の画面操作、動画再生、埋め込み、例外への影響を確認します。認証情報や個人データをログに保存せず、決済実行は行いません。
- 再現不具合は症状・原因となるルール・環境・候補OFFでの比較を記録し、修正と再テストまでFAILとして扱います。実際に再現できない工程はBLOCKEDまたはNOT_RUNとします。

## 今回追加した実ブラウザー試験設備の限界

scripts/browser_fixture_smoke.py は本物のChromium/Firefoxを起動して合成ローカルサイトを操作しますが、フィルターの代わりにPlaywrightのroute.abortを使用する試験設備です。模擬ログイン/決済と遮断ビーコンの陽性対照を検査します。**uBlock Origin/AdGuard拡張そのもの、実サイト、実映像再生は検証しません。** それらをPASSと記載しません。

## ChromiumのManifest V3実拡張検証（模擬サイト限定）

scripts/chromium_dnr_fixture.py は一時ディレクトリに最小のMV3拡張を生成し、Playwright付属Chromiumの永続コンテキストへ読み込みます。外部通信や配布物の生成はせず、127.0.0.1／localhostのローカルHTTPだけを使用します。次の陽性・陰性対照を取ります。

- **拡張なし**では第三者側の画像通信が成功し、HTTPサーバーに到達する。
- **拡張あり**ではブラウザーのdeclarativeNetRequestにより第三者画像が失敗し、HTTPサーバーへ到達しない。
- 同じ拡張で、第一者側画像、模擬ログイン、模擬決済操作は維持される。
- 拡張のManifest V3 service workerと静的ルールセットの有効化を確認する。

これは**実際にChromium標準の拡張遮断エンジンを使う検証**ですが、候補ルールをDNR変換したものではなく、uBlock Origin／uBO Liteそのものでもありません。Firefoxでの実拡張検証、実サイトの互換性、動画再生の安全性はなおNOT_RUNです。ブラウザー環境の許可・拒否の基本挙動を実証するだけで、リリース判定のD/Eは解除しません。

## 候補7件の選択資料重複

scripts/compare_subscription_coverage.py の proposed_candidate_evidence は候補7件を個別に追跡し、選択したEasyPrivacyの2ファイルに同一または親ドメインのホスト全体ルールがあるかを照合します。**確認できたのは match.prod.bidr.io、event.getblue.io、sync.ebis.ne.jp の3件（親ドメイン参照）**です。残り4件はこの選択資料からは参照が見つからないだけで、EasyPrivacy全体・他のフィルターを通じた追加価値や安全性は未確定です。CIの集計とこの7件の台帳は自動採用を行いません。

## 公式uBO Lite Chromium版の隔離起動検査

公式 [uBlockOrigin/uBOL-home](https://github.com/uBlockOrigin/uBOL-home) の2026年10月26日リリースを、GitHubが公開するSHA-256で固定してテスト時のみ取得します。検証レジストリは verification/ubol-release-lock.json です。ZIPをコミット・Release・公開購読URLへ配置せず、CIの一時ディレクトリでサイズ・ハッシュ・ZIP内の危険なパス／symlink／重複を点検して展開します。

scripts/ubol_real_addon_fixture.py はPlaywright付属Chromiumへ**改変していない公式uBO Lite実体**を読み込み、Manifest V3のサービスワーカー、バージョン、標準DNRルールセットの有効化を検証します。最小のDNR試験用拡張とは別工程です。

追加の開発用API testMatchOutcome が使用できる場合、候補7件を仮想第三者画像リクエストとしてuBO Liteの既定ルールと照合します。ただし返された「一致」はルールの動作種別や実際の通信遮断そのものを保証しません。APIが利用不能ならNOT_SUPPORTEDとして保持し、無理に遮断成功とみなしません。

**依然として未検証**：このPRの候補7件をuBO Liteに購読登録したときの動作、Firefoxでの本物のuBOと実サイトの互換性、動画・ログイン・決済の実動作。公開ゲートD～Fは維持します。

## 上流資料の取得最適化

FILTER_PINNED_CACHE_DIRを指定すると固定Git Blobを同一CIジョブ内で一時共有し、毎回SHA整合性を確認します。壊れたキャッシュは黙って再取得せずFAILとします。実行間での永続キャッシュは使用せず、購読ルールへ自動反映もしません。

## 正式公開前の停止条件

既存URL・原本変更、候補リストの無断取り込み、出典欠落、互換性不具合、実サイト検証不足、所有者未承認のいずれかがあればNO_GOのまま維持します。

次の最優先工程は、FirefoxおよびChromiumで実際の対象拡張を用いた検証と、その結果による候補ごとの採否判断です。
