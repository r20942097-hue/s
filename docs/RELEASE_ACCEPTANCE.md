# フィルターv2の完成条件・受入基準（2026-10-30）

2026年10月30日の追加判定：既定フィルターと重複した7ルールは活動候補から除外（v2/tracking.txtから3、実験用v2/tracking-extra.txtから4）。後者は隔離マーカー付きのゼロルールファイルに変更しました。出典と履歴はverification/filter-candidates.jsonに保管。別候補80件をスクリーニングし、34件が3種の仮想通信で未一致、45件は既定block一致、1件は未解決です。**新規採用ゼロ**。詳細は[重複除去と新候補](STOCK_GAP_REVIEW.md)。

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
| C4. 公式uBO Liteへの候補リスト登録と解除 | 候補7件＋テスト用1件をローカルHTTPから公式拡張で取得・コンパイル・有効化し、DNRへの追加と解除後の復帰を照合 | CI PASS（隔離環境／仮想通信） |
| D. 本物の拡張による実サイト試験 | 実際のuBlock Origin・対応ブラウザーで各購読構成を検証 | NOT_RUN |
| E. 実質的な増分効果と安全性 | 既定リストとの差分とログイン・動画・フォームへの影響確認 | NOT_RUN |
| F. 最終公開承認 | 変更ファイルと実サイト証拠をレビューし、所有者が明示承認 | NEEDS_HUMAN |

A～C4がPASSでもD～FはPASSにならず、正式公開のGOを自動発行しません。

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

## 公式uBO Lite既定ルールによる候補7件の再評価（重要）

2026年10月26日公式ChromiumリリースのSHA-256固定ZIPを改変せずに起動した検証では、既定DNRルールセット6個の有効化を確認しています。さらにChromeの開発用 `declarativeNetRequest.testMatchOutcome()` で、候補7ホスト宛の仮想第三者画像通信（HTTPS、`pixel.gif`、適用元 `https://example.org/`）に一致したルールIDを取得し、**同じ公式ZIPの静的ルールJSON内のアクション定義と突き合わせました。7件とも `block` アクションでした。**

| 候補ホスト | 一致した既定ルールセット | 仮想通信のアクション |
|---|---|---|
| match.prod.bidr.io | Peter Lowe (pgl) | block |
| sync.adkernel.com | EasyList | block |
| sync.richaudience.com | Peter Lowe (pgl) | block |
| id5-sync.com | Peter Lowe (pgl) | block |
| event.getblue.io | EasyPrivacy | block |
| sync.ebis.ne.jp | EasyPrivacy | block |
| pixel.wetracked.io | EasyPrivacy | block |

この結果は「選択したEasyPrivacyの2ファイルだけでは4件を検出できなかった」という先行観測と矛盾しません。実際のuBO Liteには**他の既定リストも含まれている**ためです。これまでの「選択2ファイルで一致なし」を「増分効果あり」と解釈してはなりません。

**判断**：少なくともこのバージョンの既定uBO Liteで上記の仮想通信を遮断する目的なら、候補7件の追加は重複しています。現在のDraft PRでは採用保留を維持します。Firefox版uBlock Origin、他のフィルター構成、実サイト固有の例外・正常機能との関係は未確定であり、実リクエストでの遮断やログイン・動画・決済の互換性をPASSとはしません。仮想リクエストはChromeの開発用APIによる予測であり、実通信のE2Eではありません。

## 候補7件の選択資料重複

scripts/compare_subscription_coverage.py の proposed_candidate_evidence は候補7件を個別に追跡し、選択したEasyPrivacyの2ファイルに同一または親ドメインのホスト全体ルールがあるかを照合します。**確認できたのは match.prod.bidr.io、event.getblue.io、sync.ebis.ne.jp の3件（親ドメイン参照）**です。残り4件はこの選択資料からは参照が見つからないだけで、EasyPrivacy全体・他のフィルターを通じた追加価値や安全性は未確定です。CIの集計とこの7件の台帳は自動採用を行いません。

## 公式uBO Lite Chromium版の隔離起動検査

