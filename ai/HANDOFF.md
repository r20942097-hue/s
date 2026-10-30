# HANDOFF — 次のAIへ（2026-10-28 更新）

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


## 2026-10-30｜Chromium Native DNR・候補別レビューを追加

- scripts/chromium_dnr_fixture.py はPlaywright付属Chromiumへ一時MV3拡張を読み込み、実ブラウザー標準DNRで第三者ビーコンを遮断したことをHTTP到達数で検証する。uBO/uBOL・実サイトとは明確に別工程。
- scripts/compare_subscription_coverage.py に proposed_candidate_evidence 7件を追加。EasyPrivacy固定2ファイルで親ホストルールが対応するのは3件。残り4件は未掲載と断言せず「今回の2資料に一致なし」、全件増分価値未確定。
- CI browserジョブは旧Playwright模擬通信のChromium/Firefox対照試験に加え、Chromium Native DNRもPASSが必要。未検証の実拡張・本番サイト検証と公開承認は残る。
- docs/RELEASE_ACCEPTANCE.md のC1/C2を確認。正式公開は引き続きNO_GO。

## 2026-10-30｜フィルターv2完成優先の引継ぎ

- Draft PR: https://github.com/r20942097-hue/s/pull/14 （未マージ）。リリース判定は **NO_GO / NEEDS_HUMAN**。既存購読URL、安定版8ファイル、mainは保全。
- 詳細な受入条件: docs/RELEASE_ACCEPTANCE.md。実ブラウザーを起動する合成試験は、広告ブロック拡張の実サイトE2Eとは別の工程。
- 不変上流Git Blobの照合は scripts/pinned_snapshot_cache.py がオプションで同一CI実行内に限定して再利用する。ハッシュは毎回検査し、未審査の更新は採用しない。
- リリース前に必要: Firefox/uBO と対応するChromium側の実際のフィルター購読・動作検証、既定リストからの実質的な増分効果、ログイン・フォーム・動画・決済画面の互換性、所有者承認。
- 開発優先度: 既存テストがPASSしたら無制限な追加ルールの収集は中断。実サイト検証と不具合対応を優先。候補を安全と断言しない。
- 本ブランチでの検証: python -m unittest discover -s tests -p 'test_*.py' -v、python scripts/validate_lists.py、python scripts/generate_lists.py --check、GitHub Actions「Filter list checks」（test / engine / browser fixture）。
- **完成/公開**と**合成テスト成功**を混同しない。後続AIはPRの最新HEAD・CI runの結論を毎回取得し、古いメモリのPASS件数をそのまま引用しない。

## 2026-10-30｜公式uBO Lite実物起動ゲート（追加）

- verification/ubol-release-lock.json は公式リリース2026.1026.1812のChromium ZIP（9,009,606 B）とSHA-256を固定。実行時のみ取得し、ZIP自体はGitに追加しない。
- scripts/ubol_real_addon_fixture.py はChromiumの一時プロファイルで **改変のない実際のuBO Lite** を起動して、MV3サービスワーカーおよび標準DNR 6ルールセット有効化を確認。CI初回はローカライズ済み表示名とManifestの__MSGキーを比較して誤失敗したため修正し、起動PASSを取得済み。
- 開発専用testMatchOutcomeによる7候補の仮想通信への既定ルール照合は、使用可能な場合のみ「一致したルール」扱い（実際の遮断とは区別）。本件は実uBO Liteへ候補リストをインポートしておらず、Firefox実uBO・本番サイトも未検証。
- docs/RELEASE_ACCEPTANCE.md を正本とし、C3とD/E/Fを混同しない。Draft PR #14はNO_GO、mainおよび公開URLは変更しない。

## 2026-10-30｜既定uBO Lite DNR 7候補の独立検証

- 実Chromium上で公式uBO Liteの標準DNRルールセット6件を有効化したうえで、Chromeの開発用testMatchOutcomeに候補7ホストを第三者画像通信として照会。ヒットしたruleId/rulesetIdを固定ZIPの静的ルールJSONと照合し、**7/7 blockアクションを確認**。
- 内訳：pglがmatch.prod.bidr.io、sync.richaudience.com、id5-sync.com；EasyListがsync.adkernel.com；EasyPrivacyがevent.getblue.io、sync.ebis.ne.jp、pixel.wetracked.io。
- 狭いEasyPrivacy2資料で未検出の4件も既定uBO Lite内の別ルールに遮断対象がある。**新規7件は保留を推奨**。この観測は仮想通信に限定され、Firefox版uBO・実サイトの価値や安全性は未確定。
- PR #14の候補は人手の正式採否までDraft／NO_GO。最新のGitHub Actionsを確認し、古い未検証・アクション0件の中間実行結果で判断しない。

## 2026-10-30｜公式uBO Lite外部購読・解除、C4を追加

- `scripts/ubol_imported_list_fixture.py` はリポジトリ内の3+4候補を隔離HTTP `127.0.0.1` で配信し、公式拡張のダッシュボードメッセージ経路でインポート、コンパイル、DNR適用・解除を検証。ダウンロードした公式拡張とブラウザープロファイルは一時ディレクトリのみ。
- 追加の`isolated-import-test.invalid`は純粋なテスト制御用で、配布対象・候補7件には含めない。制御用ホストのDNR一致が0→block→0と可逆に変化することを、実際のuBO Lite拡張に対するChromium仮想通信APIで確認した。
- `scripts/verify_browser_gates.py` が隔離テスト4系統のレポートと状態を統合。CIのJob Summaryに記録する。現実のサイトへの通信、ログイン・決済・映像の実動作、Firefox上の公式フルuBOはNOT_RUN。
- `docs/RELEASE_ACCEPTANCE.md` のC4を完成。D～Fは未達。main/既存購読/安定版保全、Draft/NO_GOを維持。

## 2026-10-30｜既定フィルター重複排除方針（最新）

- **7つの旧候補は活動フィルターへ戻さない**。3つはv2/tracking.txt、4つはv2/tracking-extra.txtから除去済み。後者は厳密な`! Status: QUARANTINED_NO_ACTIVE_RULES`付き0ルール文書として残す。verification/filter-candidates.json/quarantineに元出典を保全。mainと既存公開リストは変更しない。
- scripts/audit_filter_candidates.pyが7件の隔離・活動ルール0件を検証。実uBO Liteのインポート試験は隔離した元証拠を使う実験だけで、PRの活動出力に復活させない。
- scripts/ubol_stock_gap_probe.pyで固定AdGuardレビュー先頭の低リスク80件を実uBO Lite既定DNRへ読み取り専用照合：既定遮断45、3種通信未一致34、未解決1。これは非代表標本・仮想通信であり、34を安全／追加価値ありと認定しない。
- 次の審査候補はadtrace.ai、adbrix.io、adtasukaru.com。用途は外部資料で確認したがサービスドメインのため、ホスト全体遮断ではなく個別エンドポイント・サイト正常動作を確認する。
- 詳細なデータと許容範囲: docs/STOCK_GAP_REVIEW.md、docs/RELEASE_ACCEPTANCE.md。新規活動ルール0、公開NO_GOのまま。
