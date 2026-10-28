# StreamHarbor / RPLAY v0.16 — 開発版 (CANDIDATE / NO_GO)

このフォルダは **開発・検証用** のソースツリーです。実ブラウザと実配信での受入前に正式リリースとして扱わないでください。

- StreamHarbor統合開発版: **v0.16**
- 継承したRPLAYコア / Chrome・Firefox manifestのバージョン: **2.56.0** (意図的に据え置き)
- 変更概要: `CHANGELOG_V016.md`
- 検証範囲と未検証項目: `STREAMHARBOR_V16_QA.md`
- 旧版README (履歴確認用): `docs/LEGACY_README_FROM_V015.md`

## ディレクトリ

| パス | 役割 |
|---|---|
| `src/` | 編集するソースの原本。特に `player.user.js` / `hls_transport.js` / `offscreen_post.js` / `background.js` / `dashboard.js` |
| `scripts/build.py` | 原本からUserscript、CLI、Chrome/Firefox共有コードを生成 |
| `rplay-stable-player-extension/` | Chrome/Chromium系の開発版・実行物 |
| `rplay-stable-player-extension-firefox/` | Firefox向け開発版・実行物 |
| `rplay-stable-player.user.js` | 生成済みUserscript（直接編集せずsrcを編集） |
| `tests/` | Node.js / Pythonの単体・合成・ローカルHTTPテストとカバレッジ基準 |
| `libs/`, `licenses/` | 同梱依存アセットとライセンス情報 |

## 開発と検証

前提はNode.jsとPython。FFmpeg/ffprobeを使う検証は環境にインストールされている必要があります。

```bash
python scripts/build.py
node --test --test-reporter=spec --test-force-exit --test-concurrency=4 --test-timeout=180000 tests/test_*.cjs
python scripts/run_python_tests.py
python scripts/validate.py --output-dir evidence/verification-local
```

`validate.py` はスクリプト構文、manifest、生成物のバイト同一性と両言語の全回帰を再実行します。`SHA256SUMS.json` はソース配布物ごとに生成したファイルのハッシュ台帳です。

## 今回の重要変更

音声源切替時に既に発行されていたネットワーク応答が遅れて戻っても、旧世代の再試行を新音声源の取得キューに戻しません。旧世代の完了が新世代の「処理中」マーカーを消さないようにし、無視した遅延結果回数を診断カウンターとして分離しました。

この件数はメディア欠落・破損・音声同期の実測値ではなく、クラッシュ復旧後は永続化済みの**下限値**のみ保持します。

## インストール上の注意

Chrome/Firefox用のZIPを展開して、対応ブラウザーの開発者向け読み込み機能でテストしてください。本番プロフィールへ既存版と同時導入すると設定/保存が競合する可能性があります。テストプロフィールなど分離した環境で確認してください。
