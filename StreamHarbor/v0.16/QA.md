# StreamHarbor / RPLAY v0.16 — QA 結果

**判定: CANDIDATE / NO_GO**

- 基点: ユーザーのv0.15 `StreamHarbor_RPLAY_v0.15_AUDIO_INFLIGHT_RECOVERY_CANDIDATE_NO_GO.zip`。
- 重要変更: 古い音声ソースに属する遅延セグメント結果・再試行の新音声源キューへの混入防止、世代別in-flightマーカー、遅延結果の下限診断。
- Node.js: 128 test files, **1,318 PASS / 0 FAIL** (現セッションで再実行)。新規9件。
- Python: **全276 PASS / 0 FAIL**。カバレッジガード `PYTHON_COVERAGE_PASS 276`。Node+Python合計 **1,594 PASS**。
- `python scripts/build.py`: 実行済み（共有生成コードの更新）。
- 元v0.15 ZIP: CRC PASS、3,914エントリ。

**未受入**: 実Chrome/Firefox/Floorpのインストール・復旧、Windows実機、RPLAYその他サイト実配信、長時間録画、転送中の切替とディスク書込み競合、全編デコード、PTS/DTS/音声同期、実ブラウザー統合試験。

旧世代の結果を意図的に捨てた件数は音声欠落数でも救済できた件数でもありません。ログとUIは推測を確定事実として表記しません。

## 自動試験範囲の限界

この結果はメディアの欠落・A/V同期不良が実サイトで発生しないことを保証しません。特に旧世代の`HLS.append()`が書込中に切替された場合の実ファイル確定競合には別途ブラウザー試験・プロファイル検証が必要です。`staleSegmentResultsIgnored`は損失ではなく古い応答の不採用回数です。
