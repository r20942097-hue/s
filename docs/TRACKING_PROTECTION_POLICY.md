# 追跡防止機能の維持・拡張基準（2026-10-30）

## 確定方針

**追跡防止を削除しない。既定フィルターで遮断済みのルールを増やさず、実効的な追加保護を目指す。** 旧7候補は公式uBO Liteの既定DNRで重複が確認されたため活動ルールから隔離し、調査記録として保全する。

現在の活動ルール数（Draft PR #14）：`tracking.txt` 9件（mainと同一）／`v2/tracking.txt` 38件（候補版）／`v2/tracking-extra.txt` 0件（隔離プレースホルダー）。この数値は**配置したルール数**であり、実サイトの遮断数・トラッカー捕捉率・プライバシー性能の測定値ではない。

## 既にルールが存在する対象

| 対象 | 維持しているルールの例 | 配置 |
|---|---|---|
| 第三者アクセス解析 | `google-analytics.com`、`mixpanel.com` | 安定版・v2 |
| セッション記録・操作分析 | `hotjar.com`、`fullstory.com` | 安定版・v2 |
| 広告成果・リターゲティング計測 | `bat.bing.com`、`px.ads.linkedin.com` | v2 |
| 計測用ビーコン | `beacon.geniee.jp` | v2 |

これらは第三者リクエストに限定したホスト型ネットワークフィルターで、すべての計測通信・同一サイト追跡・指紋採取を遮断するわけではない。**既定のEasyPrivacy等との重複や、個別サイトへの影響は別途判定する。**

## 将来の追跡防止機能は差分が確認できたものだけ

| 機能 | 状態 | 理由 |
|---|---|---|
| 計測・広告識別子のURLパラメーター除去（`removeparam`） | 調査対象 | uBOはMV2とMV3で対応範囲が異なる。AdGuard URL Trackingなど既存機能と重複し得る。ログイン、決済、紹介URLや署名付きURLの破損リスクがある |
| CNAMEを介した第一者追跡 | 調査対象 | DNS処理やFirefox／Chromiumで挙動が異なるため、ホスト全体遮断は行わない |
| JavaScript APIによるフィンガープリンティング | 調査対象 | 通常のネットワークリストでは完全対策できない。ブラウザー設定や対応拡張を検証する |
| Global Privacy Control（GPC） | ブラウザー設定の領域 | ホスト遮断ルールではなくブラウザーが送る信号。リストへ架空のGPC対策ルールを追加しない |

公式資料：
- [uBlock Origin 静的フィルター構文／removeparam](https://github.com/gorhill/uBlock/wiki/Static-filter-syntax)
- [AdGuard Tracking Protection](https://adguard.com/kb/adguard-for-windows/protection/tracking-protection/)
- [AdGuardフィルター方針](https://kb.adguard.info/kb/general/ad-filtering/filter-policy/)

## 採用前の必須チェック

1. **既定フィルターとの差分**：対象ブラウザーの既定EasyList／EasyPrivacy／Peter Lowe／AdGuard等で同等に遮断・除去されていないかを確認する。
2. **エンドポイントの特定**：ドメイン全体ではなく実際の追跡パスやリソース種別まで確認し、正常機能・エラー計測との区別を行う。
3. **陽性／陰性対照**：候補OFF→ON→OFFで実通信・サイト機能を比較し、増分効果と副作用を記録する。
4. **実装差の検証**：Firefox uBO、Chromium uBO Lite、AdGuard／ABP対応範囲が異なる場合、機能／購読リストを分ける。
5. **リリース許可**：実サイト・フォーム・ログイン・動画・決済の互換性に問題がなく、所有者が明示承認した後のみ公開を検討する。

`scripts/check_tracking_protection.py` と `verification/tracking-protection-policy.json` が、重要な追跡対策の消失、既定遮断と重複した旧候補7件の再導入、未検証の追跡防止機能をPASSと誤表示する変更を検出する。これは**構造的な品質保証**であり、実運用の追跡防止性能を保証しない。

**現時点の結論：追跡防止要素は活動状態を維持、新規重複ルールは追加しない、実サイト効果はNOT_RUN、正式公開NO_GO。**
