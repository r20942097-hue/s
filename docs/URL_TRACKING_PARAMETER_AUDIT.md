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

## 採用条件

- 既定uBO Lite／Firefox uBO／AdGuardと重複する除去処理は追加しない。
- 無差別に全パラメーターを削除しない。候補は特定パラメーター、サイト、通信種別に狭める。
- 既定OFF→候補ON→候補OFFでの増分効果と署名／認証URLの陰性対照が必要。
- 実サイト検証・安全性・実効性が未確定である限り、**新規URL除去ルール0件、正式公開NO_GO**。

## CI効率化

複数のブラウザーテストが同じ公式ZIPを重複ダウンロードしていたため、FILTER_UBOL_CACHE_DIRに指定した**そのCIジョブ限りの一時保存**に変更。毎回、固定リリースのバイト数とSHA-256を検証し、破損なら失敗。永続キャッシュ・Git管理へのZIP保存は行わない。