公式 [uBlockOrigin/uBOL-home](https://github.com/uBlockOrigin/uBOL-home) の2026年10月26日リリースを、GitHubが公開するSHA-256で固定してテスト時のみ取得します。検証レジストリは verification/ubol-release-lock.json です。ZIPをコミット・Release・公開購読URLへ配置せず、CIの一時ディレクトリでサイズ・ハッシュ・ZIP内の危険なパス／symlink／重複を点検して展開します。

scripts/ubol_real_addon_fixture.py はPlaywright付属Chromiumへ**改変していない公式uBO Lite実体**を読み込み、Manifest V3のサービスワーカー、バージョン、標準DNRルールセットの有効化を検証します。最小のDNR試験用拡張とは別工程です。

追加の開発用API testMatchOutcome が使用できる場合、候補7件を仮想第三者画像リクエストとしてuBO Liteの既定ルールと照合します。ただし返された「一致」はルールの動作種別や実際の通信遮断そのものを保証しません。APIが利用不能ならNOT_SUPPORTEDとして保持し、無理に遮断成功とみなしません。

**進捗更新**：PRの候補7件を隔離ローカルHTTPサーバーから公式uBO Liteに取り込み、登録・コンパイル・有効化・削除を確認しました。詳細は次節。**依然として未検証**なのは実際の配布URLを購読した動作、Firefox版の本物のuBO、一般の実サイト互換性、実動画・ログイン・決済の動作です。公開ゲートD～Fは維持します。

## 公式uBO Liteに候補リストを実登録・復元（C4、2026-10-30）

`scripts/ubol_imported_list_fixture.py` は、固定SHA-256で確認した公式uBO Liteを隔離Chromiumプロファイルへ**改変せず読み込み**、PR内の7候補を一時的な `127.0.0.1` HTTPサーバーから配信して、uBO Lite自身の公式 `importFilterList` メッセージ処理で追加します。公開GitHub購読URLは一切変更・登録しません。

登録試験には候補7件とは別に `||isolated-import-test.invalid^$third-party` を1件追加しています。これは**試験専用の予約済みTLDを使う制御ルール**であり、`filter-profiles.json` や配布フィルターには存在しません。

| 段階 | 必須の証拠 | 2026-10-30 CI |
|---|---|---|
| 事前対照 | テスト専用ホストへの仮想第三者画像通信は既定DNRに一致しない | PASS |
| 登録・コンパイル | 公式拡張がローカルの一覧を取得。候補7＋制御1の計8ルール受理、登録・有効化、コンパイル結果を保存 | PASS |
| 実効状態 | Chromiumの `testMatchOutcome()` が制御ホストへの`block`ルール一致を返す | PASS |
| 削除・復元 | 公式`applyRulesets`経路で一覧を削除後、制御ホストのDNR一致が0件に戻る | PASS |

`scripts/verify_browser_gates.py` が、この試験と既存のFirefox/Chromium合成ブラウザー試験、ChromeのネイティブMV3試験、公式uBO Lite既定ルール照合の4レポートを照合し、結果が欠ける場合や`NOT_RUN`を実施済みと偽装した場合はCIをFAILにします。

この手順は**実拡張によるルールの取込み・適用・解除**を検証しますが、通信を実際に送信して遮断を実測したテストではありません。候補7件は公式uBO Liteの既定ルールで既に遮断対象となるため、候補導入による増分価値は未確定です。実サイト・実拡張の相互作用、Firefox版uBO、リスト購読URLの実運用についてはD/Eが未達のままです。

## 上流資料の取得最適化

FILTER_PINNED_CACHE_DIRを指定すると固定Git Blobを同一CIジョブ内で一時共有し、毎回SHA整合性を確認します。壊れたキャッシュは黙って再取得せずFAILとします。実行間での永続キャッシュは使用せず、購読ルールへ自動反映もしません。

## 正式公開前の停止条件

既存URL・原本変更、候補リストの無断取り込み、出典欠落、互換性不具合、実サイト検証不足、所有者未承認のいずれかがあればNO_GOのまま維持します。

次の最優先工程は、FirefoxおよびChromiumで実際の対象拡張を用いた検証と、その結果による候補ごとの採否判断です。
