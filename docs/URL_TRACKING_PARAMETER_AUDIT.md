# URL追跡パラメーター：既定保護・互換性調査

更新日：2026-10-30。Draft PR #14専用。main・公開購読URL・安定版8ファイルは変更しない。

## 目的

追跡防止を維持しつつ、**既定ブロッカーで対策済みのURLパラメーターを重複追加しない**。ログイン認証・OAuth・決済・署名付きURLを破損する全クエリ削除は採用しない。

[uBlock Origin公式構文](https://github.com/gorhill/uBlock/wiki/Static-filter-syntax)ではremoveparamはURLを変更する修飾子で、MV2全面・MV3一部対応。[AdGuard公式構文](https://adguard.com/kb/general/ad-filtering/create-own-filters/)でもremoveparamに対応するが、既存URL Trackingリストとの重複、信頼済みリスト制約、実装差がある。すべてのブラウザーで同じ効果があるとは仮定しない。

## 検証の2段階

**第1段階：公式uBO LiteのDNR、仮想通信**

scripts/ubol_query_param_probe.py が公式uBO Lite 2026.1026.1812（SHA-256固定）を隔離Chromiumで起動。追跡パラメーター utm_source、utm_campaign、fbclid、gclid、msclkid と、保持が必要な陰性対照 state、code、token、redirect_uri、X-Amz-Signature の計10種類について、仮想ナビゲーションとXHRの20ケースでtestMatchOutcomeを照合し、ルールIDと実際の公式ZIP内のDNRアクションを比較する。

[2026-10-30 CI run 41063690594](https://github.com/r20942097-hue/s/actions/runs/41063690594)では20ケース中、既定DNRのredirectアクションに6ケースが一致し、14は一致せず、未解決0。**redirect一致だけでは実際にパラメーターが削除されたことの証明にならない。**

**第2段階：ローカルHTTPでの実要求**

scripts/ubol_local_param_http_probe.py は予約済み tracking-fixture.test を一時的なChromiumのDNS設定で127.0.0.1へマップし、拡張なしと公式uBO Liteありで実際にローカルHTTPサーバーが受信するクエリを比較する。追跡側 utm_source、fbclid、gclid と、保持すべき state、code、X-Amz-Signature を調べる。認証・署名用のキーや「keep」対照が破損すればテスト失敗。

外部サイトにアクセスせず、ユーザーのブラウザープロファイルは変更せず、ローカルの一時環境のみで行う。この結果は本番EC・ログイン・動画・決済サイトの互換性を保証しない。

## 第2段階の実測結果・第3段階の試験用ルール

2026-10-30の[CI実測](https://github.com/r20942097-hue/s/actions/runs/41064756619)では、同じローカルHTTPサイトで**公式uBO Liteあり／なし**を比較した結果、次のように観測された。

| 実HTTPで受信したパラメーター | 公式uBO Lite既定状態 |
|---|---|
| fbclid、gclid | 既定で除去された |
| utm_source | そのまま残った |
| state、code、X-Amz-Signature | すべて保持された |

仮想通信のDNR照合20件では、fbclid/gclid/msclkidに対する2通信種別の計6件がredirectへ一致。utm_sourceとutm_campaignはredirect一致なし。この結果はループバック環境での観測であり、インターネット上の個別サイトへの適用や安全性は未確定。

**第3段階（新実装）** scripts/ubol_param_import_lab.py は、公式uBO Liteに試験用の単一ルール「removeparam=utm_source」をローカルHTTPから取り込み、同じローカルサイトで実HTTPによる削除と解除後の復帰を確認する。

- 登録前：utm_sourceがURLに残る。
- 試験ルール登録後：utm_sourceが削除される。
- リスト登録解除後：utm_sourceが再び残る。
- fbclid/gclidの既定除去は維持。state・code・X-Amz-Signature単独の保持も確認する。

**重要な新実測**：[CI run 41066213386](https://github.com/r20942097-hue/s/actions/runs/41066213386)では、utm_sourceを含む架空のHMAC署名付きURLを同じループバックHTTPサーバーへ送信し、次のことを確認した。

- グローバルなremoveparam登録前：架空URLのHMAC署名は有効。
- グローバルなremoveparam登録中：utm_sourceが削除され、**HMAC署名が不一致（BROKEN）**。
- 登録解除後：utm_sourceとHMAC署名の整合性が回復。

したがって**全サイト向けの広域utm_source除去ルールは採用しない**。今後は追跡専用のホスト／URLパスなどの限定条件と、認証・署名URLの除外を先に設計する。これは**架空のHMAC署名**で検証したもので、実サイト上の認証・決済・署名付きリクエストへの実害を直接測定した結果ではない。FirefoxフルuBO・実サイトE2Eも未実施。[詳細な検査記録](../verification/url-parameter-lab.json)を保全する。

## 採用条件

- 既定uBO Lite／Firefox uBO／AdGuardと重複する除去処理は追加しない。
- 無差別に全パラメーターを削除しない。候補は特定パラメーター、サイト、通信種別に狭める。
- 既定OFF→候補ON→候補OFFでの増分効果と署名／認証URLの陰性対照が必要。
- 実サイト検証・安全性・実効性が未確定である限り、**新規URL除去ルール0件、正式公開NO_GO**。

## CI効率化

複数のブラウザーテストが同じ公式ZIPを重複ダウンロードしていたため、FILTER_UBOL_CACHE_DIRに指定した**そのCIジョブ限りの一時保存**に変更。毎回、固定リリースのバイト数とSHA-256を検証し、破損なら失敗。永続キャッシュ・Git管理へのZIP保存は行わない。
