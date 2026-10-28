# StreamHarbor / RPLAY v0.16 - v0.15との差分

## 修正（重要）

1. `AudioRecorder.drain()` が旧音声源に属する非同期取得結果を受け取った場合、HLS世代を確認して新音声源に混ぜずに破棄します。旧結果が`retry:true`の場合に新キューへ再挿入されうる競合を防止。
2. 処理中の世代番号`_inFlightSegmentGeneration`を記録し、新しい世代の処理状態が古いPromiseの`finally`で誤消去されないようにします。
3. 直後の音声切替で旧世代の同じ処理を繰り返し計上しないよう、現在の世代に属する処理のみを`activeSegmentAtSourceChange`に計上。
4. `staleSegmentResultsIgnored`（旧世代からの遅延結果を不採用にした回数）を新設。スナップショットでは`audioStaleResultsIgnored`として安全な非負整数のみ保存し、復旧後は少なくともその値という**下限**表示。オーバーフローを抑止。
5. offscreen→background→dashboard→録画情報JSONの診断伝達を更新。URL・Cookie・トークンを新設診断フィールドへ含めません。

## 変更なし

- コアバージョンと拡張マニフェストは引き続き2.56.0。自動インストール / 自動移行はしません。
- 既存の保存・MP4変換・OPFS・クロスサイト機能は保持。
- 不明な音声欠落の自動埋め戻し、実ブラウザの全編再生とA/V同期保証は未実装・未検証。

## 開発者向け

`src/player.user.js`, `src/offscreen_post.js`, `src/background.js`, `src/dashboard.js`が更新対象です。新規回帰は `tests/test_audio_generation_v16.cjs`（9件）。
