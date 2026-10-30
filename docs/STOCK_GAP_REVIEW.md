# 重複除去と新候補の調査（2026-10-30）

## 判断

**既定uBO Lite 2026.1026.1812の実際のDNRルールと重複する7件をDraft版の活動ルールから隔離しました。** 3件はv2/tracking.txtから除去。4件はv2/tracking-extra.txtの活動ルール数をゼロに変更し、同ファイルは明示的な隔離マーカー付きのプレースホルダーです。変更前の7ルール・出典・リスクは verification/filter-candidates.json の quarantine に残しました。

これは**Draft PR #14のみ**への変更であり、main、安定版8ファイル、既存購読URLは変更しません。

## 既存ルールとの重複を判定する方法

- 文字列・同一ホストに加え、親ドメインによる遮断、リソース種別、例外、標準DNRの実際のマッチを区別します。
- 広く使われるEasyList・EasyPrivacy・Peter Loweを含む既定uBO Liteは、単一の選択済みEasyPrivacyファイルより広い遮断範囲を持ちます。
- uBOは同一ルールを重複排除します。ルール追加の品質指標は件数ではなく、**既定構成との差分と破損率**です。参照：[uBO フィルターリスト公式説明](https://github.com/gorhill/uBlock/wiki/Dashboard:-Filter-lists)、[静的フィルター構文](https://github.com/gorhill/uBlock/wiki/Static-filter-syntax)。

## 新しい追加候補の一次検査

`scripts/ubol_stock_gap_probe.py` は、固定コミット `d24169d99d6b81377a355a070597ace818016d9c` のAdGuard追跡リストと固定EasyPrivacy2ファイルの情報を用いて、選択例外・ローカル既存遮断を除外したレビュー先頭ページから80件を抽出しました。公式uBO Liteの改変なしのChromium拡張で、第三者画像・スクリプト・XHRの仮想通信3種類を照合しました。

| カテゴリ | 件数 |
|---|---:|
| 既定DNRにblockアクション一致 | 45 |
| 3通信種別で既定block一致なし | 34 |
| ruleIdのアクション未解決 | 1 |

**これは80件の偏った先頭ページ標本です。** 全2,714件の候補全体の割合や、実サイトの効果を推定してはいけません。疑似通信で未一致でも、そのドメインの別URL、別通信種別、CNAME、他の有効フィルター、例外による挙動は不明です。実HTTP要求とライブサイト互換性は未検証。

### 用途確認まで進んだ候補（追加は未承認）

| ドメイン | 固定AdGuard出典 | 補助確認 | 主なリスク | 現状 |
|---|---|---|---|---|
| `adtrace.ai` | tracking_servers.txt L826 | [公式サイト](https://www.adtrace.ai/)：EC広告計測・ピクセル・アトリビューション | ECの計測・広告最適化や管理画面への影響 | 要エンドポイント特定 |
| `adbrix.io` | 同 L1599 | [Xパートナー情報](https://partners.x.com/en/partners/adbrix)：アトリビューション・アプリ分析 | SDK・アプリ計測とサインアップ導線への影響 | 要エンドポイント特定 |
| `adtasukaru.com` | 同 L120 | [公式サイト](https://adtasukaru.com/)：広告成果データ連携 | 成果計測・管理機能への影響 | 要エンドポイント特定 |

いずれも固定AdGuard資料に`||HOST^$third-party`形式で掲載され、選択したEasyPrivacy2ファイルと選択AdGuard許可資料に一致しなかったものです。今回のuBO Liteの3通信種別では既定blockが確認できませんでした。ただし、**ホスト全体を一律遮断するには情報不足**です。

次の確認は、サイト上で実際に利用されるサブドメイン・パス・通信種別を特定し、既定フィルターON／OFF、候補ON／OFF、ログイン・購入画面・動画やUIの破損を比較することです。実通信の証拠を得るまでは`0 new rules`を維持します。

## 開発上の保護

- 7件を戻す操作は`scripts/audit_filter_candidates.py`の監査エラーにします。
- `v2/tracking-extra.txt`の空ルールを許すのは`! Status: QUARANTINED_NO_ACTIVE_RULES`がある**厳密にこのファイルだけ**です。他の空リストはエラーにします。
- 新候補の調査結果はあくまでCIの一時JSONとこの記録にとどめ、生成済みリストに追加しません。
- 正式公開`NO_GO`、実サイト`NOT_RUN`、所有者承認`NEEDS_HUMAN`を継続します。
