// ==UserScript==
// @name         RPLAY Stable Player (App-style Reconnect)
// @name:ja      RPLAY 安定化プレイヤー(アプリ式自動再接続)
// @namespace    rplay.stable.player
// @version      2.56.0
// @description  Add-on player for RPLAY live replicating the mobile app's resilience (HLS+FLV failover, aggressive auto-reconnect, stall watchdog) plus lossless recording (TS/FLV) with automatic stream-switch tracking, crash-resilient sessions (one-click resume after reload/crash), desktop notifications, member-only live support (key2 auth via your own login session) and VOD downloader (play pages, AES-128 HLS decrypt for content you have access to). v1.8.0: 401 auto-recovery (short-lived JWT re-read + single retry), member playlist key2/token refresh while recording, detailed member-error guidance, scheduled streams (live/schedules) countdown + start notification. v1.9.0: best-quality variant auto-selection (resolution→fps→bandwidth, yt-dlp-style sort), live quality upgrade re-scan, dead-variant fallback and a playback quality selector. v1.10.0: schedule start reminders (10/5 min before), audio rendition (EXT-X-MEDIA) detection with best-track playback, filename templates, extended session stats (JSON/CSV), recording history (IndexedDB), multi-creator schedule list, memory optimization, worker-based TS verification and dark/light theme. v1.11.0: optional per-track audio recording (EXT-X-MEDIA with URI) saved as separate audio-*.ts files alongside video (opt-in toggle, independent loop, no video impact), --audio-only/--audio-both and two-track lossless mux in the CLI.
// @description:ja  RPLAY再生・録画の候補版。Chrome/Firefoxのホスト録画、保存確認台帳、セッション操作権、非暗号化HLSのTS/fMP4・MAP・BYTERANGE、通信制限・停止保護。実RPLAY/実ブラウザーの受入は未検証。
// @author       RSP
// @match        https://rplay.live/*
// @match        https://www.rplay.live/*
// @grant        none
// @run-at       document-idle
// @noframes
// @require      https://cdn.jsdelivr.net/npm/hls.js@1/dist/hls.min.js
// @require      https://cdn.jsdelivr.net/npm/flv.js@1/dist/flv.min.js
// @license      MIT
// ==/UserScript==

/*
  ◆ これは何?
   RPLAY Web配信で「数秒再生してから止まる」症状
   (BytePlus CDNサービング経路の断続的500 / FLV接続の1-3秒強制切断)に対処する
   アドオンプレイヤーです。公式アプリが内部で行っていると考えられる
   「諦めない再接続・経路切替」をブラウザ側で再現します。

  ◆ 動作要件
   - Tampermonkey (Chrome / Edge / Firefox 推奨)
   - MSE (Media Source Extensions) 対応ブラウザ

  ◆ 仕組み
   - 新旧基盤の多段源(v1.7.0): RPLAYは配信基盤が切替可能(BytePlus CDN=旧 /
     AWS IVS=新 / 自社サーバー=予備)。mount時に詮索API(/live/play)を呼んで
     現行の基盤URL(bytePlusPlaybackUrl/playUrl)を取得し、HLS源を
     [限定(key2) > 手動上書き > abr.m3u8(新判明) > 従来<id>.m3u8(旧) > IVS]の
     優先順位で自動フォールバック。源が死んだら次の基盤へ自動切替
   - 経路1: HLS  BytePlus abr.m3u8 / 従来m3u8 / IVS (hls.js: 内部リトライ+外周リトライ)
   - 経路2: FLV  https://livestream.rplay.live/live/<id>_abrhd.flv (flv.js: 即時再接続)
   - 凍結監視: 4秒停滞で軽量復旧(ライブエッジへシーク/再ロード)、10秒停滞で完全再接続
   - 同一経路2回連続失敗 → 他系統へ自動切替
   - プレイリスト404/ENDLIST → オフライン扱い、15秒間隔で自動待機(次回配信で自動再生)
     404時は基盤切替の可能性も詮索(源の再探査で新基盤に追従)
   - 5xx/タイムアウト → 最長8秒バックオフで永続リトライ(生存確認6回ごとに他経路強制試行)
   - 録画: HLSセグメント(.ts)を無劣化のまま取得・結合保存。再生と独立しているため
     再生が止まっても録画は継続。自動分割/終了自動保存/背景タブ対応タイマー(Worker)搭載
   - 配信切替の自動追跡(v1.2.0): 配信終了(ENDLIST/404)を検出すると「追跡待機」へ移行し、
     ①m3u8の再確認 ②RPLAY API(/live/stream?creatorOid=)を監視。同一クリエイターの
     次の配信が始まれば自動で録画を再開(パート連番で1セッションに統合)
   - FLV代替録画: HLSが受信できない間にFLVが生きていれば、FLVストリームを無劣化のまま
     取得して録画継続(CDN障害・切り替え瞬間の取りこぼしを最小化)
   - バックログ制御(v1.3.0): 録画開始時にプレイリストへ残っている過去セグメント
     (最大約20分)を取得するか/開始時点からの新規のみにするかを選択可
     (詳細設定「バックログ取得」。既定ON=これまでどおり全取得)
   - サーバー配慮と厳密性(v1.4.0): プレイリスト取得間隔をTARGETDURATION基準
     (公式プレイヤー級の負荷)に適応させジッタを付与。セグメント取得は
     タイムアウト付き・ステータス厳密分類(404/410即断念、403/429は指数
     バックオフで待機)。TS書込順序を厳密保証(再試行でも順序が崩れない)。
   - 限定配信対応(v1.5.0): 公開m3u8が403のとき、ログイン中ユーザー自身の
     会話(JWT)で ①/live/play ②/live/key2 ③/live/stream/playlist.m3u8?key2=
     の順に解決し、視聴権限があれば再生・録画とも限定配信に追従します。
     権限が無い場合は明示して中断します(認証回避機能は持ちません)。
   - 詮索パネル(v1.7.0): mount時にlive/playを探査し「配信中か/基盤は何か/
     会員限定か(加入tier/鍵/チケット制の区別)」を表示。限定配信を
     自動検出して追跡録画が準備できます(権限があれば)。
   - はじかれない対策(v1.7.0): APIリクエストを公式フロントエンドと同一形状に
     (Platform-Type/Authorization/Refresh-Tokenヘッダ・requestorOid/loginType
     クエリ)。JWTは毎回localStorageから読み直し(公式interceptorが短命JWTを
     毎リクエスト書き換える設計に追従)。テレメトリ等は一切送信しません。
   - 動画DL(v1.5.0): /play/<id> ページで「動画DL」パネルを提供。content API
     から視聴可能なm3u8を解決し、セグメントを並列取得(順序厳密書込)。
     AES-128暗号化HLSは、視聴権限のある自分の会話で鍵を取得して
     復号(無劣化TSとして保存)。DRM保護コンテンツはダウンロード不可。
     リクエストは間隔下限+403/429退避でサーバーに配慮します。
   - 401自動回復と鍵更新(v1.8.0): RPLAYのJWTは短命(約4分)のため、401が
     返ったらlocalStorageから最新トークンを再読込して1回だけ再試行。
     限定録画中にplaylistが401/403になった場合はkey2を自動再取得して
     継続(90秒節流)。失敗時は理由(未加入/未ログイン/トークン期限切れ等)
     を分類して案内します(連打はしません)。
   - 配信予約(v1.8.0): live/schedules(ログイン時のみ)を詮索し、直近の
     予約配信をカウント表示。開始時刻を過ぎたら通知+探索を強化し、
     追跡待機と組み合わせて「予約→自動録画」を実現します。
   - 画質選択の最高化(v1.9.0): master playlist(abr.m3u8等)から最高画質
     variantを自動選択(解像度→fps→帯域の優先順 — yt-dlpの既定ソート、
     streamlink/N_m3u8DL-REの実装を踏襲)。録画中もmasterを定期再走査し
     より高画質が出現すれば昇格(パートを区切って保存)、variantが消失
     したら次の画質へ自動フォールバック。選択画質はREC表示・情報JSONに
     記録。解決済みvariantは直接ポーリング(master再取得を省略)し、
     リクエスト数を半減。再生側は画質セレクタ(自動/最高/各レベル)を提供。
     詳細設定「⤒ 最高画質」(既定ON)で録画の選択基準を制御。
   - 予約リマインド(v1.10.0): 予約配信の開始10分前/5分前にデスクトップ通知
     (詳細設定で発火タイミングを選択可 — 録画環境を整える時間を確保)
   - 音声レンディション個別録画(v1.11.0): masterにURI付き#EXT-X-MEDIA(TYPE=AUDIO)
    があるとき、音声を映像TSとは別のaudio-*.tsへ並行録画できる(詳細設定の
    「⤓ 音声トラックも録画」。帯域が約1.2〜1.5倍増えるため既定OFF)。要求は
    映像ループから0.3〜0.5秒遅らせCDN観測上は1セッションに近似。ポーリング/
    バックオフのポリシーは映像と同一(カウンタは独立)。音声m3u8の404は
    「レンディション欠落」とみなし即停止(映像は継続・自動再開なし)。FLV代替へ
    移行したら即停止(TSへ戻ると再評価)。検証/分割/命名は映像と共通の実装を再利用
  - 音声トラック(v1.10.0): master playlistの#EXT-X-MEDIA(TYPE=AUDIO)グループを
     検出しREC表示/情報JSONに記録。再生側は最良(最高帯域)の音声トラックを
     自動選択(詳細設定「⤒ 最高画質」と連動)
   - ファイル名テンプレート(v1.10.0): {date}{time}{creator}{title}{quality}{part}
     {ext}のプレースホルダで保存ファイル名をカスタマイズ(OS禁止文字は自動除去)
   - 統計レポート(v1.10.0): 欠落率/再接続/基盤切替/画質昇格・フォールバック履歴/
     平均セグメント間隔を集計し情報JSONにstats block出力(CSV保存も選択可)。
     集計はRecorder内部の累積のみで追加の通信は発生しない
   - 録画履歴(v1.10.0): セッション要約をIndexedDBへ保存(最大50件・古いものから
     自動削除)し「🕘 録画履歴」で一覧表示
   - 予約一覧(v1.10.0): お気に入りクリエイター(カンマ区切りOID)の予約配信を
     自分のJWTで巡回(10分間隔)して時系列一覧表示。現在ページの予約は
     録画側のカウントダウン/リマインドへ反映
   - メモリ最適化(v1.10.0): seen集合の上限管理・キュー滞留警告・統計フック
     (window.__RSP.memStats)で長時間録画のメモリを抑制
   - 検証のWorker並列化(v1.10.0): TS同期バイト検証をWeb Workerへ移譲し
     UIスレッド負荷を低減(Worker不可環境は同期検証へ自動フォールバック)
   - テーマ/言語(v1.10.0): パネル配色をOSのライト/ダークへ追従(手動上書き可)、
     静的ラベルの日本語/英語切替(ログ文面は日本語固定)
   - 保存先: File System Access API対応(Chrome/Edge)ではフォルダへ直接書き込み
     (メモリ制限なしの長時間録画が可能)。非対応はメモリ保持→自動分割ダウンロード
   - 録画中はタブタイトルに「●REC 経過時間」を表示

  ※ 個人利用を想定。公式プレイヤーと同一の公開エンドポイントへアクセスし、
   視聴者自身が受信した配信を個人利用の範囲で保存するものです。
   認証の回避や再配布を促す機能は持ちません。限定配信・有料動画は
   ユーザー自身のログイン会話で「視聴権限のある」内容のみ扱い、
   DRM保護コンテンツには対応しません。
*/

(function () {
  'use strict';

  if (window.__RPLAY_STABLE_PLAYER__) return;
  window.__RPLAY_STABLE_PLAYER__ = true;

  const HlsCtor = window.Hls;
  const FlvCtor = window.flvjs;
  const HAS_HLS = typeof HlsCtor !== 'undefined' && HlsCtor.isSupported();
  const HAS_FLV = typeof FlvCtor !== 'undefined' && FlvCtor.isSupported();

  const CDN_BASE = 'https://livestream.rplay.live/live/';
  const STREAM_ID_RE = /\/live\/([0-9a-f]{16,40})/;
  const TICK_MS = 1000;
  const NUDGE_MS = 4000;      // 停滞: 軽量復旧を試す閾値
  const RECONNECT_MS = 10000; // 停滞: 完全再接続の閾値
  const OFFLINE_POLL_MS = 15000;
  const TOKEN_POLL_MS = 30000;
  const PROBE_TIMEOUT_MS = 6000;
  const HLS_BACKOFF_CAP = 12000;
  const FLV_BACKOFF_CAP = 2000;

  const STATE_META = {
    IDLE:       { label: '待機',        cls: '' },
    CHECKING:   { label: '確認中',      cls: '' },
    CONNECTING: { label: '接続中',      cls: 'warn' },
    LIVE:       { label: 'LIVE',        cls: 'live' },
    RETRY:      { label: '再接続',      cls: 'warn' },
    OFFLINE:    { label: 'オフライン',  cls: '' },
    TOKEN:      { label: '要認証?',     cls: 'err' }
  };

  function now2() { return new Date().toTimeString().slice(0, 8); }

  /* ================= 認証会話(自分のログイン状態のみ使用) =================
   RPLAYはJWTをlocalStorage._AUTHORIZATION_に保存する(F12で確認可能)。
   ここでは「ブラウザに既にログイン済みのユーザー自身の会話」を読み取るだけ
   で、パスワード入力・トークン生成・権限の偽装は一切行わない。
   限定配信/有料動画は、この会話で視聴権限が認められた場合のみ処理する。 */
  function parseJwtPayload(jwt) {
    try {
      const parts = String(jwt).split('.');
      if (parts.length < 2) return null;
      let b = parts[1].replace(/-/g, '+').replace(/_/g, '/');
      while (b.length % 4) b += '=';
      const bin = atob(b);
      const u8 = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
      return JSON.parse(new TextDecoder().decode(u8));
    } catch (e) { return null; }
  }

  function hexU8(u8) {
    let s = '';
    for (let i = 0; i < u8.length; i++) s += ('0' + u8[i].toString(16)).slice(-2);
    return s;
  }

  /* Butterヘッダ(RPLAYフロントエンドと同一の公開署名アルゴリズム)。
   これはユーザー認証ではなく、フロントエンドJSが毎回計算して送る
   アンチボット署名。公式プレイヤーと同等のリクエストとして通すためのもの。 */
  const BUTTER_KEY = 'S%M@#H#B(!@()a2@';              // 16バイト
  const BUTTER_SALT = 'QWI@(!WAS)Dj1AA(!@*DJ#@$@~1)P'; // 29バイト
  let _butterCache = { hex: '', at: 0 };
  async function butterToken() {
    const now = Date.now();
    if (_butterCache.hex && now - _butterCache.at < 6 * 60 * 1000) return _butterCache.hex;
    try {
      const enc = new TextEncoder();
      const ts = String(Math.floor(now / 1000 / 360));
      const iv = enc.encode(ts.padStart(16, '0'));
      const clear = new Uint8Array(BUTTER_SALT.length + 17 + ts.length);
      let o = 0;
      clear.set(enc.encode(BUTTER_SALT), o); o += BUTTER_SALT.length;
      clear.set(enc.encode('https://rplay.live'), o); o += 17;
      clear.set(enc.encode(ts), o);
      const key = await crypto.subtle.importKey('raw', enc.encode(BUTTER_KEY), { name: 'AES-CBC' }, false, ['encrypt']);
      const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-CBC', iv: iv }, key, clear));
      _butterCache = { hex: hexU8(cipher), at: now };
      try { RspAuth._butterSends = (RspAuth._butterSends || 0) + 1; } catch (e2) { /* 計数のみ */ }
      return _butterCache.hex;
    } catch (e) { return ''; }
  }

  const RspAuth = {
    jwt: null, exp: 0, userOid: null, nick: null, probed: false, refreshToken: null,
    _lastAuthz: null,
    /* v2.7.0(A-02): authEvidence用の計数(秘密は保持しない・呼び出し側で加算) */
    _401Classes: {}, _key2Resolutions: 0, _butterSends: 0,
    probe() {
      this.probed = true;
      try {
        // RPLAY公式の保存キー(_AUTHORIZATION_)を最優先で確認
        // ※RPLAYはJWT短命化(数分)→公式interceptorが毎リクエストで書き換えるため、
        //   毎回localStorageを読み直して常に最新JWTを使う(旧値を信じない)
        let authz = null;
        const cand = ['_AUTHORIZATION_', '_authorization_', 'authorization'];
        for (let i = 0; i < cand.length && !authz; i++) {
          const v = localStorage.getItem(cand[i]);
          if (v && v.split('.').length >= 2 && v.indexOf('ey') === 0) authz = v;
        }
        if (!authz) {
          for (let i = 0; i < localStorage.length && !authz; i++) {
            const v = localStorage.getItem(localStorage.key(i)) || '';
            if (v.length > 40 && v.indexOf('eyJ') === 0 && v.split('.').length === 3) authz = v;
          }
        }
        this.jwt = authz;                       // 旧値を引きずらない(ログアウト検知)
        this._lastAuthz = authz;
        if (this.jwt) {
          const p = parseJwtPayload(this.jwt);
          if (p) {
            this.exp = p.exp || 0;
            this.userOid = p.oid || p.userOid || p.userId || p._id || (typeof p.sub === 'string' && /^[0-9a-f]{24}$/.test(p.sub) ? p.sub : null) || null;
            this.nick = p.nickname || p.nick || null;
          }
        }
        // userOidが無ければユーザー情報らしいキーを補完走査
        if (!this.userOid) {
          for (let i = 0; i < localStorage.length && !this.userOid; i++) {
            const k = localStorage.key(i);
            if (!/user|account|profile|me\b|self/i.test(k)) continue;
            const v = localStorage.getItem(k) || '';
            if (v.length < 8 || v.length > 20000) continue;
            try {
              const j = JSON.parse(v);
              const oid = j && (j._id || j.oid || j.userOid || (j.user && (j.user._id || j.user.oid)));
              if (typeof oid === 'string' && /^[0-9a-f]{24}$/.test(oid)) {
                this.userOid = oid;
                if (!this.nick && j.nickname) this.nick = j.nickname;
              }
            } catch (e2) { /* JSONでなければ無視 */ }
          }
        }
        this.refreshToken = this._scanRefreshToken();
      } catch (e) { /* localStorage不可の環境 */ }
      return this;
    },
    /* refresh token(vuex/IndexedDB等のJSON内)を再帰検索。
     公式interceptorは Refresh-Token ヘッダを付けてAPIを呼ぶため、同一リクエスト
     形状に合わせる(つけても無害・401再発行連携の対象になる)。 */
    _scanRefreshToken() {
      const found = { v: null };
      const visit = (node, depth) => {
        if (found.v || depth > 6 || node == null) return;
        if (typeof node === 'string') {
          if (node.length >= 32 && node.length <= 512 && node.indexOf('eyJ') !== 0 &&
              /^[A-Za-z0-9_\-.~+/=]+$/.test(node) && !/^[0-9a-f]{24}$/.test(node)) found.v = node;
          return;
        }
        if (typeof node !== 'object') return;
        for (const k of ['refreshToken', 'refresh_token', 'renewalToken']) {
          const v = node[k];
          if (typeof v === 'string' && v.length >= 32) { found.v = v; return; }
        }
        for (const k in node) visit(node[k], depth + 1);
      };
      try {
        for (let i = 0; i < localStorage.length && !found.v; i++) {
          const k = localStorage.key(i);
          if (!/vuex|account|auth|session/i.test(k)) continue;
          const v = localStorage.getItem(k) || '';
          if (v.length < 40 || v.length > 200000) continue;
          try { const j = JSON.parse(v); visit(j, 0); } catch (e) { /* 非JSON */ }
        }
      } catch (e) { /* 不可 */ }
      return found.v;
    },
    expired() { return this.exp > 0 && this.exp * 1000 < Date.now() + 240000; },
    /* v2.7.0(A-02): 401分類・key2再解決・Butter送出の計数(CLIのauthEvidenceと同形式) */
    note401(cls) {
      this._401Classes = this._401Classes || {};
      this._401Classes[cls] = (this._401Classes[cls] || 0) + 1;
      return cls;
    },
    noteKey2() { this._key2Resolutions = (this._key2Resolutions || 0) + 1; },
    authEvidence() {
      /* 秘密(トークン値)は一切含めない。供給源の種別と計数のみ。
         CLIのAuthStore.evidence()と同鍵構造(相互言語比較試験で固定)。 */
      return {
        mode: 'localStorage-interceptor',
        tokenSource: this.jwt ? 'localStorage' : null,
        refreshSource: this.refreshToken ? 'localStorage-scan' : null,
        userOidSupplied: !!this.userOid,
        switchedToRefresh: false,
        refreshAttempts: 0,
        refreshSuccesses: 0,
        refreshFailures: 0,
        responseKey: null,
        classifications401: Object.assign({}, this._401Classes || {}),
        key2Resolutions: this._key2Resolutions || 0,
        butterSent: (this._butterSends || 0) > 0,
        provenance: 'rspauth_counters',
        note: '秘密(トークン値)は含まない。公式interceptorと同一戦略(逐次読・'
              + 'Refresh-Tokenヘッダ送出のみ・本ツールは更新APIを呼ばない)'
      };
    },
    statusLabel() {
      if (!this.jwt) return '未ログイン';
      if (this.expired()) return '要再読込(トークン期限切れ)';
      return 'ログイン済み' + (this.nick ? '(' + this.nick + ')' : '');
    },
    /* JWT系APIヘッダ(公式interceptorと同一形状: Platform-Type/Authorization/Refresh-Token)。
     Origin/Refererはブラウザが自動付与するため不要。 */
    jwtHeaders(extra) {
      const h = { 'Platform-Type': 'rplay', Authorization: this.jwt || 'null' };
      if (this.refreshToken) h['Refresh-Token'] = this.refreshToken;
      if (extra) for (const k in extra) h[k] = extra[k];
      return h;
    },
    /* requestorクエリ(ログイン時のみ) */
    requestorQuery() {
      return this.userOid ? { requestorOid: this.userOid, loginType: 'rplay' } : {};
    }
  };

  /* ---- v2.7.0(A-03): サイト更新検知のcanary(両コア鏡像) ----
     live/play応答の「鍵の一覧」だけを既知鍵と照合する(値・秘密は扱わない)。
     判定: ok(既知鍵あり) / shape_change(辞書だが既知鍵ゼロ) / unreachable。
     shape_changeでも録画は止めない(警告のみ・安全側)。Python側canary_checkと
     同一の戻り値構造(相互言語比較試験で固定)。 */
  const RSP_CANARY_EXPECTED_KEYS = ['bytePlusPlaybackUrl', 'playUrl', 'streamState',
    'accessible', 'tierHashes', 'useRplayStreamServer', 'allowAnonymous', 'title'];
  let _lastCanary = null;
  function rspCanaryCheck(info) {
    /* 自己完結(抽出可能) — 期待鍵一覧は関数内で確定する(鏡像試験で単体実行可能) */
    const expected = ['bytePlusPlaybackUrl', 'playUrl', 'streamState',
      'accessible', 'tierHashes', 'useRplayStreamServer', 'allowAnonymous', 'title'];
    if (!info || typeof info !== 'object' || Array.isArray(info) || !Object.keys(info).length)
      return { result: 'unreachable', observedKeys: [], knownKeys: [] };
    const observed = Object.keys(info).map(String);
    const known = observed.filter(k => expected.indexOf(k) !== -1);
    return { result: known.length ? 'ok' : 'shape_change',
             observedKeys: observed.slice().sort().slice(0, 24),
             knownKeys: known.slice().sort() };
  }
  function rspCanaryEvidence(res) {
    return { result: res.result, observedKeys: res.observedKeys, knownKeys: res.knownKeys,
             checkedAt: new Date().toISOString(), action: 'warn_only',
             provenance: 'live_play_response_shape' };
  }

  /* ---- v2.8.0(W-01/W-02): streamStartTime 10分(600s)閾値追跡 & 4層ErrorKind分類(両コア鏡像) ----
     rplay_watcher v0.5.0 (SessionManager / ErrorKind) の知見を統合:
     - streamStartTime の差分が 600秒以内なら同一配信の瞬断復帰(same_session_resumed)、
       600秒超なら別配信枠への分割(new_session_split)、同一値なら unchanged と分類。
     - エラー種別を SOURCE / NETWORK / AUTH / PLATFORM / COMPATIBILITY / INTERNAL の6種で計数。 */
  function rspParseStreamStartSec(val) {
    if (val === null || val === undefined || val === '') return null;
    if (typeof val === 'number') {
      if (!Number.isFinite(val) || val <= 0) return null;
      return val > 1e11 ? Math.floor(val / 1000) : Math.floor(val);
    }
    const s = String(val).trim();
    if (!s) return null;
    if (/^\d+(\.\d+)?$/.test(s)) {
      const n = Number(s);
      return n > 1e11 ? Math.floor(n / 1000) : Math.floor(n);
    }
    const ms = Date.parse(s);
    return Number.isNaN(ms) ? null : Math.floor(ms / 1000);
  }
  function rspClassifySessionChange(prevVal, nextVal, thresholdSec) {
    const th = (typeof thresholdSec === 'number' && thresholdSec > 0) ? thresholdSec : 600;
    const p = rspParseStreamStartSec(prevVal);
    const n = rspParseStreamStartSec(nextVal);
    if (p === null && n === null) return { changed: false, gapSec: null, classification: 'unknown', thresholdSec: th };
    if (p === null && n !== null) return { changed: false, gapSec: 0, classification: 'initial', thresholdSec: th };
    if (p !== null && n === null) return { changed: false, gapSec: null, classification: 'unknown', thresholdSec: th };
    const gap = Math.abs(n - p);
    if (gap === 0) return { changed: false, gapSec: 0, classification: 'unchanged', thresholdSec: th };
    return {
      changed: true,
      gapSec: gap,
      classification: gap <= th ? 'same_session_resumed' : 'new_session_split',
      thresholdSec: th
    };
  }
  function rspSessionTrackingEvidence(tracker) {
    const t = tracker || {};
    return {
      initialStreamStartSec: t.initialStreamStartSec !== undefined ? t.initialStreamStartSec : null,
      latestStreamStartSec: t.latestStreamStartSec !== undefined ? t.latestStreamStartSec : null,
      thresholdSec: t.thresholdSec || 600,
      sameSessionResumes: t.sameSessionResumes || 0,
      newSessionSplits: t.newSessionSplits || 0,
      transitions: Array.isArray(t.transitions) ? t.transitions.slice(0, 20) : [],
      provenance: 'stream_start_time_10min_threshold'
    };
  }
  function rspErrorTaxonomyEvidence(counts) {
    const c = counts || {};
    const norm = {
      SOURCE: Number(c.SOURCE || 0),
      NETWORK: Number(c.NETWORK || 0),
      AUTH: Number(c.AUTH || 0),
      PLATFORM: Number(c.PLATFORM || 0),
      COMPATIBILITY: Number(c.COMPATIBILITY || 0),
      INTERNAL: Number(c.INTERNAL || 0)
    };
    return {
      counts: norm,
      recoverableCount: norm.SOURCE + norm.NETWORK + norm.AUTH,
      sourceFailureCount: norm.SOURCE,
      provenance: 'rplay_watcher_error_kind_v050'
    };
  }

  /* ================= v2.9.0: 字幕レンディション観測の証拠ブロック(A-09) =================
   字幕playlist・セグメントは取得しない(観測と計数のみの安全側契約)。
   policy=observed_not_fetched。Python側 subtitle_evidence と完全鏡像
   (相互言語比較試験で固定)。 */
  function rspSubtitleEvidence(renditions, variants) {
    const rends = Array.isArray(renditions) ? renditions : [];
    const gids = {};
    for (let i = 0; i < rends.length; i++) {
      const gid = (rends[i] && rends[i].groupId) || '';
      if (gid) gids[gid] = true;
    }
    let linked = 0;
    const vs = Array.isArray(variants) ? variants : [];
    for (let i = 0; i < vs.length; i++) {
      const sg = (vs[i] && vs[i].subsGroup) || '';
      if (sg && gids[sg]) linked++;
    }
    return {
      renditions: rends,
      renditionCount: rends.length,
      variantsLinked: linked,
      policy: 'observed_not_fetched',
      provenance: 'master_playlist_ext_x_media',
      note: '字幕レンディションは観測と計数のみ(字幕playlist取得はしない)。URI値は秘匿しhasUriのみ記録'
    };
  }

  /* ---- v2.37.0: 共通JSON取得(ページ/BG同一実装) ----
     前版までページ側(player.user.js)のみだったstream読込契約をoffscreen_pre.js
     側にも共通適用する。旧offscreen実装(応答をjson()で一括読込・サイズ上限なし・
     ヘッダ受信でtimeout解除)は廃止し、BG経路のJSONも同じ上限契約へ揃える。
     - 2 MiB上限: 宣言Content-Lengthと実受信byte数の両方を検査し、超過は
       JSON_TOO_LARGEとして即失敗(再試行しない)。上限ちょうどは成功。
     - 本文はgetReaderでchunk読込し、fatal UTF-8 TextDecoderで連結する。
       stream非対応はJSON_STREAM_UNAVAILABLEとして即失敗(json()へfallbackしない)。
     - timeoutは本文受信完了まで有効(旧offscreenの「ヘッダで解除」を廃止)。
     - finallyでctl.abortとreader.cancel/releaseLockを必ず実施(部分受信の解放)。
     - 再試行は通信失敗(status 0)と5xxのみ最大1回・800ms間隔。429はretry-afterを
       返して再試行しない。JSON_TOO_LARGE/JSON_STREAM_UNAVAILABLEはterminal。
     - logFnは未使用引数(呼び互換のため保持)。signalは外部停止要求の即時反映。 */
  async function fetchJsonWithRetry(url, headers, timeoutMs, logFn, signal) {
    const cancelled=()=>signal&&signal.aborted;
    const pause=()=>new Promise(resolve=>{let timer;const finish=()=>{clearTimeout(timer);if(signal)signal.removeEventListener('abort',finish);resolve();};timer=setTimeout(finish,800);if(signal){signal.addEventListener('abort',finish,{once:true});if(signal.aborted)finish();}});
    for(let a=0;a<2;a++){
      if(cancelled())return {ok:false,status:0,aborted:true};
      const ctl=new AbortController(),abort=()=>ctl.abort();
      if(signal)signal.addEventListener('abort',abort,{once:true});
      const timer=setTimeout(abort,timeoutMs||8000);
      let result,reader;
      try{
        if(cancelled())ctl.abort();
        const res=await fetch(url,{cache:'no-store',headers:headers||{},signal:ctl.signal});
        if(res.status===200){
          const limit=2*1048576,fail=code=>{const e=Error(code);e.code=code;throw e;};
          if(Number(res.headers.get('content-length'))>limit)fail('JSON_TOO_LARGE');
          if(!res.body||!res.body.getReader)fail('JSON_STREAM_UNAVAILABLE');
          reader=res.body.getReader();let size=0,text='';const decoder=new TextDecoder('utf-8',{fatal:true});
          while(true){const part=await reader.read();if(part.done)break;size+=part.value.byteLength;if(size>limit)fail('JSON_TOO_LARGE');text+=decoder.decode(part.value,{stream:true});}
          text+=decoder.decode();result={ok:true,status:200,json:JSON.parse(text)};
        }
        else result={ok:false,status:res.status,...(res.status===429?{retryAfter:res.headers.get('retry-after')}:{})};
      }catch(e){result={ok:false,status:0,...(e.code?{error:e.code}:{})};}
      finally{ctl.abort();clearTimeout(timer);if(signal)signal.removeEventListener('abort',abort);if(reader){try{const p=reader.cancel();if(p&&p.catch)p.catch(()=>{});}catch(e){}reader.releaseLock();}}

      if(cancelled())return {ok:false,status:0,aborted:true};
      if(result.error||result.ok||result.status>0&&result.status<500||a===1)return result;
      await pause();
    }
  }
  if(typeof module!=='undefined')module.exports={fetchJsonWithRetry};


  /* ---- v1.8.0: 認証付きJSON取得(401自動回復) ----
   RPLAYのJWTは短命(約4分)で公式interceptorが毎リクエスト書き換える。
   401が返ったら localStorage から最新トークンを再読込し、トークンが
   更新されていれば1回だけ再試行する(古いトークンでの401を自動回復)。
   トークンが変わっていなければ再試行しない(連打防止・サーバー配慮)。 */
  async function authedJson(url, opts) {
    const o = opts || {};
    RspAuth.probe();
    let r = await fetchJsonWithRetry(url, RspAuth.jwtHeaders(o.extraHeaders), o.timeoutMs || 8000, o.log, o.signal);
    if (r.ok || r.status !== 401) return r;
    RspAuth.note401('auth-expired');  // v2.7.0(A-02): 401分類の計数(秘密なし)
    const before = RspAuth.jwt;
    RspAuth.probe(); // localStorage再読込(公式interceptorの更新や他タブの変更を取り込む)
    if (RspAuth.jwt && RspAuth.jwt !== before) {
      if (o.log) o.log('401 → トークンを再読込して1回だけ再試行します(短命JWTへの追従)');
      r = await fetchJsonWithRetry(url, RspAuth.jwtHeaders(o.extraHeaders), o.timeoutMs || 8000, o.log, o.signal);
      if (r.ok) RspAuth.note401('reloaded_retry');  // v2.7.0(A-02): 再読込再試行の成功計数
    }
    return r;
  }

  /* ---- 詮索(配信情報の事前探査・live/play) ----
   RPLAYは配信基盤を切替可能: BytePlus CDN(旧:bytePlusPlaybackUrl) /
   AWS IVS(新:playUrl) / 自社サーバー(useRplayStreamServer)。
   このAPIは未ログインでも200(offlineでも配信情報を返す)なので、
   mount時に呼んで「どの基盤で・どの権限で見られる配信か」を判定する。
   サーバー負荷配慮: 30秒キャッシュ(詮索の連打はしない)。 */
  const _liveInfoCache = { oid: null, at: 0, info: null };
  async function resolveLiveInfo(creatorOid) {
    const now = Date.now();
    if (_liveInfoCache.oid === creatorOid && now - _liveInfoCache.at < 30000 && _liveInfoCache.info) {
      return _liveInfoCache.info;
    }
    RspAuth.probe();
    const q = new URLSearchParams({ creatorOid: creatorOid });
    for (const k in RspAuth.requestorQuery()) q.set(k, RspAuth.requestorQuery()[k]);
    const r = await authedJson(API_BASE + '/live/play?' + q.toString(), { timeoutMs: 8000 });
    const info = (r && r.ok && r.json) ? r.json : null;
    /* v2.7.0(A-03): 応答形状のcanary(鍵一覧のみ・値は出さない)。shape_changeは
       警告だけ出して録画・再生は続行(安全側)。 */
    _lastCanary = rspCanaryCheck(info);
    if (_lastCanary.result === 'shape_change') {
      try { console.warn('[RSP] live/playの応答形状が既知鍵と一致しません(canary: shape_change) — サイト更新の可能性。再生・録画は続行します'); } catch (e) {}
    }
    _liveInfoCache.oid = creatorOid;
    _liveInfoCache.at = now;
    _liveInfoCache.info = info;
    return info;
  }
  /* 詮索結果から「配信基盤」を人が読める形に */
  function liveBaseLabel(info) {
    if (!info) return '不明';
    if (info.streamState === 'youtube') return 'YouTube(外部)';
    if (info.streamState === 'twitch') return 'Twitch(外部)';
    if (info.useRplayStreamServer) return 'RPLAY自社サーバー';
    if (info.playUrl && (!info.useBytePlusStream)) return 'AWS IVS(新基盤)';
    if (info.useBytePlusStream && info.playUrl) return 'BytePlus+IVS併用';
    if (info.useBytePlusStream || info.bytePlusPlaybackUrl) return 'BytePlus CDN';
    return '不明';
  }
  /* 詮索結果の要約行を返す(UI表示用) */
  function liveScentLines(info) {
    if (!info) return ['live/play応答なし(オフライン/一時障害)'];
    const L = [];
    L.push('状態: ' + (info.streamState === 'live' ? '🔴 配信中' : (info.streamState === 'offline' ? 'オフライン' : info.streamState)) +
      (info.title ? ' / 「' + info.title.slice(0, 40) + '」' : ''));
    L.push('基盤: ' + liveBaseLabel(info));
    const acc = info.accessible === true;
    const anon = info.allowAnonymous === true;
    L.push('権限: ' + (acc ? '視聴可(加入済み/公開)' : '🔒 会員限定(アクセス権なし)') +
      (anon ? ' / 匿名視聴可' : ' / ログイン必須'));
    if (info.tierHashes) {
      const tiers = Object.keys(info.tierHashes);
      if (tiers.length) L.push('加入 tiers: ' + tiers.join(', ') +
        (info.tierHashes.free ? ' (無料プランで視聴可)' : ''));
    }
    if (info.useSecretKey) L.push('🔑 鍵(シークレット)配信です');
    if (info.useTicket || info.useSubscriber) L.push(info.useTicket ? '🎟 チケット制配信です' : '👤 サブスク配信です');
    if (info.isSubscriber === true) L.push('あなたはこのチャンネルの加入者です');
    if (info.isAdultContent) L.push('R-18指定');
    return L;
  }

  /* ---- 限定配信(会員限定ライブ)の解決 ----
   ① live/play で streamState/accessible/allowAnonymous を確認
   ② ログイン会話で live/key2 → authKey を取得(視聴権限があれば通る)
   ③ /live/stream/playlist.m3u8?creatorOid=&key2= をプレイリスト源にする
   権限が無い場合は明確な理由を返すだけ(偽装・回避はしない)。 */
  /* m3u8源が本当に生きているか(200+EXTM3U/EXTINF/STREAM-INF)を確認 */
  async function probeM3u8Ok(base) {
    if (!base) return false;
    try {
      const ctl = new AbortController();
      const to = setTimeout(() => ctl.abort(), 6000);
      const res = await fetch(base,
        { cache: 'no-store', signal: ctl.signal });
      clearTimeout(to);
      if (res.status !== 200) return false;
      const txt = await res.text();
      return txt.indexOf('#EXTM3U') >= 0 || txt.indexOf('#EXTINF') >= 0 || txt.indexOf('#EXT-X-STREAM-INF') >= 0;
    } catch (e) { return false; }
  }

  const _memberResolveCache = { oid: null, at: 0, result: null };
  async function resolveMemberLive(creatorOid, logFn) {
    const logger = logFn || function () {};
    const now = Date.now();
    if (_memberResolveCache.oid === creatorOid && now - _memberResolveCache.at < 60000 && _memberResolveCache.result) {
      return _memberResolveCache.result;
    }
    RspAuth.probe();
    // live/playは詮索(resolveLiveInfo)と同じ30秒キャッシュを共有し、二重呼び出しを避ける
    const info = (await resolveLiveInfo(creatorOid)) || {};
    if (info == null || (!info.streamState && !info.oid && !info.creatorOid)) {
      // API自体が失敗した場合(詮索がnullを返した)
      logger('live/play 応答なし — 一時障害の可能性');
      return { ok: false, reason: 'api', status: 0 };
    }
    const st = info.streamState;
    if (st && st !== 'live') {
      if (st === 'youtube') return { ok: false, reason: 'youtube', redirect: info.liveStreamId };
      if (st === 'twitch') return { ok: false, reason: 'twitch', redirect: info.twitchLogin };
      return { ok: false, reason: st };
    }
    if (!info.accessible) {
      const freeTier = info.tierHashes && info.tierHashes.free;
      return { ok: false, reason: 'no-access', freeTier: !!freeTier };
    }
    if (!info.allowAnonymous && !RspAuth.jwt) return { ok: false, reason: 'login-required' };
    let key2 = '';
    if (RspAuth.jwt) {
      const q2 = new URLSearchParams({ creatorOid: creatorOid });
      for (const k in RspAuth.requestorQuery()) q2.set(k, RspAuth.requestorQuery()[k]);
      const r2 = await authedJson(API_BASE + '/live/key2?' + q2.toString(), { timeoutMs: 8000, log: logger });
      if (r2.ok && r2.json) { key2 = r2.json.authKey || ''; if (key2) RspAuth.noteKey2(); }  // v2.7.0(A-02): key2再解決の計数
      else if (r2.status === 401) {
        // v1.8.0: トークン無効は再試行しても無意味 → 分類して案内(連打しない)
        logger('live/key2 401 — ログイントークンが無効です(ページ再読み込みで最新トークンになります)');
        return { ok: false, reason: 'auth-expired', status: 401 };
      } else if (r2.status === 403) {
        logger('live/key2 403 — この配信への視聴権限がありません');
        return { ok: false, reason: 'no-access', status: 403 };
      } else logger('live/key2 ' + (r2.status || 'error') + ' — 鍵なしで継続を試みます');
    }
    const playlist = API_BASE + '/live/stream/playlist.m3u8?creatorOid=' + encodeURIComponent(creatorOid) +
      (key2 ? '&key2=' + encodeURIComponent(key2) : '');
    // 公式プレイヤー経路のplaylistが本当に生きているか確認してから採用
    // (権限やライフサイクルで404になる場合はmember源にしない — フォールバックを壊さない)
    if (!(await probeM3u8Ok(playlist))) {
      logger('限定プレイリスト(' + playlist.split('?')[0] + ')が取得不能 — この源は採用しません');
      return { ok: false, reason: 'playlist' };
    }
    const result = { ok: true, playlist: playlist, key2: key2, title: info.title || '',
      allowAnonymous: !!info.allowAnonymous, base: liveBaseLabel(info) };
    _memberResolveCache.oid = creatorOid;
    _memberResolveCache.at = now;
    _memberResolveCache.result = result;
    return result;
  }

  /* ---- v1.8.0: 限定解決の失敗理由を、次に何をすれば良いかが分かる案内に分類 ----
   (偽装・回避の案内は含まない。権限が無いものは「加入/購入で視聴可能になる」
    ことと、トークン更新のための再読み込みを示すだけ) */
  function memberFailHint(r) {
    if (!r) return '限定配信の解決に失敗しました(一時障害の可能性 — 自動で再試行します)';
    switch (r.reason) {
      case 'no-access':
        return r.freeTier
          ? 'この配信は無料プラン加入限定です。プランに加入すると再生/録画できます'
          : 'この配信への視聴権限がありません(プラン加入/鍵/チケットのいずれかが必要)';
      case 'login-required':
        return '会員限定配信です。RPLAYにログインすると視聴権限があれば再生/録画できる可能性があります';
      case 'auth-expired':
        return 'ログイントークンが期限切れです — ページを再読み込みすると最新トークンで再試行できます';
      case 'api':
        return 'RPLAY APIが一時的に応答していません — 自動で再試行します';
      case 'playlist':
        return '限定プレイリストを取得できません(配信の準備中/終了直後の可能性) — 自動で再試行します';
      case 'youtube':
      case 'twitch':
        return '外部配信(' + r.reason + ')のためこのプレイヤーでは扱いません';
      case 'offline':
        return '配信はオフラインです(開始を待機します)';
      default:
        return '限定配信を解決できませんでした(' + (r.reason || '不明') + ') — 自動で再試行します';
    }
  }

  /* ---- v1.8.0: 配信予約(スケジュール)の詮索 ----
   GET /live/schedules?creatorOid= はログイン会話が必要(未ログインは401)。
   応答形状の差(配列直/ラップオブジェクト/時刻の秒orミリ秒)を吸収し、
   直近の予約1件 { title, scheduledAt(ms epoch) } を返す。無ければ null。
   サーバー負荷配慮: 取得結果をキャッシュ(あり60秒/なし20秒)し、呼び出しは
   追跡待機時など必要な局面に限る。 */
  const _schedCache = { oid: null, at: 0, item: null };
  function _pickScheduleItem(j) {
    let arr = null;
    if (Array.isArray(j)) arr = j;
    else if (j && typeof j === 'object') {
      for (const k of ['schedules', 'items', 'list', 'data', 'results']) {
        if (Array.isArray(j[k])) { arr = j[k]; break; }
      }
      if (!arr && (j.scheduledAt || j.startsAt || j.startAt)) arr = [j];
    }
    if (!arr) return null;
    const nowMs = Date.now();
    let best = null, bestT = Infinity;
    for (const it of arr) {
      if (!it || typeof it !== 'object') continue;
      const raw = it.scheduledAt || it.startsAt || it.startAt ||
        (it.live && (it.live.scheduledAt || it.live.startsAt));
      let t = 0;
      if (typeof raw === 'number') t = raw < 1e12 ? raw * 1000 : raw; // 秒/ミリ秒を吸収
      else if (typeof raw === 'string') { const d = Date.parse(raw); if (!isNaN(d)) t = d; }
      if (!t) continue;
      if (t > nowMs - 30 * 60 * 1000 && t < bestT) { bestT = t; best = { title: it.title || it.name || '', scheduledAt: t }; }
    }
    return best;
  }
  async function resolveScheduleInfo(creatorOid) {
    const now = Date.now();
    const ttl = _schedCache.item ? 60000 : 20000;
    if (_schedCache.oid === creatorOid && now - _schedCache.at < ttl) return _schedCache.item;
    _schedCache.oid = creatorOid;
    _schedCache.at = now;
    RspAuth.probe();
    if (!RspAuth.jwt) return null; // 予約APIはログイン必須 — 未ログインでは静かに諦める
    try {
      const q = new URLSearchParams({ creatorOid: creatorOid });
      for (const k in RspAuth.requestorQuery()) q.set(k, RspAuth.requestorQuery()[k]);
      const r = await authedJson(API_BASE + '/live/schedules?' + q.toString(), { timeoutMs: 8000 });
      if (!r.ok) return null; // 401/403/404等 → 予約情報なしとして扱う(連打しない)
      const item = _pickScheduleItem(r.json);
      _schedCache.item = item;
      return item;
    } catch (e) { return null; }
  }

  /* ---- v1.10.0: 予約一覧用の巡回取得(お気に入りクリエイター) ----
   GET /live/schedules?creatorOid= を自分のJWTで取得し、直近の予約を配列で返す。
   応答形状の差は配信予約(resolveScheduleInfo)と同じ吸収器を使用。
   巡回は10分間隔以上に制限(SCHED_SCAN_MIN_MS)し、1件ごとに400msの間隔を空ける。 */
  function rspScheduleRows(json,nowMs) {
    let arr=json;
    for(let depth=0;depth<5&&!Array.isArray(arr);depth++){
      if(!arr||typeof arr!=='object')return null;
      arr=arr.schedules??arr.items??arr.list??arr.data??arr.results;
    }
    if(!Array.isArray(arr)||arr.length>500)return null;
    const out=[],seen=new Set();
    for(const it of arr){
      if(!it||typeof it!=='object')continue;
      const raw=it.scheduledAt??it.startsAt??it.startAt??(it.live&&(it.live.scheduledAt??it.live.startsAt));
      const at=typeof raw==='number'?(raw<1e12?raw*1000:raw):typeof raw==='string'?Date.parse(raw):NaN;
      if(!Number.isFinite(at)||Math.abs(at)>8.64e15||at<=nowMs-30*60000)continue;
      const title=String(it.title||it.name||'').slice(0,500),key=at+'|'+title;
      if(!seen.has(key)){seen.add(key);out.push({title,scheduledAt:at});}
    }
    return out.sort((a,b)=>a.scheduledAt-b.scheduledAt);
  }

  async function fetchSchedulesFor(creatorOid, signal) {
    RspAuth.probe();
    if (!RspAuth.jwt) return { err: 'nologin' };
    try {
      const q = new URLSearchParams({ creatorOid: creatorOid });
      for (const k in RspAuth.requestorQuery()) q.set(k, RspAuth.requestorQuery()[k]);
      const r = await authedJson(API_BASE + '/live/schedules?' + q.toString(), { timeoutMs: 8000, signal });
      if (!r.ok) return { err: String(r.status || 'error') };
      const out=rspScheduleRows(r.json,Date.now());
      if(out===null)return {err:'shape'};
      return { items: out };
    } catch (e) { return { err: 'exception' }; }
  }

  /* ================= Engine: アプリ式再接続ステートマシン ================= */
  class Engine {
    constructor(id, ui) {
      this.id = id;
      this.ui = ui;
      this.transportIdx = 0;
      this.attempt = 0;
      this.consecutiveFails = 0;
      this.destroyed = false;
      this.hls = null;
      this.flv = null;
      this.state = 'IDLE';
      this.stallMs = 0;
      this.lastVideoTime = -1;
      this.progressTicks = 0;
      this.mediaRecovered = false;
      this._wd = null;
      this._poll = null;
      this._probes = new Set();
      this.customM3u8 = '';
      this.memberPlaylist = '';   // 限定配信(会員限定)のplaylist(key2認証)
      this.accessMode = 'public'; // public | member
      this.liveInfo = null;       // 詮索結果(live/play応答)
      this.sourceKind = '';       // 採用源: member|custom|abr|legacy|ivs|flv
      try { this.customM3u8 = localStorage.getItem('rsp_custom_m3u8') || ''; } catch (e) {}
    }

    /* 限定・手動URLを優先。公式live/playの現行基盤、もう一方の基盤、旧CDNの順で試す。 */
    hlsCandidates() {
      const id = this.id;
      const c = [];
      const push = (url) => { if (url && c.indexOf(url) < 0) c.push(url); };
      if (this.memberPlaylist) push(this.memberPlaylist, 'member');
      if (this.customM3u8) push(this.customM3u8, 'custom');
      for (const url of rspSourceCandidates(this.liveInfo, CDN_BASE + id + '.m3u8')) push(url);
      return c;
    }
    hlsKindOf(url) {
      if (url === this.memberPlaylist) return 'member';
      if (url === this.customM3u8) return 'custom';
      if (this.liveInfo && url === this.liveInfo.bytePlusPlaybackUrl) return 'abr';
      if (this.liveInfo && url === this.liveInfo.playUrl) return 'ivs';
      return 'legacy';
    }
    sourceLabel(kind) {
      if (kind === 'member') return 'HLS(限定)';
      if (kind === 'custom') return 'HLS(手動)';
      if (kind === 'abr') return 'HLS(ABR)';
      if (kind === 'ivs') return 'HLS(IVS)';
      return 'HLS';
    }
    transports() {
      const id = this.id;
      const hlsUrl = this.memberPlaylist || this.customM3u8 || this.liveM3u8 || this.hlsCandidates()[0];
      return [
        { key: 'HLS', label: this.sourceLabel(this.sourceKind || this.hlsKindOf(hlsUrl)), kind: 'hls', url: hlsUrl },
        { key: 'FLV', label: 'FLV(HD)', kind: 'flv',
          url: CDN_BASE + id + '_abrhd.flv?creatorId=' + id + '&resolution=hd&abr_pts=-800' }
      ];
    }

    currentTransport() {
      const list = this.transports();
      return list[this.transportIdx % list.length];
    }

    setState(s, info) {
      this.state = s;
      this.ui.setState(s, info || null);
    }

    log(msg) { this.ui.log(msg); }

    destroy() {
      for (const ctl of this._probes) ctl.abort();
      this._probes.clear();
      this.destroyed = true;
      this.teardownTransport();
      if (this._poll) { clearTimeout(this._poll); this._poll = null; }
      this.setState('IDLE');
    }

    /* ---- 入口: 配信の生存確認 → 開始 / 待機 / リトライ ---- */
    async enter() {
      if (this.destroyed) return;
      this.setState('CHECKING');
      const cls = await this.probe();
      if (this.destroyed) return;
      if (cls === 'live') {
        this.attempt = 0;
        this.open();
      } else if (cls === 'server') {
        this.scheduleRetry('CDN 5xx/timeout');
      } else if (cls === 'offline') {
        this.setState('OFFLINE');
        this.log('プレイリスト無し/ENDLIST → ' + (OFFLINE_POLL_MS / 1000) + '秒間隔で待機');
        this.poll(OFFLINE_POLL_MS);
      } else if (cls === 'token') {
        this.setState('TOKEN');
        this.log('403 → 会員限定/アクセス制限の可能性 — 自分のログイン会話で限定配信を解決します');
        let handled = false;
        try {
          const r = await resolveMemberLive(this.id, (m) => this.log(m));
          if (this.destroyed) return;
          if (r && r.ok) {
            this.memberPlaylist = r.playlist;
            this.accessMode = 'member';
            this.sourceKind = 'member';
            this.liveM3u8 = r.playlist;
            this.transportIdx = 0;
            this.log('限定配信を解決(key2認証' + (r.base ? ' / ' + r.base : '') + ') — HLSで再生を開始します');
            this.setState('CONNECTING');
            this.open();
            handled = true;
          } else if (r) {
            this.log(memberFailHint(r));
          }
        } catch (e) { /* 解決失敗 → 通常の待機へ */ }
        if (!handled) this.poll(TOKEN_POLL_MS);
      }
    }

    /* 生存確認(源候補を順にfetchして生きた源を採用)。
     戻り値: 'live' | 'offline' | 'token' | 'server'
     採用源は this.liveM3u8 / this.sourceKind に記録し、open()/Recorderで使う。
     master playlist(#EXT-X-STREAM-INF)はvariantまで確認して live/offline を正確に判定
     (abr.m3u8はofflineでもmasterが200を返すため)。 */
    async fetchProbe(url) {
      if (this.destroyed || typeof url !== 'string' || !/^https?:\/\//i.test(url)) return {status:0};
      const ctl = new AbortController();this._probes.add(ctl);
      const timer=setTimeout(()=>ctl.abort(),PROBE_TIMEOUT_MS);
      try {
        // Signed URLs are opaque. cache:no-store avoids changing their query string.
        const response=await fetch(url,{cache:'no-store',signal:ctl.signal});
        if(response.status!==200)return {status:response.status};
        const max=2*1048576;
        if(Number(response.headers&&response.headers.get('content-length'))>max)throw Error('PROBE_BODY_LIMIT');
        let text='';
        if(response.body&&typeof response.body.getReader==='function'){
          const reader=response.body.getReader(),decoder=new TextDecoder('utf-8',{fatal:true});let bytes=0,done=false;
          try{while(true){const part=await reader.read();if(part.done){done=true;break;}bytes+=part.value.byteLength;if(bytes>max)throw Error('PROBE_BODY_LIMIT');text+=decoder.decode(part.value,{stream:true});}text+=decoder.decode();}
          finally{if(!done)try{await reader.cancel();}catch(ignore){}reader.releaseLock();}
        }else{text=await response.text();if(new TextEncoder().encode(text).length>max)throw Error('PROBE_BODY_LIMIT');}
        return {status:200,text};
      } catch(e){return {status:0};}
      finally{ctl.abort();clearTimeout(timer);this._probes.delete(ctl);}
    }
    async probe() {
      if (!this.liveInfo) {
        try { this.liveInfo=await resolveLiveInfo(this.id); } catch(e){this.liveInfo=null;}
      }
      let serverFailed=false;
      for(const base of this.hlsCandidates()){
        if(this.destroyed)return 'offline';
        const response=await this.fetchProbe(base);if(this.destroyed)return 'offline';
        if(response.status===401||response.status===403){this.liveInfo=null;this.liveM3u8='';return 'token';}
        if(response.status===0||response.status>=500){serverFailed=true;continue;}
        if(response.status!==200||!/^\uFEFF?#EXTM3U(?:\r?\n|$)/.test(response.text||''))continue;
        const text=response.text;
        if(/^#EXTINF:/m.test(text)){this.liveM3u8=base;this.sourceKind=this.hlsKindOf(base);return 'live';}
        if(/^#EXT-X-STREAM-INF:/m.test(text)){
          const variants=parseVariants(text,base),variant=variants.length?(pickBestVariant(variants)||variants[0]):null;
          if(!variant)continue;
          const child=await this.fetchProbe(variant.url);if(this.destroyed)return 'offline';
          if(child.status===401||child.status===403){this.liveInfo=null;this.liveM3u8='';return 'token';}
          if(child.status===0||child.status>=500){serverFailed=true;continue;}
          if(child.status===200&&/^\uFEFF?#EXTM3U(?:\r?\n|$)/.test(child.text||'')&&/^#EXTINF:/m.test(child.text)){
            this.liveM3u8=base;this.sourceKind=this.hlsKindOf(base);return 'live';
          }
        }
      }
      this.liveM3u8='';this.liveInfo=null;return serverFailed?'server':'offline';
    }

    scheduleRetry(reason) {
      this.attempt++;
      // 生存確認が4回連続失敗したら、もう一方の経路を強制試行
      if (this.attempt % 4 === 0) {
        this.transportIdx = (this.transportIdx + 1) % this.transports().length;
        this.log('生存確認が連続失敗 → ' + this.currentTransport().label + ' を強制試行');
        this.open();
        return;
      }
      const delay = Math.min(1000 * Math.pow(1.6, this.attempt - 1), 8000) * (0.8 + Math.random() * 0.4);
      this.setState('RETRY', { attempt: this.attempt, reason: reason, waitMs: delay });
      setTimeout(() => { if (!this.destroyed) this.enter(); }, delay);
    }

    poll(ms) {
      if (this._poll) clearTimeout(this._poll);
      this._poll = setTimeout(() => { if (!this.destroyed) this.enter(); }, ms);
    }

    /* ---- 経路オープン ---- */
    open() {
      if (this.destroyed) return;
      this.setState('CONNECTING');
      const t = this.currentTransport();
      this.ui.setTransport(t.label);
      this.log('接続: ' + t.label);
      if (t.kind === 'hls') this.openHls(t); else this.openFlv(t);
      this.startWatchdog();
    }

    openHls(t) {
      if (!HAS_HLS) { this.failOver('hls.js 利用不可'); return; }
      const video = this.ui.video;
      const hls = new HlsCtor({
        enableWorker: true,
        lowLatencyMode: false,
        liveSyncDurationCount: 3,
        liveMaxLatencyDurationCount: 12,
        maxBufferLength: 20,
        backBufferLength: 30,
        startFragPrefetch: true,
        manifestLoadingMaxRetry: 6,
        manifestLoadingRetryDelay: 500,
        manifestLoadingMaxRetryTimeout: 6000,
        levelLoadingMaxRetry: 6,
        levelLoadingRetryDelay: 500,
        fragLoadingMaxRetry: 8,
        fragLoadingRetryDelay: 400,
        fragLoadingMaxRetryTimeout: 8000
      });
      this.hls = hls;
      hls.loadSource(t.url);
      hls.attachMedia(video);
      hls.on(HlsCtor.Events.MANIFEST_PARSED, () => {
        // v1.9.0: 再生画質セレクタ(自動/最高/各レベル) — 録画は常に設定に従い最高
        try {
          this.ui.setQualityLevels(hls.levels || []);
          let pref = 'auto';
          try { pref = localStorage.getItem('rsp_playq') || 'auto'; } catch (e2) {}
          if (pref !== 'auto') this.setPlaybackQuality(pref);
        } catch (e2) {}
        video.play().catch(function () {});
      });
      if (HlsCtor.Events.LEVELS_UPDATED) {
        hls.on(HlsCtor.Events.LEVELS_UPDATED, () => {
          try { this.ui.setQualityLevels(hls.levels || []); } catch (e2) {}
        });
      }
      // v1.10.0: 音声トラックの最良選択(「⤒ 最高画質」設定に連動 — 最高帯域のトラック)
      if (HlsCtor.Events.AUDIO_TRACKS_UPDATED) {
        hls.on(HlsCtor.Events.AUDIO_TRACKS_UPDATED, () => {
          try {
            if (!this.ui.bestQualityChecked || !this.ui.bestQualityChecked()) return;
            const tracks = hls.audioTracks || [];
            if (tracks.length < 2) return;
            let best = 0;
            for (let i = 1; i < tracks.length; i++) {
              if ((tracks[i].bitrate || 0) > (tracks[best].bitrate || 0)) best = i;
            }
            if (hls.audioTrack !== best) {
              hls.audioTrack = best;
              const t = tracks[best];
              this.log('音声トラック: ' + ((t && (t.name || t.lang)) || best) + ' を選択(最高帯域)');
            }
          } catch (e2) {}
        });
      }
      hls.on(HlsCtor.Events.ERROR, (evt, data) => {
        if (this.destroyed || this.hls !== hls) return;
        if (!data.fatal) return; // 500の bursts は hls.js 内部リトライに任せる
        this.log('HLS fatal: ' + data.details);
        if (data.type === HlsCtor.ErrorTypes.MEDIA_ERROR && !this.mediaRecovered) {
          this.mediaRecovered = true;
          try { hls.recoverMediaError(); return; } catch (e) {}
        }
        this.teardownTransport();
        this.onTransportFailure('HLS ' + data.details);
      });
    }

    /* v1.9.0: 再生画質の選択(auto=ABR(既定・安定優先) / best=最高 / レベルindex)。
     録画は常に設定に従い最高画質で行われるため、再生側は帯域に応じたABRを既定とする */
    setPlaybackQuality(v) {
      const hls = this.hls;
      if (!hls || this.destroyed) return;
      try {
        const levels = hls.levels || [];
        if (v === 'auto') { hls.currentLevel = -1; return; }
        let idx = -1;
        if (v === 'best') {
          let bestScore = -1;
          for (let i = 0; i < levels.length; i++) {
            const lv = levels[i];
            const fps = lv.attrs && lv.attrs['FRAME-RATE'] ? (parseFloat(lv.attrs['FRAME-RATE']) || 0) : 0;
            const score = (lv.width || 0) * (lv.height || 0) * 1000 + fps * 10 + (lv.bitrate || 0) / 1000;
            if (score > bestScore) { bestScore = score; idx = i; }
          }
        } else {
          idx = parseInt(v, 10);
          if (!(idx >= 0 && idx < levels.length)) idx = -1;
        }
        if (idx >= 0) hls.nextLevel = idx;
      } catch (e) {}
    }

    openFlv(t) {
      if (!HAS_FLV) { this.failOver('flv.js 利用不可'); return; }
      const video = this.ui.video;
      let flv;
      try {
        flv = FlvCtor.createPlayer({
          type: 'flv', isLive: true, url: t.url, cors: true, hasAudio: true, hasVideo: true
        }, {
          enableStashBuffer: false,
          stashInitialSize: 128,
          liveBufferLatencyChasing: true,
          liveBufferLatencyMaxLatency: 8,
          liveBufferLatencyChasingTarget: 1.5,
          lazyLoad: false,
          autoCleanupSourceBuffer: true
        });
      } catch (e) { this.failOver('flv 生成失敗'); return; }
      this.flv = flv;
      flv.attachMediaElement(video);
      flv.load();
      flv.play();
      flv.on(FlvCtor.Events.ERROR, (type, detail) => {
        if (this.destroyed || this.flv !== flv) return;
        this.log('FLV error: ' + type + '/' + detail);
        this.teardownTransport();
        this.onTransportFailure('FLV ' + detail);
      });
    }

    failOver(reason) {
      this.consecutiveFails++;
      this.transportIdx = (this.transportIdx + 1) % this.transports().length;
      this.log('経路切替 → ' + this.currentTransport().label + ' (' + reason + ')');
      this.open();
    }

    onTransportFailure(reason) {
      if (this.destroyed) return;
      this.consecutiveFails++;
      this.attempt++;
      const list = this.transports();
      if (this.consecutiveFails >= 2) {
        this.transportIdx = (this.transportIdx + 1) % list.length;
        this.consecutiveFails = 0;
        this.log('連続失敗 → ' + this.currentTransport().label + ' へ自動切替 (' + reason + ')');
      }
      const t = this.currentTransport();
      const cap = t.kind === 'flv' ? FLV_BACKOFF_CAP : HLS_BACKOFF_CAP;
      const base = t.kind === 'flv' ? 400 * this.attempt : 1200 * Math.pow(2, this.attempt - 1);
      const delay = Math.min(base, cap) * (0.8 + Math.random() * 0.4);
      this.setState('RETRY', { attempt: this.attempt, reason: reason, waitMs: delay });
      const fn = (this.attempt % 6 === 0) ? () => this.enter() : () => this.open();
      setTimeout(() => { if (!this.destroyed) fn(); }, delay);
    }

    /* ---- 凍結監視 (1秒ごとに再生位置の前進を確認) ---- */
    startWatchdog() {
      this.stopWatchdog();
      this.stallMs = 0;
      this.lastVideoTime = -1;
      this.progressTicks = 0;
      this._wd = setInterval(() => this.wdTick(), TICK_MS);
    }

    stopWatchdog() {
      if (this._wd) { clearInterval(this._wd); this._wd = null; }
    }

    wdTick() {
      if (this.destroyed) return;
      if (this.state !== 'LIVE' && this.state !== 'CONNECTING') return;
      if (document.hidden) return; // 非表示タブでの誤検出回避
      const v = this.ui.video;
      const t = v.currentTime || 0;
      if (t > this.lastVideoTime + 0.15) {
        if (this.state !== 'LIVE') {
          this.setState('LIVE');
          this.log('再生安定: LIVE');
          if (this.ui.autoStopChecked && this.ui.autoStopChecked()) {
            const n = stopOfficialPlayers(this.ui);
            if (n > 0) this.log('公式プレイヤーを自動停止(' + n + '件) — 帯域二重消費を防止');
          }
          if (this.ui.onLive) this.ui.onLive();
        }
        this.stallMs = 0;
        this.progressTicks++;
        if (this.progressTicks >= 3 && (this.attempt > 0 || this.consecutiveFails > 0)) {
          this.attempt = 0;
          this.consecutiveFails = 0;
          this.log('3秒以上継続 → バックオフ解除');
        }
        let lat = 0;
        try {
          const b = v.buffered;
          if (b && b.length) lat = Math.max(0, b.end(b.length - 1) - t);
        } catch (e) {}
        this.ui.setStats({ latency: lat });
      } else if (this.state === 'LIVE') {
        this.stallMs += TICK_MS;
        this.ui.setStats({ stall: this.stallMs });
        if (this.stallMs === NUDGE_MS) {
          this.nudge();
        } else if (this.stallMs >= RECONNECT_MS) {
          this.log('凍結 ' + (this.stallMs / 1000) + '秒 → 完全再接続');
          this.teardownTransport();
          this.onTransportFailure('stall(凍結)');
          return;
        }
      }
      this.lastVideoTime = t;
    }

    nudge() {
      this.log('停滞検出 → 軽量復旧');
      const v = this.ui.video;
      try {
        if (this.hls) {
          const b = v.buffered;
          if (b && b.length && b.end(b.length - 1) - v.currentTime > 1.2) {
            v.currentTime = b.end(b.length - 1) - 0.4; // バッファ先頭へスキップ
          } else {
            this.hls.startLoad(-1); // ライブエッジから再ロード
          }
        } else if (this.flv) {
          // flv.js は latencey chasing があるが追いつけない場合は即リトライ
          this.teardownTransport();
          this.onTransportFailure('FLV停滞');
        }
      } catch (e) {}
    }

    teardownTransport() {
      this.stopWatchdog();
      this.mediaRecovered = false;
      if (this.hls) {
        try { this.hls.destroy(); } catch (e) {}
        this.hls = null;
      }
      if (this.flv) {
        try { this.flv.pause(); } catch (e) {}
        try { this.flv.unload(); } catch (e) {}
        try { this.flv.detachMediaElement(); } catch (e) {}
        try { this.flv.destroy(); } catch (e) {}
        this.flv = null;
      }
      const v = this.ui.video;
      try { v.removeAttribute('src'); v.load(); } catch (e) {}
    }

    /* ---- 手動操作 ---- */
    manualReconnect() {
      if (this.destroyed) return;
      if (this._poll) { clearTimeout(this._poll); this._poll = null; }
      this.attempt = 0;
      this.consecutiveFails = 0;
      this.teardownTransport();
      this.log('手動再接続');
      this.enter();
    }

    manualSwitch() {
      if (this.destroyed) return;
      if (this._poll) { clearTimeout(this._poll); this._poll = null; }
      this.attempt = 0;
      this.consecutiveFails = 0;
      this.teardownTransport();
      this.transportIdx = (this.transportIdx + 1) % this.transports().length;
      this.log('手動切替 → ' + this.currentTransport().label);
      this.open();
    }

    setCustomM3u8(url) {
      this.customM3u8 = (url || '').trim();
      try {
        if (this.customM3u8) localStorage.setItem('rsp_custom_m3u8', this.customM3u8);
        else localStorage.removeItem('rsp_custom_m3u8');
      } catch (e) {}
      this.log(this.customM3u8 ? 'm3u8 URL上書きを設定' : 'm3u8 URL上書きを解除');
    }
  }


  /* ============================================================
     ==== RSP RECORDING CORE — v2.0 Step1 切出し(BEGIN) ====
     このマーカー間が「録画コア」: 三形態(user.js/両拡張content.js)で
     同一文字列を共有し、v2.0 Step2/3ではoffscreen document(Chrome)/
     background event page(Firefox)へそのまま持ち出す単位。
     コアがページ環境に依存する箇所はすべてRECENV経由に統一してあり、
     Step2ではRECENVの実装差し替えのみで移譲できる。
     コア外へのアンビエント依存(Step2で注入が必要なもの):
       CDN_BASE / API_BASE / resolveMemberLive / resolveScheduleInfo /
       fetchSchedulesFor / memberFailHint / liveBaseLabel /
       idbOpen・idbAddSession・idbListSessions・idbClearSessions
       (履歴IndexdDB) / Recorder生成時のdeps引数(mount()で明示注入)
     ============================================================ */
  /* ================= v2.9.1(B-01): Blob URL遅延解放の契約 =================
     従来のRECENV.download/VOD保存は盲目的タイマー(10秒/30秒)でrevokeObjectURL
     していた。revokeは同期的・ダウンロード開始は非同期であり(Chromium
     Issue 41380177・MDN「avoid freeing the object URL too early」)、
     anchor.click()から取得登録までの間に解放すると保存が破損し得る。
     そこで「ダウンロード開始の確認後に解放する遅延解放」をサイズ比例の
     保持時間で契約化する: 保守スループット10MiB/s想定・床30秒・上限600秒。 */
  function rspBlobHoldMs(bytes) {
    var RSP_BLOB_FLOOR_MS = 30000;          // 床: 小容量・無効値も最低30秒保持
    var RSP_BLOB_CAP_MS = 600000;           // 上限: 異常に大きなblobでも10分以内
    var RSP_BLOB_BYTES_PER_SEC = 10 * 1024 * 1024; // 保守10MiB/s書込想定
    var n = Number(bytes);
    if (!isFinite(n) || n <= 0) return RSP_BLOB_FLOOR_MS; // 失敗安全側=床
    var hold = Math.ceil(n / RSP_BLOB_BYTES_PER_SEC * 1000);
    return Math.min(RSP_BLOB_CAP_MS, Math.max(RSP_BLOB_FLOOR_MS, hold));
  }
  function rspDelayedBlobRelease(url, anchor, bytes) {
    var holdMs = rspBlobHoldMs(bytes);
    setTimeout(function () {
      try { URL.revokeObjectURL(url); } catch (e) {}
      try { if (anchor && typeof anchor.remove === 'function') anchor.remove(); } catch (e) {}
    }, holdMs);
    return holdMs;
  }
  const RECENV = (typeof RSP_RECENV_HOOK !== 'undefined' && RSP_RECENV_HOOK) ? RSP_RECENV_HOOK : {
    /* ページURL(相対m3u8 URIの絶対化基準) */
    pageUrl: function () { try { return location.href; } catch (e) { return 'https://rplay.live/'; } },
    /* localStorage(セッション永続化・設定フォールバック) */
    storageGet: function (k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    storageSet: function (k, v) { try { localStorage.setItem(k, v); } catch (e) {} },
    storageDel: function (k) { try { localStorage.removeItem(k); } catch (e) {} },
    /* ファイルダウンロード(メモリ保存方式) — v2.9.1(B-01): Blob URLは
       サイズ比例の遅延解放契約(rspDelayedBlobRelease)で保持・解放する */
    download: function (blob, name) {
      const a = document.createElement('a');
      const url = URL.createObjectURL(blob);
      a.href = url;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      rspDelayedBlobRelease(url, a, blob.size);
    },
    /* デスクトップ通知(権限確認はRECENV実装側の責務 — v2.0 Step2:
       ページ実装はNotification権限を確認するが、offscreen実装は権限不要の
       chrome.notifications(SW中継)へ送るため確認しない) */
    notify: function (title, body) {
      try {
        if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
        new Notification(title, { body: body });
      } catch (e) {}
    },
    /* タブタイトル(●REC表示) */
    getTitle: function () { try { return document.title; } catch (e) { return ''; } },
    setTitle: function (t) { try { document.title = t; } catch (e) {} },
    /* ページ退去時の確認ダイアログ */
    onUnload: function (fn) { try { window.addEventListener('beforeunload', fn); } catch (e) {} },
    offUnload: function (fn) { try { window.removeEventListener('beforeunload', fn); } catch (e) {} },
    /* JSヒープ使用量(監視フック用・非対応環境はnull) */
    perfHeap: function () {
      try { if (performance.memory && performance.memory.usedJSHeapSize) return performance.memory.usedJSHeapSize; } catch (e) {}
      return null;
    },
    /* 試験フック(window.__RSP_TEST) */
    testHooks: function () { try { return window.__RSP_TEST || {}; } catch (e) { return {}; } },
    /* v2.1.0(設計書§4.3): パートクローズ時のOPFS複製退避(最新2パート)&復旧記録フック */
    backupPart: function () {},
    recoveredParts: function () { return []; },
    /* v2.7.0(A-02/A-03): 認証・canary証拠の供給フック。ページ実装はRspAuthと
       直前のcanary結果から組み立てる(秘密は種別と計数のみ)。拡張ホスト
       (offscreen等)は未供給でもよい — その場合は証拠ブロックを出さない
       (虚偽のゼロを捏造しない)。 */
    authStats: function () { try { return RspAuth.authEvidence(); } catch (e) { return undefined; } },
    canaryEvidence: function () { return _lastCanary ? rspCanaryEvidence(_lastCanary) : undefined; },
    butterToken: function () { try { return butterToken(); } catch (e) { return Promise.resolve(''); } },
    /* Worker生成(v2.0 Step2: MV3拡張ページのCSP(script-src 'self')は
       Blob URL Workerをブロックするため、ホストが差し替え可能にする。
       nullを返すと呼び側はフォールバック(ticker=setInterval/検証=同期)へ) */
    makeWorker: function (src) {
      try { return new Worker(URL.createObjectURL(new Blob([src], { type: 'application/javascript' }))); }
      catch (e) { return null; }
    },
    /* v2.39.0: 自動開始の共通policy問い合わせ(全開始経路の統一gate)。
       ページ実装: 拡張content script環境(chrome.storage.local)でのみ保存済み
       rsp_dashboard_defaults を確認する。userscript等の拡張なし環境は
       「許可」(policy源なし — 従来挙動)。設定が読めない/不正な場合は
       「不明」を返し、呼び出し側は自動開始しない(fail-closed — BG側の
       START_SETTINGS_UNAVAILABLEと同じ安全側)。手動開始は問い合わせない。 */
    autoPolicy: function () {
      return new Promise(function (resolve) {
        let done = false;
        const finish = function (v) { if (!done) { done = true; resolve(v); } };
        try {
          if (typeof chrome === 'undefined' || !chrome || !chrome.storage || !chrome.storage.local || typeof chrome.storage.local.get !== 'function')
            return finish({ verdict: 'allowed' });
          const bound = (function () { try { const v = Number(RECENV.testHooks().settingsReadMs); return v > 0 ? v : 3000; } catch (e) { return 3000; } })();
          let timer = 0;
          if (typeof setTimeout === 'function') { try { timer = setTimeout(function () { finish({ verdict: 'unavailable' }); }, bound); } catch (e) { timer = 0; } }
          chrome.storage.local.get('rsp_dashboard_defaults', function (v) {
            if (timer) { try { clearTimeout(timer); } catch (e) {} }
            if (chrome.runtime.lastError || !v || typeof v !== 'object') return finish({ verdict: 'unavailable' });
            const d = v.rsp_dashboard_defaults;
            if (d !== undefined && (!d || typeof d !== 'object' || Array.isArray(d) ||
              ['autoStartAllowed', 'enabled', 'follow', 'recAudio', 'preferJapaneseAudio', 'inheritQuery', 'mp4Handover'].some(function (k) { return d[k] !== undefined && typeof d[k] !== 'boolean'; }) ||
              (d.splitMin !== undefined && (typeof d.splitMin !== 'number' || !Number.isFinite(d.splitMin) || d.splitMin < 0 || d.splitMin > 1440))))
              return finish({ verdict: 'unavailable' });
            finish({ verdict: (d && d.autoStartAllowed === false) ? 'denied' : 'allowed' });
          });
        } catch (e) { finish({ verdict: 'unavailable' }); }
      });
    },
    /* v2.39.0: セッション終了フック(offscreen版がBG停止後のMP4引渡し台帳を書く)。
       ページ実装は何もしない。呼び出し側は返りPromiseを待たない(停止表示を
       遅らせない)。 */
    sessionEnded: function () {}
  };
  /* v2.0 Step2: RSP_RECENV_HOOK — 埋め込みホスト(offscreen.js)が録画コアを別環境で
     動かすための差し替え点。ページ環境(user.js/拡張content.js)では未定義のため
     上記のページ実装をそのまま使用する(挙動変化なし)。 */

  /* ================= Recorder v2: 無劣化録画 + 配信切替の自動追跡 =================
   再生エンジンと独立してプレイリストを監視し、新セグメント(.ts)をそのまま取得・
   結合して保存する(再生が止まっても録画は継続する)。

   v1.2.0 の追跡機構:
   - HLS(.ts)録画中に配信終了(ENDLIST / 連続404 / セグメント停止)を検出したら
     「追跡待機(STANDBY)」へ移行。追跡OFF設定のときは従来どおり自動保存して停止
   - 追跡待機では ①同一URLのプレイリスト再probe ②RPLAY API
     (GET /live/stream?creatorOid= — 認証不要・rplay.liveからCORS許可)を監視し、
     同一クリエイターの次の配信が始まると自動で録画を再開する
     (RPLAYの /live/<id> の id はクリエイターOIDそのもの = URLは配信が変わっても不変)
   - HLSが受信できない間にFLVが生きていれば、FLVストリームを無劣化のまま取得して
     録画を継続(配信者側の切り替え/CDN障害のどちらでも取りこぼしを最小化)
   - 保存先: File System Access API対応(Chrome/Edge)ではフォルダへ直接書き込み
     (メモリ制限なし)。非対応はメモリ保持→自動分割ダウンロード
   - セグメント名は <oid>-ss-<セッション>-<連番>-<時刻>.ts で一意のため、
     seen集合の重複排除だけで配信をまたいだ二重取得を防止できる
   - タイマーはWeb Worker内で動くため、タブをバックグラウンドにしても
     ポーリング間隔が劣化しない(Worker生成不可環境では通常タイマー) */

  const REC_POLL_MS = 3000;           // tick間隔(実際のプレイリスト取得は下記の適応間隔でゲート)
  const REC_POLL_MIN_MS = 4000;       // プレイリスト取得の最短間隔
  const REC_POLL_MAX_MS = 10000;      // プレイリスト取得の最長間隔
  const REC_POLL_TARGET_FACTOR = 0.6; // TARGETDURATION×この倍率を基準(公式プレイヤー級の負荷)
  const REC_POLL_JITTER = 0.1;        // 間隔ジッタ(機械的な定期アクセスを避ける)
  const REC_STANDBY_MS = 20000;       // 追跡待機の探索間隔(±10%ジッタ付き)
  const REC_SEG_MAX_TRIES = 8;
  const REC_SEG_TIMEOUT_MS = 15000;   // セグメント1取得のタイムアウト
  const REC_REQ_MIN_GAP_MS = 250;     // 録画リクエスト開始間隔の下限(サーバー負荷配慮)
  const REC_403_COOLDOWN_MS = 60000;  // 403時の待機(連打しない)
  const REC_429_BASE_MS = 30000;      // 429時の指数バックオフ初回
  const REC_429_MAX_MS = 300000;      // 429バックオフ上限
  /* v1.12.0(改善点調査の反映): Retry-After(RFC9110 §10.2.3)準拠。
   429/503応答にサーバー指定の待機秒(またはHTTP日時)があれば、指数バックオフより
   優先してそれを尊重する(yc-dlp/streamlink系クライアントのベストプラクティス)。
   短すぎる値は1秒・長すぎる値は300秒に丸める(既存の退避上限と一致) */
  function recRetryAfterMs(h) {
    if (!h) return 0;
    const n = parseInt(h, 10);
    if (!isNaN(n) && n >= 0) return Math.min(Math.max(n, 1), 300) * 1000;
    const d = Date.parse(h);
    if (!isNaN(d)) return Math.min(Math.max(Math.round((d - Date.now()) / 1000), 1), 300) * 1000;
    return 0;
  }
  const REC_FILE_CAP_BYTES = RECENV.partByteLimit || 600 * 1024 * 1024; // 1ファイル容量上限(超過で分割)
  const REC_404_GIVE_UP = 4;          // 追跡OFF時: 連続404で終了保存
  const REC_404_STANDBY = 3;          // 追跡ON時: 連続404で追跡待機へ
  // Official live/play preference; legacy remains the last HLS fallback.
  function rspSourceCandidates(info, legacy) {
    info = info || {};
    const urls = info.useBytePlusStream === true
      ? [info.bytePlusPlaybackUrl, info.playUrl, legacy]
      : [info.playUrl, info.bytePlusPlaybackUrl, legacy];
    return Array.from(new Set(urls.filter(u => typeof u === 'string' && /^https?:\/\//i.test(u))));
  }

  const REC_END_STALL_MS = 90000;     // 新セグメント停止90秒で終了扱い
  const REC_FLV_COOLDOWN_MS = 30000;  // FLV代替の再試行クールダウン
  const REC_API_TIMEOUT_MS = 6000;
  /* v1.9.0: 画質選択(最高画質)の定数。
   再走査間隔は試験フック(window.__RSP_TEST.qualityRescanMs)で短縮可(5000以上)。 */
  /* v2.0 Step1: 試験フックはRECENV.testHooks()経由(コアのページ依存を集約) */
  const REC_QUALITY_RESCAN_MS = (function () {
    try { const v = Number(RECENV.testHooks().qualityRescanMs); if (v >= 5000) return v; } catch (e) {}
    return 300000; // master再走査(画質昇格チェック)の間隔(既定5分)
  })();
  const REC_QUALITY_FALLBACK_MS = 30000; // variant消失時フォールバックの節流
  /* v1.11.0: AudioRecorder(音声レンディション個別録画)の定数。
   要求オフセットは「同一瞬間の同時2リクエストを避ける」ための設計値(300〜500ms)。 */
  const REC_AUDIO_OFFSET_MS_MIN = 300;  // 映像ループ開始からの要求オフセット(下限)
  const REC_AUDIO_OFFSET_MS_MAX = 500;  // 同・上限
  const REC_AUDIO_STALL_MS = 90000;     // 新音声セグメント停止90秒で停止(映像と同一基準)
  /* v1.10.0: リマインド/メモリ/履歴/予約一覧の定数。
   リマインド閾値は試験フック(window.__RSP_TEST.remind10Ms/remind5Ms)で短縮可。 */
  const REC_SEEN_MAX = 30000;          // seen集合の上限(長時間録画の肥大化抑制)
  const REC_SEEN_KEEP = 12000;         // 上限到達時に残す件数
  const REC_QUEUE_WARN_MS = 60000;     // キュー滞留警告の節流
  const REC_REMIND10_MS = 600000;      // 予約リマインド(10分前)の閾値
  const REC_REMIND5_MS = 300000;       // 予約リマインド(5分前)の閾値
  const SCHED_SCAN_MIN_MS = 600000;    // 予約一覧の自動巡回間隔(10分 — サーバー配慮)
  const HIST_DB = 'rsp_history';       // 録画履歴(IndexedDB)
  const HIST_STORE = 'sessions';
  const HIST_MAX = 50;                 // 履歴保持上限(古いものから自動削除)
  /* v1.6.0: 録画セッションの永続化(クラッシュ/再読み込みからの断点復帰) */
  const REC_SESSION_KEY = 'rsp_rec_session';
  const REC_SESSION_TTL_MS = 15 * 60 * 1000;  // 復帰提案の有効期限(停止後15分以内)
  const REC_SESSION_WRITE_EVERY = 2;          // 永続化間隔(3秒tick×2=約6秒)
  /* APIベースURL(上級フック: window.__RSP_API_BASE または localStorage.rsp_api_base で差し替え可。試験・自己責任用) */
  const API_BASE = (function () {
    try {
      if (typeof window.__RSP_API_BASE === 'string' && window.__RSP_API_BASE) return window.__RSP_API_BASE;
      const v = localStorage.getItem('rsp_api_base');
      if (v) return v;
    } catch (e) {}
    return 'https://api.rplay.live';
  })();

  /* ================= 画質選択(v1.9.0: 最高画質の自動選択) =================
   既存ツール(yt-dlp/streamlink/N_m3u8DL-RE)の画質選択を調査した結果を踏襲:
   - yt-dlpは既定ソートで res(解像度) > fps > br(帯域) の順に比較する
   - streamlink/N_m3u8DL-REはmasterから最良variantへ固定し、高画質出現時の
     昇格とvariant消失時の次画質フォールバックを備える
   → 録画は「解像度(面積) → fps → 帯域」の優先順で最高variantを選ぶ。
     TS無劣化録画ではデコード互換性を気にする必要がなく、ユーザーが知覚する
     解像度/fpsを帯域より優先するのが既存ツールの合意。 */
  function parseM3u8Attrs(str) {
    const out = {};
    const re = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/g;
    let m;
    while ((m = re.exec(String(str)))) {
      let v = m[2];
      if (v.charAt(0) === '"') v = v.slice(1, -1);
      out[m[1]] = v;
    }
    return out;
  }
  function parseVariants(txt, base) {
    // baseが相対パス(custom m3u8等)の場合は先に絶対化する(ページURL基準)。
    // 絶対化しないと new URL(uri, 相対base) が失敗し、救済の location.href では
    // ページディレクトリ(/live/<id>)基準に解決されて誤ったURLになる(v1.9.0修正)。
    let absBase = String(base || '');
    try { absBase = new URL(absBase, RECENV.pageUrl()).href; } catch (e) { /* 相対解決不可 → そのまま */ }
    const lines = String(txt).split('\n');
    const out = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (line.indexOf('#EXT-X-STREAM-INF:') !== 0) continue;
      const attrs = parseM3u8Attrs(line.slice(18));
      let uri = '';
      for (let j = i + 1; j < lines.length; j++) {
        const s = lines[j].trim();
        if (!s) continue;
        if (s.charAt(0) === '#') {
          if (s.indexOf('#EXT-X-STREAM-INF:') === 0) break;
          continue;
        }
        uri = s; break;
      }
      if (!uri) continue;
      const res = String(attrs['RESOLUTION'] || '').split('x');
      const v = {
        url: '',
        bw: parseInt(attrs['BANDWIDTH'], 10) || 0,
        width: parseInt(res[0], 10) || 0,
        height: parseInt(res[1], 10) || 0,
        fps: parseFloat(attrs['FRAME-RATE']) || 0,
        codecs: attrs['CODECS'] || '',
        audioGroup: attrs['AUDIO'] || '',
        subsGroup: attrs['SUBTITLES'] || ''   // v2.9.0(A-09): 字幕グループ結合属性
      };
      v.bwEff = parseInt(attrs['AVERAGE-BANDWIDTH'], 10) || v.bw;
      try {
        v.url = new URL(uri, absBase).href;
      } catch (e) { continue; }
      out.push(v);
    }
    return out;
  }
  /* 最良variantの選択(解像度面積 → fps → 帯域の辞書式比較)。
   exclude: 消失(404等)したvariant URLの集合(フォールバック時に除外)。 */
  function pickBestVariant(vars, exclude) {
    const pool = [];
    for (let i = 0; i < vars.length; i++) {
      if (exclude && typeof exclude.has === 'function' && exclude.has(vars[i].url)) continue;
      pool.push(vars[i]);
    }
    if (!pool.length) return null;
    let best = pool[0];
    for (let i = 1; i < pool.length; i++) {
      const a = best, b = pool[i];
      const pa = a.width * a.height, pb = b.width * b.height;
      if (pb > pa || (pb === pa && (b.fps > a.fps || (b.fps === a.fps && b.bwEff > a.bwEff)))) best = b;
    }
    return best;
  }
  function qualityLabel(v) {
    if (!v) return '';
    let s = (v.height ? (v.height + 'p') : '音声');
    if (v.fps) s += Math.round(v.fps);
    if (v.bwEff) s += '(' + (v.bwEff >= 1000000 ? (v.bwEff / 1000000).toFixed(1) + 'Mbps' : Math.round(v.bwEff / 1000) + 'kbps') + ')';
    return s;
  }
  /* 昇格判定: 解像度/fpsが上なら昇格。同解像度同fpsは帯域30%増のみ
   (チャタリング防止 — streamlinkの固定挙動に寄せた安全側)。 */
  function isBetterVariant(cand, cur) {
    if (!cand || !cur) return false;
    const pxC = cand.width * cand.height, pxCur = cur.width * cur.height;
    if (pxC !== pxCur) return pxC > pxCur;
    if (cand.fps !== cur.fps) return cand.fps > cur.fps;
    return cand.bwEff > cur.bwEff * 1.3;
  }

  /* ================= v1.10.0: 音声レンディション(EXT-X-MEDIA TYPE=AUDIO) =================
   master playlistの音声グループを解析し、映像variant(#EXT-X-STREAM-INFのAUDIO属性)
   と紐付けてREC表示/情報JSONに記録する。yt-dlpがフォーマットソートで音声帯域を
   独立キーとして扱うのに対し、HLS masterは音声帯域を含まないため、ここでは
   「グループ名/チャンネル数」の検出・表示と再生側の最良トラック選択を行う。 */
  /* v1.11.0: URI属性+帯域(AVERAGE-BANDWIDTH優先・無ければBANDWIDTH)の解析を追加。
   戻り値: audioGroupMap[gid] = {name, channels, count, uri, bw}
   同一グループに複数のURI(言語違い等)がある場合は帯域最大の1つを採用する
   既定は帯域優先。明示設定時のみ日本語を優先する。baseはURIの相対解決に使う。 */
  function parseAudioGroups(txt, base, preferJapanese) {
    // No inherited object properties may be interpreted as playlist groups.
    const out = Object.create(null);
    let absBase = String(base || '');
    try { absBase = new URL(absBase, RECENV.pageUrl()).href; } catch (e) {}
    const safeBandwidth = function (v) {
      const raw = String(v || '');
      if (!/^[0-9]+$/.test(raw)) return 0;
      const n = Number(raw);
      return Number.isSafeInteger(n) ? n : 0;
    };
    const languageRank = function (language) {
      const tag = String(language || '').toLowerCase();
      return tag === 'ja' ? 2 : /^ja-[a-z0-9]{2,8}(?:-[a-z0-9]{2,8})*$/.test(tag) ? 1 : 0;
    };
    const lines = String(txt).split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (line.indexOf('#EXT-X-MEDIA:') !== 0) continue;
      const attrs = parseM3u8Attrs(line.slice(13));
      if (String(attrs['TYPE'] || '').toUpperCase() !== 'AUDIO') continue;
      const gid = attrs['GROUP-ID'] || '';
      if (!gid) continue;
      if (!out[gid]) out[gid] = { name: '', channels: '', count: 0, uri: '', bw: 0, language: '', preferredMatched: false, isDefault: false };
      const g = out[gid];
      g.count++;
      const raw = attrs['URI'] || '';
      let resolved = '';
      if (raw && raw === raw.trim() && !/[\x00-\x1f\x7f]/.test(raw)) {
        try {
          const u = new URL(raw, absBase);
          if ((u.protocol === 'http:' || u.protocol === 'https:') && !u.username && !u.password) resolved = u.href;
        } catch (e) {}
      }
      if (resolved) {
        const bw = safeBandwidth(attrs['AVERAGE-BANDWIDTH']) || safeBandwidth(attrs['BANDWIDTH']);
        const rank = preferJapanese ? languageRank(attrs['LANGUAGE']) : 0;
        const previousRank = preferJapanese ? languageRank(g.language) : 0;
        const isDefault = String(attrs['DEFAULT'] || '').toUpperCase() === 'YES';
        const preferDefault = !!preferJapanese && isDefault !== g.isDefault;
        if (!g.uri || rank > previousRank || (rank === previousRank && (preferDefault ? isDefault : bw > g.bw))) {
          g.uri = resolved; g.bw = bw;
          // Keep labels and channel information from the selected rendition.
          g.name = attrs['NAME'] || ''; g.channels = attrs['CHANNELS'] || '';
          g.language = languageRank(attrs['LANGUAGE']) ? String(attrs['LANGUAGE']).toLowerCase() : '';
          g.preferredMatched = rank > 0; g.isDefault = isDefault;
        }
      } else if (!g.uri && !raw) {
        // Preserve display-only information for an in-band rendition.
        if (!g.name) g.name = attrs['NAME'] || '';
        if (!g.channels) g.channels = attrs['CHANNELS'] || '';
      }
    }
    return out;
  }
  /* ================= v2.11.0: TS細切れ防止(Continuity)とPaywall検出(W-05/W-06) =================
   Video DownloadHelper(vdhcoapp)・Stream Recorder・Streamlink等の知見を統合:
   - MPEG-TSはEXT-X-DISCONTINUITYでパートを強制分割せず単一ファイルへ連続追記(既定)
   - 分割分数(splitMinutes)の既定値を0(分割なし・容量上限まで単一ファイル継続)へ変更
   - Master 200 / Media 404(または403)の非対称応答をpaywall_blockedとして検出(rplay_watcher v0.5.2知見)
   Python側 detect_paywall_blocked / part_continuity_evidence と完全鏡像(相互言語比較試験で固定)。 */
  /* ================= v2.15.0(C-03): cat-catch m3u8dl:// 連携と前処理証拠 =================
   cat-catch(xifangczy/cat-catch)の「调用m3u8DL下载」(m3u8dl://カスタムプロトコル・
   N_m3u8DL-RE引数生成)と「数据预处理」(TS偽装ヘッダ除去)・クエリ継承のゼロ秘密証拠。
   Python側 build_m3u8dl_export / external_downloader_evidence と完全鏡像。 */
  function rspBuildM3u8dlExport(opts) {
    const o = opts || {};
    const url = String(o.url || '').trim();
    const saveName = String(o.saveName || 'RPLAY_stream').replace(/["\\]/g, '_');
    const hdrs = (o.headers && typeof o.headers === 'object') ? o.headers : {};
    const liveMerge = o.liveRealTimeMerge !== false;
    const hKeys = Object.keys(hdrs).filter(function (k) {
      return hdrs[k] !== undefined && hdrs[k] !== null && String(hdrs[k]) !== '';
    }).sort();
    const args = ['"' + url + '"', '--save-name "' + saveName + '"'];
    for (let i = 0; i < hKeys.length; i++) {
      const k = hKeys[i];
      const v = String(hdrs[k]).replace(/"/g, '\\"');
      args.push('--header "' + k + ': ' + v + '"');
    }
    if (liveMerge) {
      args.push('--live-real-time-merge');
      args.push('--live-pipe-mux');
    }
    const paramStr = args.join(' ');
    let b64 = '';
    try {
      if (typeof Buffer !== 'undefined') b64 = Buffer.from(paramStr, 'utf8').toString('base64');
      else b64 = btoa(unescape(encodeURIComponent(paramStr)));
    } catch (e) {}
    return {
      protocolUri: 'm3u8dl://' + b64,
      command: 'N_m3u8DL-RE ' + paramStr,
      targetUrl: url ? url.split('?')[0].split('#')[0] : null,
      saveName: saveName,
      headerKeys: hKeys,
      liveRealTimeMerge: Boolean(liveMerge)
    };
  }
  function rspExternalDownloaderEvidence(exp, stats) {
    const e = exp || {};
    const s = stats || {};
    const rawTarget = String(e.targetUrl || e.url || '');
    const cleanTarget = rawTarget ? rawTarget.split('?')[0].split('#')[0] : null;
    const hKeys = Array.isArray(e.headerKeys) ? e.headerKeys.slice().map(String).sort() : [];
    return {
      protocolScheme: 'm3u8dl',
      targetUrl: cleanTarget,
      saveName: e.saveName ? String(e.saveName) : null,
      headerKeys: hKeys,
      liveRealTimeMerge: Boolean(e.liveRealTimeMerge !== false),
      tsDisguiseStrippedCount: Number(s.tsDisguiseStrippedCount || 0),
      tsDisguiseBytesTotal: Number(s.tsDisguiseBytesTotal || 0),
      queryInheritedCount: Number(s.queryInheritedCount || 0),
      provenance: 'cat_catch_m3u8dl_and_preprocessor_v2120'
    };
  }
  function rspDetectPaywallBlocked(masterStatus, mediaStatus) {
    return Number(masterStatus) === 200 && (Number(mediaStatus) === 404 || Number(mediaStatus) === 403);
  }
  function rspPartContinuityEvidence(c) {
    const o = c || {};
    return {
      splitMinutes: Number(o.splitMinutes || 0),
      maxSizeMb: Number(o.maxSizeMb || 600),
      splitOnDiscontinuity: Boolean(o.splitOnDiscontinuity),
      discontinuityMergedCount: Number(o.discontinuityMergedCount || 0),
      discontinuitySplitCount: Number(o.discontinuitySplitCount || 0),
      sameSessionStandbyContinuations: Number(o.sameSessionStandbyContinuations || 0),
      partsConcatenated: Number(o.partsConcatenated || 0),
      concatOutput: o.concatOutput ? String(o.concatOutput) : null,
      provenance: 'vdh_coapp_and_streamlink_ts_continuity_v2100'
    };
  }

  /* ================= v2.9.0: 字幕レンディション(EXT-X-MEDIA TYPE=SUBTITLES) =================
   master playlistの字幕レンディションを観測・計数する(取得はしない安全側契約)。
   URI値は秘匿し取得可否(hasUri)のみ記録(URL秘匿契約)。未知の属性は埋め込まない
   (固定鍵集合のみ)。Python側 parse_subtitle_renditions と完全鏡像。 */
  function parseSubtitleRenditions(txt) {
    const out = [];
    const lines = String(txt).split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (line.indexOf('#EXT-X-MEDIA:') !== 0) continue;
      const attrs = parseM3u8Attrs(line.slice(13));
      if (String(attrs['TYPE'] || '').toUpperCase() !== 'SUBTITLES') continue;
      const gid = attrs['GROUP-ID'] || '';
      if (!gid) continue;
      out.push({
        groupId: gid,
        name: attrs['NAME'] || '',
        language: attrs['LANGUAGE'] || '',
        assocLanguage: attrs['ASSOC-LANGUAGE'] || '',
        default: String(attrs['DEFAULT'] || '').toUpperCase() === 'YES',
        autoselect: String(attrs['AUTOSELECT'] || '').toUpperCase() === 'YES',
        forced: String(attrs['FORCED'] || '').toUpperCase() === 'YES',
        hasUri: !!attrs['URI']
      });
    }
    return out;
  }
  /* v2.9.0(A-09): master playlist取得済み(非空)のときのみ証拠ブロックを出す。
   未取得(空文字/非文字列)はundefined(虚偽のゼロを捏造しない・A-08契約の継承)。
   Python側 subtitle_evidence_block と完全鏡像(相互言語比較試験で固定)。 */
  function rspSubtitleEvidenceBlock(masterTxt, variants) {
    if (typeof masterTxt !== 'string' || !masterTxt) return undefined;
    return rspSubtitleEvidence(parseSubtitleRenditions(masterTxt), variants);
  }

  function audioLabelFor(group, groups) {
    if (!group) return '';
    const g = groups && groups[group];
    if (!g) return '';
    let s = g.name || group;
    if (g.channels) s += '(' + g.channels + 'ch)';
    return s;
  }

  /* ================= v1.10.0: 保存ファイル名テンプレート =================
   {date}{time}{creator}{title}{quality}{part}{ext} を置換して保存名を作る。
   OSで禁止される文字は自動除去し、空になった場合は従来命名へフォールバック
   (後方互換: テンプレ未設定時は現行どおり)。 */
  function recFileName(tpl, ctx, defName) {
    let name = defName;
    const t = String(tpl || '').trim();
    if (t) {
      name = t
        .replace(/\{date\}/g, ctx.date || '')
        .replace(/\{time\}/g, ctx.time || '')
        .replace(/\{creator\}/g, safeName(ctx.creator || ''))
        .replace(/\{title\}/g, safeName(ctx.title || ''))
        .replace(/\{quality\}/g, safeName(ctx.quality || ''))
        .replace(/\{part\}/g, String(ctx.part || 1))
        .replace(/\{ext\}/g, ctx.ext || 'ts');
      name = name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '').trim();
      if (!name) name = defName;
      if (!new RegExp('\\.' + (ctx.ext || 'ts') + '$', 'i').test(name)) name += '.' + (ctx.ext || 'ts');
    }
    return name;
  }

  /* ================= v1.10.0: TS同期バイト検証のWeb Worker並列化 =================
   0x47多重検証をWorkerへ移譲しUIスレッドの負荷を低減する(N_m3u8DL-RE等の
   並列検証に相当)。Worker生成不可の環境では同期検証へ自動フォールバック。
   検証はセグメントごとに独立しているため、書込順序の厳密保証には影響しない。 */
  function verifyTsSync(u8) {
    let ok = u8.length > 188 && u8[0] === 0x47;
    if (ok && u8.length >= 376) ok = u8[188] === 0x47;
    if (ok && u8.length >= 564) ok = u8[376] === 0x47;
    return ok;
  }
  const REC_VERIFY_WORKER_SRC = [
    'self.onmessage = function (e) {',
    '  var d = e.data || {};',
    '  var u8 = new Uint8Array(d.buf);',
    '  var ok = u8.length > 188 && u8[0] === 0x47;',
    '  if (ok && u8.length >= 376) ok = u8[188] === 0x47;',
    '  if (ok && u8.length >= 564) ok = u8[376] === 0x47;',
    '  self.postMessage({ id: d.id, ok: ok });',
    '};'
  ].join('\n');
  function createTsVerifier() {
    let worker = null;
    let seq = 0;
    const pending = new Map();
    try {
      worker = RECENV.makeWorker(REC_VERIFY_WORKER_SRC); // v2.0 Step2: RECENV経由(CSP対応)
      if (worker) {
        worker.onmessage = function (e) {
          const d = e.data || {};
          const p = pending.get(d.id);
          if (p) { pending.delete(d.id); p(d.ok === true); }
        };
      }
    } catch (e) { worker = null; }
    return {
      usingWorker: function () { return !!worker; },
      async check(u8) {
        if (worker) {
          const id = ++seq;
          try {
            const copy = u8.slice(); // オリジナルを壊さないため複製をtransfer(ゼロコピー)
            const p = new Promise(function (res) {
              pending.set(id, res);
              setTimeout(function () { if (pending.has(id)) { pending.delete(id); res(null); } }, 3000);
            });
            worker.postMessage({ id: id, buf: copy.buffer }, [copy.buffer]);
            const ok = await p;
            if (ok !== null) return ok;
          } catch (e) { /* Worker失敗 → 同期検証へ */ }
        }
        return verifyTsSync(u8);
      }
    };
  }

  /* ================= v1.10.0: 録画履歴(IndexedDB・最大50件) =================
   セッション要約を停止時に保存し、パネルの「🕘 録画履歴」で一覧表示する。
   保存は本体の録画処理に影響させない(失敗時は黙ってスキップ)。 */
  function idbOpen() {
    return new Promise(function (res, rej) {
      try {
        if (typeof indexedDB === 'undefined') return rej(new Error('no idb'));
        const req = indexedDB.open(HIST_DB, 1);
        req.onupgradeneeded = function () { req.result.createObjectStore(HIST_STORE, { autoIncrement: true }); };
        req.onsuccess = function () { res(req.result); };
        req.onerror = function () { rej(req.error || new Error('idb error')); };
      } catch (e) { rej(e); }
    });
  }
  async function idbAddSession(entry) {
    try {
      const db = await idbOpen();
      await new Promise(function (res, rej) {
        const tx = db.transaction(HIST_STORE, 'readwrite');
        tx.objectStore(HIST_STORE).add(entry);
        tx.oncomplete = res; tx.onerror = rej; tx.onabort = rej;
      });
      db.close();
      return true;
    } catch (e) { return false; }
  }
  async function idbListSessions() {
    try {
      const db = await idbOpen();
      const all = await new Promise(function (res, rej) {
        const tx = db.transaction(HIST_STORE, 'readonly');
        const req = tx.objectStore(HIST_STORE).getAll();
        req.onsuccess = function () { res(req.result || []); };
        req.onerror = rej;
      });
      // 上限超過分(古いもの)を削除 — getAllは挿入順で返る
      let del = all.length - HIST_MAX;
      if (del > 0) {
        await new Promise(function (res) {
          const tx = db.transaction(HIST_STORE, 'readwrite');
          const creq = tx.objectStore(HIST_STORE).openCursor();
          creq.onsuccess = function () {
            const cur = creq.result;
            if (!cur || del <= 0) return;
            cur.delete(); del--; cur.continue();
          };
          tx.oncomplete = res; tx.onerror = res;
        });
      }
      db.close();
      return all;
    } catch (e) { return []; }
  }
  async function idbClearSessions() {
    try {
      const db = await idbOpen();
      await new Promise(function (res) {
        const tx = db.transaction(HIST_STORE, 'readwrite');
        tx.objectStore(HIST_STORE).clear();
        tx.oncomplete = res; tx.onerror = res;
      });
      db.close();
    } catch (e) { /* 不可環境 */ }
  }

  /* ================= v1.10.0: UIテーマ(ダーク既定/ライト追従)と言語 =================
   配色はprefers-color-schemeに追従(data-theme="auto")し、手動設定で上書き可能。
   i18nは静的ラベルのみ(ログ文面は日本語固定 — E2Eと案内の安定性のため)。 */
  const RSP_I18N = {
    ja: {
      recStart: '● 録画開始', recStop: '■ 録画停止', save: '💾 保存', follow: '追跡',
      autoRec: 'LIVE後に自動録画', autoStop: 'LIVE後 公式を自動停止',
      reconnect: '再接続', pswitch: 'HLS⇄FLV', fs: '全画面', off: '公式停止',
      details: '詳細設定(URL上書き/録画オプション)', split: '録画分割(分)',
      flv: 'FLV代替', backlog: 'バックログ取得', infoJson: '録画情報JSON', rfcExtinf: 'RFC 8216厳格',
      csv: '統計CSV', notify: '🔔通知', bestQ: '⤒ 最高画質', audioRec: '⤓ 音声トラックも録画', folder: '📁 保存先:未設定',
      history: '🕘 録画履歴', histClear: '消去', resume: '⏵ 録画を復帰', drop: '破棄',
      schedScan: '📡 予約を確認', apply: '適用', playq: '画質:自動', playqBest: '画質:最高',
      discScan: '🔍 全走査', discRefresh: '↻ 更新', discAuto: '自動更新',
      discEmpty: 'ライブ中の配信がありません — 「🔍 全走査」で公式一覧から探索します',
      discFoot: '公開APIのみ使用(認証回避なし)。カードをクリックで配信ページを新規タブで開きます',
      discSrc: '探索ソース(componentOid,カンマ区切り)', discReady: '準備完了 — 「🔍 全走査」で探索',
      discScanning: '走査中…', discCooldown: '退避中(あと%S秒)', discAuthed: '自分の会話の一覧APIを使用'
    },
    en: {
      recStart: '● Record', recStop: '■ Stop', save: '💾 Save', follow: 'Track',
      autoRec: 'Auto-record on LIVE', autoStop: 'Stop official after LIVE',
      reconnect: 'Reconnect', pswitch: 'HLS⇄FLV', fs: 'Fullscreen', off: 'Stop official',
      details: 'Advanced (URL override / record options)', split: 'Split (min)',
      flv: 'FLV fallback', backlog: 'Backlog fetch', infoJson: 'Info JSON', rfcExtinf: 'RFC 8216 strict',
      csv: 'Stats CSV', notify: '🔔 Notify', bestQ: '⤒ Best quality', audioRec: '⤓ Record audio track', folder: '📁 Save folder: unset',
      history: '🕘 History', histClear: 'Clear', resume: '⏵ Resume recording', drop: 'Discard',
      schedScan: '📡 Check schedules', apply: 'Apply', playq: 'Quality:Auto', playqBest: 'Quality:Best',
      discScan: '🔍 Full scan', discRefresh: '↻ Refresh', discAuto: 'Auto refresh',
      discEmpty: 'No live streams — run "🔍 Full scan" to discover from official lists',
      discFoot: 'Public API only (no auth bypass). Click a card to open the live page in a new tab',
      discSrc: 'Sources (componentOid, CSV)', discReady: 'Ready — run "🔍 Full scan"',
      discScanning: 'Scanning…', discCooldown: 'Cooling down (%Ss)', discAuthed: 'Using your own session list'
    }
  };
  function rspLang() {
    try { const v = localStorage.getItem('rsp_lang'); if (v === 'en' || v === 'ja') return v; } catch (e) {}
    return 'ja';
  }
  function rspTheme() {
    try { const v = localStorage.getItem('rsp_theme'); if (v === 'light' || v === 'dark' || v === 'auto') return v; } catch (e) {}
    return 'auto';
  }

  const REC_TICK_WORKER_SRC = [
    'var t = null;',
    'onmessage = function (e) {',
    '  if (e.data && e.data.cmd === "start") {',
    '    if (t) clearInterval(t);',
    '    t = setInterval(function () { postMessage({ tick: Date.now() }); }, e.data.ms || 3000);',
    '  } else if (e.data && e.data.cmd === "stop") {',
    '    if (t) { clearInterval(t); t = null; }',
    '  }',
    '};'
  ].join('\n');

  function createTicker(ms, onTick) {
    let worker = null;
    let timer = null;
    try {
      worker = RECENV.makeWorker(REC_TICK_WORKER_SRC); // v2.0 Step2: RECENV経由(CSP対応)
      if (worker) {
        worker.onmessage = function (e) { if (e.data && e.data.tick) onTick(); };
        worker.postMessage({ cmd: 'start', ms: ms });
      }
    } catch (e) { worker = null; }
    if (!worker) timer = setInterval(onTick, ms); // フォールバック(背景タブでは間欠化の可能性)
    return {
      stop: function () {
        if (worker) { try { worker.postMessage({ cmd: 'stop' }); worker.terminate(); } catch (e2) {} worker = null; }
        if (timer) { clearInterval(timer); timer = null; }
      },
      usingWorker: function () { return !!worker; }
    };
  }

  function u8Concat(a, b) {
    const out = new Uint8Array(a.length + b.length);
    out.set(a, 0); out.set(b, a.length);
    return out;
  }
  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function stampNow() {
    const d = new Date();
    return '' + d.getFullYear() + pad2(d.getMonth() + 1) + pad2(d.getDate()) + '-' +
      pad2(d.getHours()) + pad2(d.getMinutes()) + pad2(d.getSeconds());
  }
  function fmtDur(ms) {
    const s = Math.max(0, Math.floor(ms / 1000));
    return pad2(Math.floor(s / 3600)) + ':' + pad2(Math.floor((s % 3600) / 60)) + ':' + pad2(s % 60);
  }
  function safeName(s) {
    const t = String(s || '').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '').replace(/\s+/g, '_');
    return t.slice(0, 40) || 'live';
  }

  /* v1.6.0: 永続化した録画セッションの読み出し(同一配信ID・TTL以内のみ有効) */
  function loadSavedSession(id) {
    try {
      const s = JSON.parse(RECENV.storageGet(REC_SESSION_KEY) || 'null');
      if(s && Object.prototype.hasOwnProperty.call(s,'memberPlaylist')){delete s.memberPlaylist;RECENV.storageSet(REC_SESSION_KEY,JSON.stringify(s));}
      if (s && (s.v === 1 || s.v === 2) && s.id === id && Date.now() - (s.updatedAt || 0) < REC_SESSION_TTL_MS) return s;
    } catch (e) {}
    return null;
  }

  // Ordinary HLS only (RFC 8216 §6.3.4); not an LL-HLS blocking reload policy.
  function recHlsReloadMs(target,changed,jitter=Math.random()*0.1) {
    const td=Number.isFinite(target)&&target>0?target:9;
    const j=Number.isFinite(jitter)?Math.max(0,Math.min(0.1,jitter)):0;
    return Math.ceil(td*1000*(changed?1:0.5)*(1+j));
  }
/* HLS descriptor parsing and bounded HTTP transport. No key retrieval (key bytes are
   caller-supplied). v2.37.0(N-01): software AES-128-CBC decryption primitive adapted from
   cat-catch lib/m3u8-decrypt.js (hls.js AESDecryptor lineage) for environments where
   WebCrypto is unavailable or rejects the operation. v2.37.0(N-03): TS packet
   continuity-counter audit (ISO/IEC 13818-1 2.4.3.2) — the packet-level knowledge behind
   cat-catch/hls.js parseTs cc grouping, exposed as non-destructive quality evidence. */
(function(root,factory){const api=Object.freeze(factory());if(typeof module!=='undefined'&&module.exports)module.exports=api;root.RspHlsTransport=api;})(typeof globalThis==='undefined'?this:globalThis,function(){
'use strict';
const fail=code=>{throw Error(code);},uint=s=>{if(!/^\d+$/.test(s))fail('HLS_BAD_INTEGER');const n=Number(s);if(!Number.isSafeInteger(n))fail('HLS_BAD_INTEGER');return n;};
const URI_CACHE_MAX=4096; // v2.5.0: generation-recovery URI identity cache bound
// v2.42.3: bounded, URL-free recording acceptance audit (not disk/fsync or AV decode proof).
// Never retain playlist/segment URLs, request headers, cookies, or segment byte arrays.
const LEDGER_TAIL_LIMIT=96;
function audit(owner){
 if(!owner._hlsWriteAudit)owner._hlsWriteAudit={schema:1,provenance:'writer_acceptance_not_file_commit',scope:'recording_instance',
  queued:0,accepted:0,acceptedMediaBytes:0,acceptedInitBytes:0,terminal:0,
  suspectedManifestMissing:0,declaredGaps:0,backlogSkipped:0,sequenceDiscontinuities:0,
  suspectedAcceptedSequenceGaps:0,unresolved:0,tail:[],last:null};
 return owner._hlsWriteAudit;
}
function stamp(item){
 const d=item&&item.hls;
 if(!d||![d.epoch,d.discontinuity,d.sequence].every(Number.isSafeInteger))return null;
 return {epoch:d.epoch,discontinuity:d.discontinuity,sequence:d.sequence};
}
function pushAudit(a,status,item,mediaBytes=0){
 const v=stamp(item);
 if(!v)return;
 a.tail.push({...v,status,...(status==='accepted'?{mediaBytes}: {})});
 if(a.tail.length>LEDGER_TAIL_LIMIT)a.tail.shift();
}
function noteQueue(owner,items,missing=0,declaredGaps=0,backlogSkipped=0){
 const a=audit(owner);a.queued+=items.length;
 a.suspectedManifestMissing+=Math.max(0,missing-declaredGaps);
 a.declaredGaps+=declaredGaps;
 a.backlogSkipped+=backlogSkipped;
 a.unresolved+=items.length;
 for(const item of items)pushAudit(a,'queued',item);
}
function freshPartAudit(){
 return {segments:0,mediaBytes:0,initBytes:0,firstSequence:null,lastSequence:null,
  firstEpoch:null,lastEpoch:null,firstDiscontinuity:null,lastDiscontinuity:null,
  sequenceGaps:0,discontinuities:0,prev:null};
}
function startPartAudit(owner){
 if(!owner||typeof owner!=='object')return null;
 owner._hlsPartAudit=freshPartAudit();
 return owner._hlsPartAudit;
}
function takePartAudit(owner){
 if(!owner||typeof owner!=='object')return null;
 const pa=owner._hlsPartAudit;
 owner._hlsPartAudit=null;
 if(!pa)return null;
 return {segments:pa.segments,mediaBytes:pa.mediaBytes,initBytes:pa.initBytes,
  firstSequence:pa.firstSequence,lastSequence:pa.lastSequence,
  firstEpoch:pa.firstEpoch,lastEpoch:pa.lastEpoch,
  firstDiscontinuity:pa.firstDiscontinuity,lastDiscontinuity:pa.lastDiscontinuity,
  sequenceGaps:pa.sequenceGaps,discontinuities:pa.discontinuities};
}
function noteAccepted(owner,item,mediaBytes,initBytes){
 if(!item||!item.hls)return;
 const a=audit(owner),v=stamp(item);
 if(!v)return;
 if(a.last&&a.last.epoch===v.epoch&&a.last.discontinuity===v.discontinuity&&v.sequence>a.last.sequence+1)
  a.suspectedAcceptedSequenceGaps+=v.sequence-a.last.sequence-1;
 if(a.last&&(a.last.epoch!==v.epoch||a.last.discontinuity!==v.discontinuity))a.sequenceDiscontinuities++;
 a.last=v;
 a.accepted++;a.unresolved=Math.max(0,a.unresolved-1);
 a.acceptedMediaBytes+=mediaBytes;a.acceptedInitBytes+=initBytes;
 pushAudit(a,'accepted',item,mediaBytes);
 const pa=owner._hlsPartAudit||(owner._hlsPartAudit=freshPartAudit());
 pa.segments++;pa.mediaBytes+=mediaBytes;pa.initBytes+=initBytes;
 if(pa.firstSequence===null){
  pa.firstSequence=v.sequence;pa.firstEpoch=v.epoch;pa.firstDiscontinuity=v.discontinuity;
 }
 if(pa.prev){
  if(pa.prev.epoch===v.epoch&&pa.prev.discontinuity===v.discontinuity&&v.sequence>pa.prev.sequence+1)
   pa.sequenceGaps+=v.sequence-pa.prev.sequence-1;
  if(pa.prev.epoch!==v.epoch||pa.prev.discontinuity!==v.discontinuity)pa.discontinuities++;
 }
 pa.lastSequence=v.sequence;pa.lastEpoch=v.epoch;pa.lastDiscontinuity=v.discontinuity;
 pa.prev=v;
}
function clearWriteEvidence(owner){owner._hlsWriteAudit=null;owner._hlsPartAudit=null;}
function noteTerminal(owner,item){
 if(!item||!item.hls)return;
 const a=audit(owner);a.terminal++;a.unresolved=Math.max(0,a.unresolved-1);
 pushAudit(a,'terminal',item);
}
function writeEvidence(owner){
 const a=owner&&owner._hlsWriteAudit;
 if(!a)return {schema:1,provenance:'writer_acceptance_not_file_commit',scope:'recording_instance',queued:0,accepted:0,terminal:0,unresolved:0,
  acceptedMediaBytes:0,acceptedInitBytes:0,suspectedManifestMissing:0,declaredGaps:0,
  backlogSkipped:0,sequenceDiscontinuities:0,suspectedAcceptedSequenceGaps:0,
  tail:[],tailLimit:LEDGER_TAIL_LIMIT,truncated:0,fileCommitted:false,avDecoded:false};
 return {schema:1,provenance:a.provenance,scope:a.scope,queued:a.queued,accepted:a.accepted,terminal:a.terminal,
  unresolved:a.unresolved,acceptedMediaBytes:a.acceptedMediaBytes,acceptedInitBytes:a.acceptedInitBytes,
  suspectedManifestMissing:a.suspectedManifestMissing,declaredGaps:a.declaredGaps,
  backlogSkipped:a.backlogSkipped,sequenceDiscontinuities:a.sequenceDiscontinuities,
  suspectedAcceptedSequenceGaps:a.suspectedAcceptedSequenceGaps,tail:a.tail.map(e=>({...e})),
  tailLimit:LEDGER_TAIL_LIMIT,truncated:Math.max(0,a.queued+a.terminal+a.accepted-a.tail.length),
  fileCommitted:false,avDecoded:false};
}
// v2.6.0(P2): LL-HLS safe-side policy — delta playlists (EXT-X-SKIP) reject with a
// dedicated code; PRELOAD-HINT/SERVER-CONTROL etc. are never fetched but counted.
const LLHLS_INDICATOR_TAGS=['#EXT-X-SERVER-CONTROL:','#EXT-X-PRELOAD-HINT:','#EXT-X-RENDITION-REPORT:','#EXT-X-PART:','#EXT-X-PART-INF:'];
const SCTE35_INDICATOR_TAGS=['#EXT-X-CUE-OUT','#EXT-X-CUE-IN','#EXT-X-SCTE35','#EXT-OATCLS-SCTE35','#EXT-X-DATERANGE:'];
const uriKey=d=>d.uri.split('?')[0].split('#')[0]+(d.range?'|'+JSON.stringify(d.range):'');
function attrs(s){const out={};let i=0;while(i<s.length){const m=/^([A-Z0-9-]+)=/.exec(s.slice(i));if(!m||m[1] in out)fail('HLS_BAD_ATTRIBUTES');i+=m[0].length;let value;if(s[i]==='"'){const end=s.indexOf('"',++i);if(end<0)fail('HLS_BAD_ATTRIBUTES');value=s.slice(i,end);i=end+1;}else{const end=s.indexOf(',',i);value=s.slice(i,end<0?s.length:end);i=end<0?s.length:end;}out[m[1]]=value;if(i<s.length){if(s[i++]!==','||i===s.length)fail('HLS_BAD_ATTRIBUTES');}}return out;}
// v2.12.0(C-02): cat-catch "添加get参数" (inheritQuery) — when inheritQuery=true and the
// base playlist URL carries query parameters (e.g. token/key2), append missing query keys
// onto same-origin segment/MAP URLs without overwriting segment-specific query parameters.
function url(raw,base,inheritQuery=false){
 if(typeof raw!=='string'||raw!==raw.trim()||/[\x00-\x1f\x7f]/.test(raw))fail('HLS_BAD_URL');
 const u=new URL(raw,base);
 if(!['http:','https:'].includes(u.protocol)||u.username||u.password)fail('HLS_BAD_URL');
 u.hash='';
 if(inheritQuery){
  try{
   const b=new URL(base);
   if(b.search&&u.origin===b.origin){
    for(const [k,v] of b.searchParams)if(!u.searchParams.has(k))u.searchParams.append(k,v);
   }
  }catch(e){}
 }
 return u.href;
}
function range(raw,previous,uri,map=false){if(raw===null)return null;const m=/^(\d+)(?:@(\d+))?$/.exec(raw);if(!m)fail('HLS_BAD_RANGE');const length=uint(m[1]);if(!length||length>32*1048576)fail('HLS_RANGE_LIMIT');let offset;if(m[2]!==undefined)offset=uint(m[2]);else{if(map||!previous||previous.uri!==uri||!previous.range)fail('HLS_IMPLICIT_RANGE');offset=previous.range.offset+previous.range.length;}if(!Number.isSafeInteger(offset+length-1))fail('HLS_RANGE_LIMIT');return {offset,length};}
function parse(text,base,mode='legacy',inheritQuery=false){
 // v2.5.0: mode='legacy' (default) accepts a segment URI without EXTINF as a
 // diagnostic (pre-v2.5 input compatibility); mode='rfc' rejects it
 // (RFC 8216 4.3.2.1 EXTINF is REQUIRED for every media segment).
 // v2.12.0(C-02): inheritQuery=true appends base playlist query params to same-origin URIs.
 if(typeof text!=='string'||text.length>2*1048576||!/^\uFEFF?#EXTM3U(?:\r?\n|$)/.test(text))fail('HLS_BAD_PLAYLIST');
 let sequence=0,discontinuity=0,target=0,map=null,encrypted=false,pendingRange=null,gap=false,previous=null,pendingDuration=null,pendingClock=null;const segments=[];let endList=false;let seenSeq=false,seenDisc=false,seenTarget=false,seenVersion=false;
 // v2.6.0(P1): fMP4 init-segment (EXT-X-MAP) declaration evidence. A switch splits
 // the part boundary so init segments never mix; a switch without an intervening
 // EXT-X-DISCONTINUITY is counted as a quality-risk indicator (not rejected).
 let mapDecls=0,mapSwitches=0,mapSwitchNoDisc=0,discSinceSeg=true,llhlsTags=0,scte35Tags=0,queryInherited=0;
 for(const raw of text.replace(/^\uFEFF/,'').split(/\r?\n/)){const line=raw.trim();if(!line)continue;if(line[0]!=='#'&&raw!==line)fail('HLS_BAD_URL');
  if(line.startsWith('#EXT-X-STREAM-INF:'))fail('HLS_EXPECT_MEDIA');
  if(line.startsWith('#EXT-X-VERSION:')){if(seenVersion)fail('HLS_BAD_VERSION');seenVersion=true;uint(line.slice(15));}
  if(line==='#EXT-X-I-FRAMES-ONLY')fail('HLS_IFRAMES_UNSUPPORTED');
  if(line.startsWith('#EXT-X-SKIP:'))fail('HLS_LLHLS_SKIP'); // v2.6.0(P2): dedicated delta-playlist rejection
  if(LLHLS_INDICATOR_TAGS.some(t=>line.startsWith(t)))llhlsTags++; // v2.6.0(P2): counted, never fetched
  if(SCTE35_INDICATOR_TAGS.some(t=>line.startsWith(t)))scte35Tags++;
  if(line.startsWith('#EXT-X-MEDIA-SEQUENCE:')){if(segments.length||seenSeq)fail('HLS_BAD_SEQUENCE');seenSeq=true;sequence=uint(line.slice(22));}
  else if(line.startsWith('#EXT-X-DISCONTINUITY-SEQUENCE:')){if(segments.length||seenDisc)fail('HLS_BAD_SEQUENCE');seenDisc=true;discontinuity=uint(line.slice(30));}
  else if(line==='#EXT-X-DISCONTINUITY'){discontinuity++;discSinceSeg=true;}
  else if(line.startsWith('#EXT-X-TARGETDURATION:')){if(seenTarget||segments.length)fail('HLS_BAD_TARGET');seenTarget=true;target=uint(line.slice(22));if(!target)fail('HLS_BAD_TARGET');}
  else if(line.startsWith('#EXTINF:')){if(endList||pendingDuration!==null)fail('HLS_BAD_EXTINF');const v=line.slice(8).split(',')[0];if(!/^(?:\d+(?:\.\d+)?|\.\d+)$/.test(v))fail('HLS_BAD_EXTINF');pendingDuration=Number(v);if(!Number.isFinite(pendingDuration)||pendingDuration<=0||pendingDuration>86400)fail('HLS_BAD_EXTINF');}
  else if(line.startsWith('#EXT-X-PROGRAM-DATE-TIME:')){if(endList||pendingClock!==null)fail('HLS_BAD_PROGRAM_DATE_TIME');const v=line.slice(25);if(!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(v))fail('HLS_BAD_PROGRAM_DATE_TIME');const m=/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(?:Z|([+-])(\d{2}):(\d{2}))$/.exec(v);const yr=+m[1],mo=+m[2],day=+m[3],hr=+m[4],mi=+m[5],sec=+m[6];const leap=yr%4===0&&(yr%100!==0||yr%400===0);const lengths=[31,leap?29:28,31,30,31,30,31,31,30,31,30,31];if(yr<1||mo<1||mo>12||day<1||day>lengths[mo-1]||hr>23||mi>59||sec>59||(m[8]!==undefined&&(+m[8]>23||+m[9]>59)))fail('HLS_BAD_PROGRAM_DATE_TIME');pendingClock=Date.parse(v);if(!Number.isSafeInteger(pendingClock))fail('HLS_BAD_PROGRAM_DATE_TIME');}
  else if(line.startsWith('#EXT-X-KEY:')){const a=attrs(line.slice(11));if(!a.METHOD)fail('HLS_BAD_KEY');encrypted=a.METHOD!=='NONE';}
  else if(line.startsWith('#EXT-X-MAP:')){if(encrypted)fail('HLS_ENCRYPTED_UNSUPPORTED');const a=attrs(line.slice(11));if(!a.URI)fail('HLS_BAD_MAP');const plainMap=url(a.URI,base,false),uri=inheritQuery?url(a.URI,base,true):plainMap;if(inheritQuery&&uri!==plainMap)queryInherited++;const newMap={uri,range:range(a.BYTERANGE===undefined?null:a.BYTERANGE,null,uri,true)};mapDecls++;if(map&&JSON.stringify(map)!==JSON.stringify(newMap)){mapSwitches++;if(!discSinceSeg)mapSwitchNoDisc++;}map=newMap;}
  else if(line.startsWith('#EXT-X-BYTERANGE:')){if(pendingRange!==null)fail('HLS_BAD_RANGE');pendingRange=line.slice(17);}
  else if(line==='#EXT-X-GAP')gap=true;
  else if(line==='#EXT-X-ENDLIST'){if(endList)fail('HLS_DUPLICATE_ENDLIST');endList=true;}
  else if(line[0]!=='#'){
   if(endList)fail('HLS_SEGMENT_AFTER_ENDLIST');
   if(encrypted)fail('HLS_ENCRYPTED_UNSUPPORTED');if(segments.length>=4096)fail('HLS_SEGMENT_LIMIT');
   if(mode==='rfc'&&pendingDuration===null)fail('HLS_EXTINF_REQUIRED');
   const plainUri=url(line,base,false),uri=inheritQuery?url(line,base,true):plainUri;if(inheritQuery&&uri!==plainUri)queryInherited++;
   const r=range(pendingRange,previous,uri);const item={uri,range:r,map,gap,sequence:sequence+segments.length,discontinuity,duration:pendingDuration,programDateTimeMs:pendingClock};
   if(!Number.isSafeInteger(item.sequence)||!Number.isSafeInteger(discontinuity))fail('HLS_BAD_INTEGER');segments.push(item);previous=item;pendingRange=null;gap=false;pendingDuration=null;pendingClock=null;discSinceSeg=false;
  }
 }
 if(pendingRange!==null)fail('HLS_DANGLING_RANGE');if(pendingDuration!==null||pendingClock!==null||gap)fail('HLS_DANGLING_TAG');if(!target)fail('HLS_BAD_TARGET');for(const d of segments)if(d.duration!==null&&Math.floor(d.duration+0.5)>target)fail('HLS_DURATION_OVER_TARGET');return {sequence,discontinuity,target,endList,segments,queryInherited,fmp4:{mapDeclarations:mapDecls,mapSwitches,mapSwitchesWithoutDiscontinuity:mapSwitchNoDisc},llhls:{indicatorTags:llhlsTags},scte35:{indicatorTags:scte35Tags}};
}
// Advisory only: manifest wall-clock metadata is never proof of decoded PTS continuity.
function timingEvidence(parsed,toleranceMs=500){
 const result={provenance:'manifest_declared_only',segments:parsed.segments.length,explicitAnchors:0,checkedIntervals:0,suspectedGapIntervals:0,suspectedOverlapIntervals:0,maxAbsDeviationMs:0,unmeasuredIntervals:0,missingExtinf:0,declaredGaps:0,discontinuityBoundaries:0};
 let anchor=null,elapsed=0,complete=false,previousDisc=null;
 for(const d of parsed.segments){
  if(d.duration===null||d.duration===undefined)result.missingExtinf++;
  if(d.gap)result.declaredGaps++;
  if(previousDisc!==null&&previousDisc!==d.discontinuity){result.discontinuityBoundaries++;anchor=null;complete=false;elapsed=0;}
  previousDisc=d.discontinuity;
  if(d.programDateTimeMs!==null&&d.programDateTimeMs!==undefined){
   result.explicitAnchors++;
   if(anchor!==null){if(complete){const delta=d.programDateTimeMs-(anchor+elapsed);result.checkedIntervals++;result.maxAbsDeviationMs=Math.max(result.maxAbsDeviationMs,Math.abs(delta));if(delta>toleranceMs)result.suspectedGapIntervals++;else if(delta< -toleranceMs)result.suspectedOverlapIntervals++;}else result.unmeasuredIntervals++;}
   anchor=d.programDateTimeMs;elapsed=0;complete=true;
  }
  if(anchor!==null){if(d.duration===null||d.duration===undefined)complete=false;else elapsed+=d.duration*1000;}
 }
 return result;
}
const descriptorKey=d=>d?JSON.stringify([d.uri,d.range]):'';
// v2.12.0(W-05): MPEG-TS is a self-synchronizing 188-byte packet stream (PAT/PMT/PCR embedded).
// Unlike fMP4 (which requires EXT-X-MAP init boxes at the start of every part), MPEG-TS
// segments across EXT-X-DISCONTINUITY can be concatenated seamlessly into the same .ts file
// by default (matching Video DownloadHelper / Stream Recorder / Streamlink / yt-dlp / cat-catch).
function partBoundary(d,splitDisc=false){
 if(d&&d.map)return JSON.stringify([d.epoch,d.discontinuity,true,descriptorKey(d.map)]);
 return JSON.stringify(['ts',d?d.epoch:0,splitDisc?(d?d.discontinuity:0):0]);
}
function enqueue(owner,parsed,base){
 // v2.5.0: playlist generation recovery — mirrors the Python core classification
 // (initial/progress/stale/reset/rotation/context) with numeric evidence. A stale
 // re-serve never re-enqueues recorded data; a legitimate reset advances the epoch;
 // an encoder restart reusing sequence numbers is detected as uri rotation.
 const u=new URL(base);const context=u.origin+u.pathname;
 const uris=owner._hlsUris||(owner._hlsUris=new Map());
 const keys=parsed.segments.map(uriKey);
 let knownN=0;for(const k of keys)if(uris.has(k))knownN++;
 const hasFirst=owner._hlsFirst!==undefined;
 const rewind=hasFirst&&parsed.sequence<owner._hlsFirst;
 const sameContext=owner._hlsContext===context;
 let kind='progress';
 if(!hasFirst||owner._hlsContext===undefined)kind='initial';
 else if(!sameContext)kind='context';
 else if(rewind&&keys.length)kind=knownN===keys.length?'stale':'reset';
 let fresh=kind==='initial'||kind==='context'||kind==='reset';
 let epoch=(owner._hlsEpoch||0)+(fresh?1:0);const skip=owner._skipBacklog===true;
 const key=d=>'H:'+epoch+':'+d.discontinuity+':'+d.sequence+':'+JSON.stringify(d.range);
 let unseen=parsed.segments.filter(d=>!owner.seen.has(key(d)));
 if(kind==='progress'&&hasFirst&&sameContext&&!unseen.length&&keys.length&&knownN===0){
  kind='rotation';fresh=true;epoch=(owner._hlsEpoch||0)+1;
  unseen=parsed.segments.filter(d=>!owner.seen.has(key(d)));
 }
 if(uris.size)unseen=unseen.filter(d=>!uris.has(uriKey(d)));
 let incoming=skip?[]:unseen.filter(d=>!d.gap);
 let adFiltered=0;
 const adRe=(owner&&owner._adKeywordRe instanceof RegExp)?owner._adKeywordRe:(owner&&owner.rec&&owner.rec._adKeywordRe instanceof RegExp?owner.rec._adKeywordRe:null);
 if(adRe&&incoming.length){
  const kept=[];
  for(const d of incoming){
   if(adRe.test(d.uri.split("?")[0].split("#")[0]))adFiltered++;
   else kept.push(d);
  }
  incoming=kept;
 }
 const timing=timingEvidence(parsed);
 if(owner.queue.length+incoming.length>4096)fail('HLS_QUEUE_LIMIT');
 let missing=!fresh&&owner._hlsLast!==undefined&&parsed.sequence>owner._hlsLast+1?parsed.sequence-owner._hlsLast-1:0;
 for(const d of unseen){owner.seen.add(key(d));if(d.gap&&!skip)missing++;}
 for(const k of keys)uris.set(k,true);
 while(uris.size>URI_CACHE_MAX)uris.delete(uris.keys().next().value);
 const newItems=incoming.map(d=>({name:d.uri,base:'',tries:0,hls:{...d,epoch}}));
 for(const item of newItems)owner.queue.push(item);
 const declaredGapCount=skip?0:unseen.filter(d=>d.gap).length;
 // Ignore the deliberate backlog skip as a recording failure; keep it separately visible.
 if(newItems.length||missing||skip)noteQueue(owner,newItems,missing,declaredGapCount,skip?unseen.length:0);
 const rec=owner._hlsRecovery||(owner._hlsRecovery={staleResponses:0,suspectedResets:0,sequenceResets:0,uriRotations:0,contextSwitches:0,lastKind:kind,lastSequence:null});
 if(kind==='stale')rec.staleResponses++;
 else if(kind==='reset')rec.sequenceResets++;
 else if(kind==='rotation')rec.uriRotations++;
 else if(kind==='context')rec.contextSwitches++;
 rec.lastKind=kind;rec.lastSequence=keys.length?parsed.sequence:null;
 // v2.6.0(P1/P2): accumulate fMP4 MAP declaration and LL-HLS indicator evidence per context
 const f=parsed.fmp4||{};
 const ev=owner._hlsFmp4||(owner._hlsFmp4={mapDeclarations:0,mapSwitches:0,mapSwitchesWithoutDiscontinuity:0,crossPollMapSwitches:0,crossPollMapSwitchesWithoutDiscontinuity:0});
 ev.mapDeclarations+=f.mapDeclarations||0;ev.mapSwitches+=f.mapSwitches||0;ev.mapSwitchesWithoutDiscontinuity+=f.mapSwitchesWithoutDiscontinuity||0;
 // v2.6.0(P1): cross-poll MAP handoff — the same generation continuing with a changed
 // init segment between polls (the switch is only visible across playlist windows).
 if(kind==='progress'&&parsed.segments.length){
  const mk=parsed.segments[0].map?JSON.stringify(parsed.segments[0].map):null;
  if(mk!==null&&owner._hlsEvMapSig&&mk!==owner._hlsEvMapSig){
   ev.crossPollMapSwitches=(ev.crossPollMapSwitches||0)+1;
   if(parsed.segments[0].discontinuity===owner._hlsEvMapDisc)ev.crossPollMapSwitchesWithoutDiscontinuity=(ev.crossPollMapSwitchesWithoutDiscontinuity||0)+1;
  }
 }
 if(parsed.segments.length){
  const lastSeg=parsed.segments.at(-1);
  owner._hlsEvMapSig=lastSeg.map?JSON.stringify(lastSeg.map):null;
  owner._hlsEvMapDisc=lastSeg.discontinuity;
 }
 owner._hlsLlhlsIndicators=(owner._hlsLlhlsIndicators||0)+((parsed.llhls&&parsed.llhls.indicatorTags)||0);
 owner._hlsScte35Indicators=(owner._hlsScte35Indicators||0)+((parsed.scte35&&parsed.scte35.indicatorTags)||0);
 owner._hlsAdFilteredSegments=(owner._hlsAdFilteredSegments||0)+adFiltered;
 owner._hlsQueryInherited=(owner._hlsQueryInherited||0)+(parsed.queryInherited||0);
 owner._hlsTiming=timing;owner._skipBacklog=false;owner._hlsRecovery=rec;
 owner._hlsContext=context;owner._hlsEpoch=epoch;
 if(kind!=='stale')owner._hlsFirst=parsed.sequence;
 if(parsed.segments.length)owner._hlsLast=fresh?parsed.segments.at(-1).sequence:Math.max(owner._hlsLast??0,parsed.segments.at(-1).sequence);
 if(owner.seen.size>30000){let n=owner.seen.size-12000;for(const k of owner.seen){owner.seen.delete(k);if(--n<=0)break;}}
 return {added:incoming.length,missing,skipped:skip?parsed.segments.length:0};
}
function boxes(bytes){const out=[];let at=0;while(at<bytes.length){if(bytes.length-at<8)fail('HLS_BAD_MP4');const v=new DataView(bytes.buffer,bytes.byteOffset+at,bytes.length-at);let size=v.getUint32(0),header=8;if(size===1){if(bytes.length-at<16)fail('HLS_BAD_MP4');size=v.getUint32(8)*4294967296+v.getUint32(12);header=16;}else if(size===0)size=bytes.length-at;if(!Number.isSafeInteger(size)||size<header||at+size>bytes.length)fail('HLS_BAD_MP4');out.push(String.fromCharCode(...bytes.subarray(at+4,at+8)));at+=size;}return out;}
// v2.12.0(C-01): cat-catch "数据预处理" (TS image/header disguise stripping).
// Strips leading PNG/GIF/BMP/JPEG/WEBP/ID3 headers prepended before valid 188-byte
// MPEG-TS packets (0x47 sync byte on every 188-byte stride). Arbitrary non-disguised
// garbage is NOT stripped so fail-closed HLS_BAD_TS rejection remains intact.
function stripDisguisedTs(bytes){
 if(!bytes||!bytes.length)return {bytes,strippedBytes:0,magic:null};
 let magic=null;
 if(bytes.length>=8&&bytes[0]===0x89&&bytes[1]===0x50&&bytes[2]===0x4E&&bytes[3]===0x47)magic='png';
 else if(bytes.length>=6&&bytes[0]===0x47&&bytes[1]===0x49&&bytes[2]===0x46&&bytes[3]===0x38&&(bytes[4]===0x37||bytes[4]===0x39)&&bytes[5]===0x61)magic='gif';
 else if(bytes.length>=2&&bytes[0]===0x42&&bytes[1]===0x4D)magic='bmp';
 else if(bytes.length>=3&&bytes[0]===0xFF&&bytes[1]===0xD8&&bytes[2]===0xFF)magic='jpeg';
 else if(bytes.length>=12&&bytes[0]===0x52&&bytes[1]===0x49&&bytes[2]===0x46&&bytes[3]===0x46&&bytes[8]===0x57&&bytes[9]===0x45&&bytes[10]===0x42&&bytes[11]===0x50)magic='webp';
 else if(bytes.length>=3&&bytes[0]===0x49&&bytes[1]===0x44&&bytes[2]===0x33)magic='id3';
 if(!magic)return {bytes,strippedBytes:0,magic:null};
 const maxScan=Math.min(bytes.length-188,4096);
 for(let off=1;off<=maxScan;off++){
  if(bytes[off]===0x47&&(bytes.length-off)%188===0){
   let ok=true;
   for(let i=off+188;i<bytes.length;i+=188)if(bytes[i]!==0x47){ok=false;break;}
   if(ok)return {bytes:bytes.subarray(off),strippedBytes:off,magic};
  }
 }
 return {bytes,strippedBytes:0,magic};
}
/* ---------------------------------------------------------------- v2.37.0(N-01): software AES-128-CBC
   cat-catch lib/m3u8-decrypt.js と同一系譜(hls.js AESDecryptor)のテーブル駆動逆暗号。
   WebCrypto(crypto.subtle)が利用不可の環境(非セキュアコンテキスト等)や、WebCryptoが
   OperationErrorで拒否した場合のフォールバックとしてRecorderから呼ばれる。
   AES-CBC復号は仕様上決定的なため、正しい実装はWebCryptoとバイト一致する(NIST SP 800-38A
   KATとWebCryptoクロス検証をtests/test_v2160_core.cjsで常時実施)。 */
const AES_SBOX=new Uint8Array(256),AES_INV_SBOX=new Uint8Array(256),AES_SUB_MIX0=new Uint32Array(256),AES_SUB_MIX1=new Uint32Array(256),AES_SUB_MIX2=new Uint32Array(256),AES_SUB_MIX3=new Uint32Array(256),AES_INV_SUB_MIX0=new Uint32Array(256),AES_INV_SUB_MIX1=new Uint32Array(256),AES_INV_SUB_MIX2=new Uint32Array(256),AES_INV_SUB_MIX3=new Uint32Array(256);
(function initAesTables(){
 const d=new Uint32Array(256);let x=0,xi=0;
 for(let i=0;i<256;i++)d[i]=i<128?i<<1:(i<<1)^0x11b;
 for(let i=0;i<256;i++){
  let sx=xi^(xi<<1)^(xi<<2)^(xi<<3)^(xi<<4);sx=(sx>>>8)^(sx&0xff)^0x63;
  AES_SBOX[x]=sx;AES_INV_SBOX[sx]=x; // cat-catch initTableと同一(インデックスは実行カウンタx・鍵スケジュール展開は前方S-Boxを使用)
  const x2=d[x],x4=d[x2],x8=d[x4];
  let t=(d[sx]*0x101)^(sx*0x1010100);
  AES_SUB_MIX0[x]=(t<<24)|(t>>>8);AES_SUB_MIX1[x]=(t<<16)|(t>>>16);AES_SUB_MIX2[x]=(t<<8)|(t>>>24);AES_SUB_MIX3[x]=t;
  t=(x8*0x1010101)^(x4*0x10001)^(x2*0x101)^(x*0x1010100);
  AES_INV_SUB_MIX0[sx]=(t<<24)|(t>>>8);AES_INV_SUB_MIX1[sx]=(t<<16)|(t>>>16);AES_INV_SUB_MIX2[sx]=(t<<8)|(t>>>24);AES_INV_SUB_MIX3[sx]=t;
  if(!x){x=xi=1;}else{x=x2^d[d[d[x8^x2]]];xi^=d[d[xi]];}
 }
})();
const AES_RCON=[0x00,0x01,0x02,0x04,0x08,0x10,0x20,0x40,0x80,0x1b,0x36];
function aesWords16(b){const v=new DataView(b.buffer,b.byteOffset,b.byteLength);const out=new Uint32Array(4);for(let i=0;i<4;i++)out[i]=v.getUint32(i*4);return out;}
function aesExpandInvKey(key){
 const k=aesWords16(key);const ks=new Uint32Array(44);const iks=new Uint32Array(44);
 for(let i=0;i<4;i++)ks[i]=k[i];
 for(let i=4;i<44;i++){
  let t=ks[i-1];
  if(i%4===0){t=(t<<8)|(t>>>24);t=((AES_SBOX[(t>>>24)&0xff]<<24)|(AES_SBOX[(t>>>16)&0xff]<<16)|(AES_SBOX[(t>>>8)&0xff]<<8)|AES_SBOX[t&0xff])>>>0;t^=AES_RCON[i/4]<<24;}
  ks[i]=(ks[i-4]^t)>>>0;
 }
 for(let r=0;r<44;r++){
  const ksRow=44-r;let t;
  if(r&3)t=ks[ksRow];else t=ks[ksRow-4];
  if(r<4||ksRow<=4)iks[r]=t;
  /* cat-catch/hls.jsの等価逆暗号: invSubMix0[sbox[b]] == InvMixColumns(b) なる合成により、
     ラウンド鍵にはInvMixColumnsのみ適用される(sbox→invSubMixの二段構成)。 */
  else iks[r]=(AES_INV_SUB_MIX0[AES_SBOX[(t>>>24)&0xff]]^AES_INV_SUB_MIX1[AES_SBOX[(t>>>16)&0xff]]^AES_INV_SUB_MIX2[AES_SBOX[(t>>>8)&0xff]]^AES_INV_SUB_MIX3[AES_SBOX[t&0xff]])>>>0;
 }
 return iks;
}
/* PKCS7(RFC 5652 6.3)厳密検証付き除去。WebCryptoは成功時に自動除去するため、
   ソフトウェア経路も同一セマンティクスに揃える(不正パディングはfail-closed)。 */
function removePkcs7Padding(bytes){
 const n=bytes[bytes.length-1];
 if(!n||n>16)fail('HLS_DECRYPT_PADDING');
 for(let i=bytes.length-n;i<bytes.length;i++)if(bytes[i]!==n)fail('HLS_DECRYPT_PADDING');
 return bytes.subarray(0,bytes.length-n);
}
function decryptCbc(key,iv,bytes,opts){
 const removePadding=!opts||opts.padding!==false;
 if(!(key&&key.length===16))fail('HLS_DECRYPT_KEY');
 if(!(iv&&iv.length===16))fail('HLS_DECRYPT_IV');
 if(!bytes||!bytes.length||bytes.length%16)fail('HLS_DECRYPT_BLOCK_SIZE');
 const iks=aesExpandInvKey(key),iV=aesWords16(iv);
 let iV0=iV[0],iV1=iV[1],iV2=iV[2],iV3=iV[3];
 const input=new Int32Array(bytes.buffer,bytes.byteOffset,bytes.length>>2);
 const output=new Int32Array(input.length);
 const swap=w=>(w<<24)|((w&0xff00)<<8)|((w&0xff0000)>>8)|(w>>>24);
 for(let off=0;off<input.length;off+=4){
  let s0=swap(input[off])^iks[0],s1=swap(input[off+3])^iks[1],s2=swap(input[off+2])^iks[2],s3=swap(input[off+1])^iks[3];
  let t0,t1,t2,t3,ksRow=4;
  for(let r=1;r<10;r++){
   t0=AES_INV_SUB_MIX0[s0>>>24]^AES_INV_SUB_MIX1[(s1>>>16)&0xff]^AES_INV_SUB_MIX2[(s2>>>8)&0xff]^AES_INV_SUB_MIX3[s3&0xff]^iks[ksRow];
   t1=AES_INV_SUB_MIX0[s1>>>24]^AES_INV_SUB_MIX1[(s2>>>16)&0xff]^AES_INV_SUB_MIX2[(s3>>>8)&0xff]^AES_INV_SUB_MIX3[s0&0xff]^iks[ksRow+1];
   t2=AES_INV_SUB_MIX0[s2>>>24]^AES_INV_SUB_MIX1[(s3>>>16)&0xff]^AES_INV_SUB_MIX2[(s0>>>8)&0xff]^AES_INV_SUB_MIX3[s1&0xff]^iks[ksRow+2];
   t3=AES_INV_SUB_MIX0[s3>>>24]^AES_INV_SUB_MIX1[(s0>>>16)&0xff]^AES_INV_SUB_MIX2[(s1>>>8)&0xff]^AES_INV_SUB_MIX3[s2&0xff]^iks[ksRow+3];
   s0=t0;s1=t1;s2=t2;s3=t3;ksRow+=4;
  }
  t0=((AES_INV_SBOX[s0>>>24]<<24)^(AES_INV_SBOX[(s1>>>16)&0xff]<<16)^(AES_INV_SBOX[(s2>>>8)&0xff]<<8)^AES_INV_SBOX[s3&0xff])^iks[ksRow];
  t1=((AES_INV_SBOX[s1>>>24]<<24)^(AES_INV_SBOX[(s2>>>16)&0xff]<<16)^(AES_INV_SBOX[(s3>>>8)&0xff]<<8)^AES_INV_SBOX[s0&0xff])^iks[ksRow+1];
  t2=((AES_INV_SBOX[s2>>>24]<<24)^(AES_INV_SBOX[(s3>>>16)&0xff]<<16)^(AES_INV_SBOX[(s0>>>8)&0xff]<<8)^AES_INV_SBOX[s1&0xff])^iks[ksRow+2];
  t3=((AES_INV_SBOX[s3>>>24]<<24)^(AES_INV_SBOX[(s0>>>16)&0xff]<<16)^(AES_INV_SBOX[(s1>>>8)&0xff]<<8)^AES_INV_SBOX[s2&0xff])^iks[ksRow+3];
  output[off]=swap(t0^iV0);output[off+1]=swap(t3^iV1);output[off+2]=swap(t2^iV2);output[off+3]=swap(t1^iV3);
  iV0=swap(input[off]);iV1=swap(input[off+1]);iV2=swap(input[off+2]);iV3=swap(input[off+3]);
 }
 const out=new Uint8Array(output.buffer);
 return removePadding?removePkcs7Padding(out):out;
}
/* ---------------------------------------------------------------- v2.37.0(N-03): TS continuity-counter audit
   ISO/IEC 13818-1 2.4.3.2 の連続性規則をパケット単位で検査する(cat-catch/hls.jsが
   プレイリスト断片のccグループ化に使う知識のパケットレベル適用)。監査のみで非破壊:
   欠落検出(forwardJumps)・重複(duplicates)・逆方向(backwardJumps)・TEIを計数し、
   セグメント廃棄は一切行わない。JS/Python鏡像実装で証拠スキーマは完全一致。 */
function emptyCcAudit(){return {segmentsAudited:0,bytesAudited:0,packets:0,pids:0,payloadPackets:0,noPayloadPackets:0,afcReserved:0,teiPackets:0,continuityOk:0,duplicates:0,forwardJumps:0,backwardJumps:0,lostPacketEstimate:0,maxSingleJump:0,perPid:{},perPidTruncated:false};}
function auditCc(bytes){
 const seg=emptyCcAudit();
 if(!bytes||bytes.length<188||bytes.length%188)return seg;
 seg.packets=bytes.length/188;
 const state={};let distinct=0;
 for(let at=0;at<bytes.length;at+=188){
  const b1=bytes[at+1],b2=bytes[at+2],b3=bytes[at+3];
  const pid=((b1&0x1f)<<8)|b2;
  const afc=(b3>>4)&3,cc=b3&0xf;
  const tei=(b1&0x80)!==0;
  if(tei)seg.teiPackets++;
  let st=state[pid];
  if(!st){st=state[pid]={lastCc:-1,packets:0,payload:0,ok:0,dup:0,fwd:0,back:0,lost:0};distinct++;}
  st.packets++;
  if(afc===0){seg.afcReserved++;continue;}
  if(afc===2){seg.noPayloadPackets++;continue;}
  seg.payloadPackets++;st.payload++;
  if(st.lastCc<0){st.lastCc=cc;continue;}
  const delta=(cc-st.lastCc)&0xf;
  if(delta===1)seg.continuityOk++,st.ok++;
  else if(delta===0)seg.duplicates++,st.dup++;
  else if(delta<8){seg.forwardJumps++;st.fwd++;const lost=delta-1;seg.lostPacketEstimate+=lost;st.lost+=lost;if(lost>seg.maxSingleJump)seg.maxSingleJump=lost;}
  else{seg.backwardJumps++;st.back++;}
  st.lastCc=cc;
 }
 seg.pids=distinct;
 for(const pid in state){const st=state[pid];seg.perPid[pid]={pid:parseInt(pid,10),packets:st.packets,payload:st.payload,ok:st.ok,dup:st.dup,fwd:st.fwd,back:st.back,lost:st.lost};}
 return seg;
}
function mergeCcEvidence(acc,seg){
 acc.segmentsAudited++;acc.bytesAudited+=seg.packets*188;
 for(const k of ['packets','pids','payloadPackets','noPayloadPackets','afcReserved','teiPackets','continuityOk','duplicates','forwardJumps','backwardJumps','lostPacketEstimate'])acc[k]+=seg[k]||0;
 if(seg.maxSingleJump>acc.maxSingleJump)acc.maxSingleJump=seg.maxSingleJump;
 for(const pid in seg.perPid){
  const s=seg.perPid[pid];let dst=acc.perPid[pid];
  if(!dst){dst=acc.perPid[pid]={pid:parseInt(pid,10),packets:0,payload:0,ok:0,dup:0,fwd:0,back:0,lost:0};acc._pidCount=(acc._pidCount||0)+1;}
  for(const k of ['packets','payload','ok','dup','fwd','back','lost'])dst[k]+=s[k]||0;
 }
 return acc;
}
function ccEvidence(acc){
 if(!acc)return undefined;
 const out={segmentsAudited:acc.segmentsAudited,bytesAudited:acc.bytesAudited,packets:acc.packets,pids:acc.pids,payloadPackets:acc.payloadPackets,noPayloadPackets:acc.noPayloadPackets,afcReserved:acc.afcReserved,teiPackets:acc.teiPackets,continuityOk:acc.continuityOk,duplicates:acc.duplicates,forwardJumps:acc.forwardJumps,backwardJumps:acc.backwardJumps,lostPacketEstimate:acc.lostPacketEstimate,maxSingleJump:acc.maxSingleJump,
  perPid:Object.values(acc.perPid).sort((a,b)=>b.packets-a.packets||a.pid-b.pid).slice(0,16).map(e=>({pid:e.pid,packets:e.packets,payload:e.payload,ok:e.ok,dup:e.dup,fwd:e.fwd,back:e.back,lost:e.lost}))};
 out.perPidTruncated=Object.keys(acc.perPid).length>16;
 return out;
}
function validate(bytes,kind){
 if(!bytes||!bytes.length)fail('HLS_EMPTY_BODY');
 if(kind==='ts'){
  if(bytes.length%188||bytes[0]!==0x47){const st=stripDisguisedTs(bytes);if(st.strippedBytes>0)bytes=st.bytes;}
  if(bytes.length%188||bytes[0]!==0x47)fail('HLS_BAD_TS');
  for(let i=188;i<bytes.length;i+=188)if(bytes[i]!==0x47)fail('HLS_BAD_TS');
 }else{
  const b=boxes(bytes);
  if(kind==='init'&&(!b.includes('ftyp')||!b.includes('moov')))fail('HLS_BAD_INIT');
  if(kind==='fragment'&&(!b.includes('moof')||!b.includes('mdat')))fail('HLS_BAD_FRAGMENT');
 }
 return bytes;
}
function createTransfer(fetchImpl=fetch,timeout=15000){
 const pending=new Set();let closed=false;
 return {abort(){closed=true;for(const e of pending)e.abort();},get pending(){return pending.size;},get closed(){return closed;},
  async request(d,limit=32*1048576){
   if(closed)return {status:0,error:'HLS_ABORTED'};
   const controller=new AbortController();let timer,reader,response;let rejectDeadline;
   const deadline=new Promise((_,reject)=>rejectDeadline=reject);
   const entry={abort(){controller.abort();rejectDeadline(Error('HLS_ABORTED'));}};pending.add(entry);
   timer=setTimeout(()=>{controller.abort();rejectDeadline(Error('HLS_TIMEOUT'));},timeout);
   try{
    const operation=(async()=>{
     const headers=d.range?{Range:'bytes='+d.range.offset+'-'+(d.range.offset+d.range.length-1)}:{};
     if(d.butter){if(typeof d.butter!=='string'||/[\r\n]/.test(d.butter))fail('HLS_BAD_AUTH_HEADER');headers.Butter=d.butter;}
     const res=response=await fetchImpl(d.uri,{cache:'no-store',headers,signal:controller.signal});
     if(controller.signal.aborted)fail('HLS_ABORTED');
     if(d.range&&res.status===200)fail('HLS_RANGE_IGNORED');
     if(res.status!==200&&res.status!==206){if(res.body)await res.body.cancel();return {status:res.status,retryAfter:res.headers.get('retry-after')};}
     const encoded=res.headers.get('content-encoding')&&!/^identity$/i.test(res.headers.get('content-encoding'));
     if(d.range&&encoded)fail('HLS_ENCODING_UNSUPPORTED');
     if(!d.range&&res.status===206)fail('HLS_UNEXPECTED_RANGE');
     if(d.range){const m=/^bytes (\d+)-(\d+)\/(\d+|\*)$/.exec(res.headers.get('content-range')||'');if(!m||Number(m[1])!==d.range.offset||Number(m[2])!==d.range.offset+d.range.length-1||(m[3]!=='*'&&Number(m[3])<=Number(m[2])))fail('HLS_CONTENT_RANGE');}
     const cl=encoded?null:res.headers.get('content-length');if(cl!==null&&(!/^\d+$/.test(cl)||Number(cl)>limit))fail('HLS_BODY_LIMIT');
     const chunks=[];let size=0;
     if(!res.body||!res.body.getReader)fail('HLS_STREAM_UNAVAILABLE');reader=res.body.getReader();
     while(true){if(controller.signal.aborted)fail('HLS_ABORTED');const value=await reader.read();if(value.done)break;size+=value.value.byteLength;if(size>limit||(d.range&&size>d.range.length))fail('HLS_BODY_LIMIT');chunks.push(value.value);}
     if(cl!==null&&size!==Number(cl))fail('HLS_BODY_LENGTH');if(d.range&&size!==d.range.length)fail('HLS_RANGE_LENGTH');
     const bytes=new Uint8Array(size);let at=0;for(const chunk of chunks){bytes.set(chunk,at);at+=chunk.byteLength;}return {status:res.status,bytes};
    })();
    return await Promise.race([operation,deadline]);
   }catch(e){controller.abort();return {status:0,error:/^HLS_[A-Z_]+$/.test(e.message)?e.message:'HLS_NETWORK'};}
   finally{clearTimeout(timer);pending.delete(entry);if(reader||response&&response.body)try{const p=reader?reader.cancel():response.body.cancel();if(p&&p.catch)p.catch(()=>{});}catch(e){}}
  }
 };
}
async function fetchItem(owner,item){
 if(!owner._hlsTransfer)owner._hlsTransfer=createTransfer();
 const transfer=owner._hlsTransfer,d=item.hls,generation=owner._hlsGeneration||0;
 let init=null;const mapKey=descriptorKey(d.map);
 if(d.map){
  if(owner._hlsMapKey===mapKey)init=owner._hlsMapBytes;
  else{const r=await transfer.request(d.map,8*1048576);if(r.error||!r.bytes)return r;
   try{init=validate(r.bytes,'init');}catch(e){return {status:0,error:e.message};}
   if(!alive(owner,generation))return {error:'HLS_ABORTED',status:0};
   owner._hlsMapKey=mapKey;owner._hlsMapBytes=init;
  }
 }
 const r=await transfer.request(d);if(r.error||!r.bytes)return r;
 let cleanBytes=r.bytes;
 if(!d.map&&cleanBytes&&(cleanBytes.length%188||cleanBytes[0]!==0x47)){
  const st=stripDisguisedTs(cleanBytes);
  if(st.strippedBytes>0){
   cleanBytes=st.bytes;
   owner._hlsDisguiseStripped=(owner._hlsDisguiseStripped||0)+1;
   owner._hlsDisguiseBytes=(owner._hlsDisguiseBytes||0)+st.strippedBytes;
  }
 }
 try{cleanBytes=validate(cleanBytes,d.map?'fragment':'ts');}catch(e){return {status:0,error:e.message};}
 /* v2.37.0(N-03): TS連続性カウンタ監査(平文TSのみ・監査のみで非破壊)。 */
 if(!d.map&&cleanBytes.length&&cleanBytes.length%188===0&&cleanBytes[0]===0x47){
  try{mergeCcEvidence(owner._hlsCcAudit||(owner._hlsCcAudit=emptyCcAudit()),auditCc(cleanBytes));}catch(e){}
 }
 const splitDisc=!!(owner&&typeof owner.splitOnDiscontinuity==='function'&&owner.splitOnDiscontinuity());
 return {...r,bytes:cleanBytes,init,boundary:partBoundary(d,splitDisc)};
}
function abort(owner){owner._hlsGeneration=(owner._hlsGeneration||0)+1;if(owner._hlsTransfer)owner._hlsTransfer.abort();if(owner._hlsPlaylistTransfer)owner._hlsPlaylistTransfer.abort();}
function reset(owner,keepUris){abort(owner);owner._hlsTransfer=null;owner._hlsPlaylistTransfer=null;owner._hlsMapKey=null;owner._hlsMapBytes=null;owner._hlsContext=null;owner._hlsFirst=undefined;owner._hlsLast=undefined;owner._hlsBoundary=null;owner._hlsLastDiscKey=undefined;owner.mediaFormat='ts';/* v2.5.0: keepUris=true (standby resume) keeps the recorded-path cache so the
   recovering window is not duplicated; a fresh start() clears it intentionally. */
 if(keepUris!==true)owner._hlsUris=null;
 if(owner._hlsWriteAudit)owner._hlsWriteAudit.last=null;}
function alive(owner,generation){return (owner._hlsGeneration||0)===generation&&!owner.stopped&&!(owner.rec&&owner.rec.stopped)&&(!owner.rec||owner.running!==false);}
async function append(owner,item,result,generation=owner._hlsGeneration||0){
 if(!alive(owner,generation))return false;
 if(!item.hls){await owner.pushData(result.data);return alive(owner,generation);}
 const cont=owner._hlsContinuity||(owner._hlsContinuity={discontinuityMergedCount:0,discontinuitySplitCount:0});
 const discKey=item.hls.epoch+':'+item.hls.discontinuity;
 if(owner.partOpen&&owner._hlsLastDiscKey!==undefined&&owner._hlsLastDiscKey!==discKey){
  if(owner._hlsBoundary!==result.boundary)cont.discontinuitySplitCount++;
  else cont.discontinuityMergedCount++;
 }
 owner._hlsLastDiscKey=discKey;
 if(owner.partOpen&&owner._hlsBoundary!==result.boundary){
  const ev=owner._hlsPartBoundaries||(owner._hlsPartBoundaries={hlsBoundary:0});
  ev.hlsBoundary=(ev.hlsBoundary||0)+1;
  await owner.closePart();
 }
 if(!alive(owner,generation))return false;
 owner.mediaFormat=item.hls.map?'mp4':'ts';owner._hlsBoundary=result.boundary;
 const wasPartOpen=!!owner.partOpen;
 if(!owner.partOpen&&result.init)await owner.pushData(result.init);
 if(!alive(owner,generation))return false;
 await owner.pushData(result.data);
 if(!alive(owner,generation))return false;
 // pushData accepted the bytes; a later file write/rename can still fail.
 noteAccepted(owner,item,result.data.byteLength??result.data.length??0,
  !wasPartOpen&&result.init?(result.init.byteLength??result.init.length??0):0);
 return true;
}
function validateWebVtt(text){
 if(typeof text!=='string')fail('WEBVTT_HEADER');
 const clean=text.replace(/^\uFEFF/,'').replace(/\r\n/g,'\n').replace(/\r/g,'\n');
 const blocks=clean.split(/\n{2,}/);
 const header=(blocks[0]||'').trim();
 if(!/^WEBVTT(?:[ \t\n]|$)/.test(header))fail('WEBVTT_HEADER');
 let timestampMap=null;
 for(const line of header.split('\n').slice(1)){
  if(line.startsWith('X-TIMESTAMP-MAP='))timestampMap=line.slice(16).trim();
 }
 const cues=[];
 const timingRe=/^(?:(?:\d{2,}:)?\d{2}:\d{2}\.\d{3})\s+-->\s+(?:(?:\d{2,}:)?\d{2}:\d{2}\.\d{3})(?:[ \t].*)?$/;
 for(let i=1;i<blocks.length;i++){
  const raw=blocks[i].trim();
  if(!raw||raw.startsWith('NOTE')||raw.startsWith('STYLE')||raw.startsWith('REGION'))continue;
  const lines=raw.split('\n');
  let timingIdx=-1,cueId=null;
  if(timingRe.test(lines[0]))timingIdx=0;
  else if(lines.length>=2&&timingRe.test(lines[1])){cueId=lines[0];timingIdx=1;}
  if(timingIdx<0)fail('WEBVTT_BAD_CUE');
  const timing=lines[timingIdx].trim();
  const payload=lines.slice(timingIdx+1).join('\n').trim();
  if(!payload)continue;
  cues.push({id:cueId,timing,payload});
 }
 return {valid:true,timestampMap,cues};
}
function mergeWebVttSegments(segments){
 if(!Array.isArray(segments)||!segments.length)fail('WEBVTT_EMPTY');
 const seen=new Set(),merged=[];
 let duplicatesRemoved=0,timestampMap=null;
 for(const seg of segments){
  const v=validateWebVtt(seg);
  if(timestampMap===null&&v.timestampMap)timestampMap=v.timestampMap;
  for(const cue of v.cues){
   const key=cue.timing+'\n'+cue.payload;
   if(seen.has(key)){duplicatesRemoved++;continue;}
   seen.add(key);
   merged.push(cue);
  }
 }
 const head=timestampMap?'WEBVTT\nX-TIMESTAMP-MAP='+timestampMap:'WEBVTT';
 const body=merged.map(c=>(c.id?c.id+'\n':'')+c.timing+'\n'+c.payload).join('\n\n');
 const text=body?head+'\n\n'+body+'\n':head+'\n';
 return {segmentsProcessed:segments.length,cuesMerged:merged.length,duplicatesRemoved,timestampMap,text};
}
return {parse,enqueue,timingEvidence,attrs,descriptorKey,partBoundary,stripDisguisedTs,validate,createTransfer,fetchItem,append,abort,reset,alive,decryptCbc,removePkcs7Padding,auditCc,mergeCcEvidence,ccEvidence,emptyCcAudit,writeEvidence,noteTerminal,clearWriteEvidence,startPartAudit,takePartAudit,validateWebVtt,mergeWebVttSegments};
});

  const HLS = globalThis.RspHlsTransport;

// Incremental SHA-256 (FIPS 180-4). Independent implementation for local
// integrity checks. Fixed working state; Blob reads are capped at 1 MiB.
(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.RspSha256=api;})(globalThis,function(){
 'use strict';
 const K=new Uint32Array([
  0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
  0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
  0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
  0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
  0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
  0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
  0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
  0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2]);
 const rotr=(x,n)=>(x>>>n)|(x<<(32-n));
 class Sha256 {
  constructor(){this.h=new Uint32Array([0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19]);this.w=new Uint32Array(64);this.buffer=new Uint8Array(64);this.used=0;this.bytes=0;this.finished=false;}
  block(b,off){
   const w=this.w;
   for(let i=0;i<16;i++){const j=off+i*4;w[i]=(b[j]<<24)|(b[j+1]<<16)|(b[j+2]<<8)|b[j+3];}
   for(let i=16;i<64;i++){const x=w[i-15],y=w[i-2];w[i]=(w[i-16]+(rotr(x,7)^rotr(x,18)^(x>>>3))+w[i-7]+(rotr(y,17)^rotr(y,19)^(y>>>10)))>>>0;}
   let [a,b0,c,d,e,f,g,h]=this.h;
   for(let i=0;i<64;i++){
    const t1=(h+(rotr(e,6)^rotr(e,11)^rotr(e,25))+((e&f)^(~e&g))+K[i]+w[i])>>>0;
    const t2=((rotr(a,2)^rotr(a,13)^rotr(a,22))+((a&b0)^(a&c)^(b0&c)))>>>0;
    h=g;g=f;f=e;e=(d+t1)>>>0;d=c;c=b0;b0=a;a=(t1+t2)>>>0;
   }
   const v=[a,b0,c,d,e,f,g,h];for(let i=0;i<8;i++)this.h[i]=(this.h[i]+v[i])>>>0;
  }
  update(data){
   if(this.finished)throw Error('HASH_FINALIZED');
   if(!ArrayBuffer.isView(data)||data.BYTES_PER_ELEMENT!==1)throw Error('HASH_INPUT');
   if(!Number.isSafeInteger(this.bytes+data.byteLength))throw Error('HASH_SIZE');this.bytes+=data.byteLength;
   let at=0;
   if(this.used){const n=Math.min(64-this.used,data.length);this.buffer.set(data.subarray(0,n),this.used);this.used+=n;at=n;if(this.used===64){this.block(this.buffer,0);this.used=0;}}
   while(at+64<=data.length){this.block(data,at);at+=64;}
   if(at<data.length){this.buffer.set(data.subarray(at));this.used=data.length-at;}
   return this;
  }
  digest(){
   if(this.finished)return this.hex;
   const bytes=this.bytes,pad=new Uint8Array(1+((56-(bytes+1)%64+64)%64)+8);pad[0]=128;
   const view=new DataView(pad.buffer);view.setUint32(pad.length-8,Math.floor(bytes/0x20000000),false);view.setUint32(pad.length-4,(bytes*8)>>>0,false);
   this.update(pad);this.finished=true;this.hex=Array.from(this.h,n=>n.toString(16).padStart(8,'0')).join('');return this.hex;
  }
 }
 async function hashBlob(file){
  if(!file||!Number.isSafeInteger(file.size)||file.size<0||typeof file.slice!=='function')throw Error('HASH_BLOB');
  const hash=new Sha256();let n=0;
  for(let at=0;at<file.size;at+=1048576){const end=Math.min(at+1048576,file.size),buf=await file.slice(at,end).arrayBuffer();if(buf.byteLength!==end-at)throw Error('HASH_SHORT_READ');hash.update(new Uint8Array(buf));
   if(++n%8===0&&typeof setTimeout==='function')await new Promise(r=>setTimeout(r,0));
  }
  return hash.digest();
 }
 return {Sha256,hashBlob};
});

  // v2.42.4 per-part audit correlation. Only numerical evidence and local part hashes.
  // Accepted HLS bytes are not proof that a completed media file will decode.
  const rspPartCommit=(function(){'use strict';
    const counters=['queued','accepted','terminal','acceptedMediaBytes','acceptedInitBytes',
      'suspectedManifestMissing','declaredGaps','backlogSkipped',
      'sequenceDiscontinuities','suspectedAcceptedSequenceGaps'];
    function snapshot(owner,transport){
      if(!transport||typeof transport.writeEvidence!=='function')return null;
      const report=transport.writeEvidence(owner),point={schema:1};
      for(const k of counters){const v=report[k];point[k]=Number.isSafeInteger(v)&&v>=0?v:0;}
      return Object.freeze(point);
    }
    function interval(before,after){
      if(!before||!after)return {schema:1,provenance:'no_hls_counter_snapshot',scope:'part_interval',countersAvailable:false,fileCommitted:false,avDecoded:false};
      const delta={};let reset=false;
      for(const k of counters){const a=before[k],b=after[k];
        if(!Number.isSafeInteger(a)||!Number.isSafeInteger(b)||a<0||b<0||b<a){reset=true;break;}
        delta[k]=b-a;
      }
      return reset?{schema:1,provenance:'counter_reset_or_unavailable',scope:'part_interval',countersAvailable:false,fileCommitted:false,avDecoded:false}:
        {schema:1,provenance:'writer_acceptance_counter_interval',scope:'part_interval',countersAvailable:true,
          attribution:'approximate_boundary_snapshot; queued segments can predate part open; acceptance can race part close',
          ...delta,fileCommitted:false,avDecoded:false};
    }
    function normPartSeq(ps){
      if(!ps||typeof ps!=='object')return undefined;
      const nat=v=>Number.isSafeInteger(v)&&v>=0?v:0;
      const optInt=v=>Number.isSafeInteger(v)&&v>=0?v:null;
      return {
        attribution:'exact_pushData_part_binding',
        segments:nat(ps.segments),
        mediaBytes:nat(ps.mediaBytes),
        initBytes:nat(ps.initBytes),
        firstSequence:optInt(ps.firstSequence),
        lastSequence:optInt(ps.lastSequence),
        firstEpoch:optInt(ps.firstEpoch),
        lastEpoch:optInt(ps.lastEpoch),
        firstDiscontinuity:optInt(ps.firstDiscontinuity),
        lastDiscontinuity:optInt(ps.lastDiscontinuity),
        sequenceGaps:nat(ps.sequenceGaps),
        discontinuities:nat(ps.discontinuities)
      };
    }
    function correlate(entry,from,to,result,track,partSeq){
      const counters=interval(from,to),confirmed=!!(result&&result.confirmed),stage=result&&result.stage||'unknown';
      const sha=typeof(result&&result.hashHex)==='string'&&/^[a-f0-9]{64}$/.test(result.hashHex)?result.hashHex:null;
      const fileClosed=confirmed&&stage==='FILE_CLOSED';
      const sinkReceipt=confirmed?(fileClosed?'file_closed_and_readback':'browser_reported_complete'):
        stage==='ERROR'?'write_failed':'not_confirmed';
      const ck=result&&result.checkpoint;
      const check=ck&&fileClosed&&ck.status==='complete'&&Number.isSafeInteger(ck.chunks)&&ck.chunks>=0&&
        Number.isSafeInteger(ck.committedBytes)&&ck.committedBytes>=0&&ck.committedBytes===entry.bytes?
        {chunks:ck.chunks,committedBytes:ck.committedBytes,status:'complete',source:'chunk_hash_verified_at_checkpoint'}:undefined;
      const seqRange=normPartSeq(partSeq);
      const proof={schema:1,track:track==='audio'?'audio':'video',
        provenance:'recording_part_writer_receipt_and_counter_interval',
        acceptedHls:counters,sinkReceipt,fileCommitted:fileClosed,
        browserReportedComplete:confirmed&&!fileClosed,sha256:sha,
        sha256Provenance:sha?(fileClosed?'saved_file_readback':'pre_download_blob'):null,
        ...(check?{checkpoint:check}:{}),...(seqRange?{partSequenceRange:seqRange}:{}),avDecoded:false};
      if(entry&&typeof entry==='object')entry.partIntegrity=proof;
      return proof;
    }
    return Object.freeze({snapshot,interval,correlate});
  })();

  /* Shared per-part writer: an asynchronously opened writer belongs only to this part. */
  function recTrackSave(owner, promise) {
    if (!owner._saveJobs) owner._saveJobs = new Set();
    owner._saveJobs.add(promise);
    promise.then(() => owner._saveJobs.delete(promise), () => owner._saveJobs.delete(promise));
    return promise;
  }
  async function recWaitSaves(owner) {
    while (owner._saveJobs && owner._saveJobs.size) await Promise.allSettled([...owner._saveJobs]);
  }
  /* v2.47.0: Sanitize persisted part entries across browser reload/crash resume (zero URLs/secrets, bounded size). */
  function recSanitizePersistedParts(list) {
    if (!Array.isArray(list)) return [];
    const out = [];
    for (const raw of list.slice(-128)) {
      if (!raw || typeof raw !== "object") continue;
      const file = typeof raw.file === "string" ? raw.file.slice(0, 260) : "";
      const ext = typeof raw.ext === "string" ? raw.ext.slice(0, 12) : "ts";
      const bytes = Number.isSafeInteger(raw.bytes) && raw.bytes > 0 ? raw.bytes : 0;
      if (!file || !bytes || /^(?:https?|wss?|blob|data):/i.test(file) || /[\\/]/.test(file)) continue;
      const entry = {
        file,
        ext,
        bytes,
        segments: Number.isSafeInteger(raw.segments) && raw.segments >= 0 ? raw.segments : 0,
        startedAt: typeof raw.startedAt === "string" ? raw.startedAt.slice(0, 40) : "",
        endedAt: typeof raw.endedAt === "string" ? raw.endedAt.slice(0, 40) : "",
        saveState: typeof raw.saveState === "string" ? raw.saveState.slice(0, 32) : "FILE_CLOSED",
        hashState: typeof raw.hashState === "string" ? raw.hashState.slice(0, 32) : "unavailable",
        structureValidated: !!raw.structureValidated,
        resumedFromPriorRun: true
      };
      if (raw.kind === "audio") entry.kind = "audio";
      if (typeof raw.sha256 === "string" && /^[0-9a-f]{64}$/i.test(raw.sha256)) entry.sha256 = raw.sha256.toLowerCase();
      if (typeof raw.ledgerStatus === "string") entry.ledgerStatus = raw.ledgerStatus.slice(0, 32);
      if (Array.isArray(raw.stages)) entry.stages = raw.stages.slice(0, 16);
      if (raw.partIntegrity && typeof raw.partIntegrity === "object") entry.partIntegrity = raw.partIntegrity;
      out.push(entry);
    }
    return out;
  }
  // Recovery uses committed chunks alongside the final writer. Only a journal
  // closed after verified chunks advertises recoverable bytes. No remote URLs.
  class RecCheckpointStore {
    constructor(directory,name,ext,options={}) {
      this.name=name;this.ext=ext;this.parts=[];this.bytes=0;this.pending=0;this.writer=null;
      this.limit=options.checkpointBytes||64*1048576;this.interval=options.checkpointMs||30000;this.last=Date.now();
      this.ready=directory.getDirectoryHandle('rsp-recovery',{create:true}).then(d=>d.getDirectoryHandle(name+'.checkpoint',{create:true}));
      // ready is awaited by write/finish; attach a handler for early open failure.
      this.ready.catch(()=>{});
    }
    async write(data) {
      const dir=await this.ready;
      if(!this.writer){this.current='chunk-'+String(this.parts.length+1).padStart(8,'0')+'.bin';this.handle=await dir.getFileHandle(this.current,{create:true});this.writer=await this.handle.createWritable();this.chunkHash=new RspSha256.Sha256();}
      await this.writer.write(data);this.chunkHash.update(data);this.pending+=data.byteLength;
      if(this.pending>=this.limit||Date.now()-this.last>=this.interval)await this.checkpoint();
    }
    async journal(status) {
      const dir=await this.ready;const h=await dir.getFileHandle('journal.json',{create:true});const w=await h.createWritable();
      try{await w.write(JSON.stringify({schema:2,file:this.name,ext:this.ext,status,committedBytes:this.bytes,parts:this.parts,updatedAt:new Date().toISOString()}));await w.close();}
      catch(e){try{await w.abort();}catch(ignore){}throw e;}
    }
    async checkpoint() {
      if(!this.writer||!this.pending)return;
      await this.writer.close();this.writer=null;
      const file=await this.handle.getFile();if(file.size!==this.pending)throw Error('CHECKPOINT_SIZE_MISMATCH');
      const sha256=await RspSha256.hashBlob(file);
      if(sha256!==this.chunkHash.digest())throw Error('CHECKPOINT_HASH_MISMATCH');
      this.parts.push({file:this.current,bytes:this.pending,sha256});this.bytes+=this.pending;this.pending=0;
      if(this.parts.length>4096)throw Error('CHECKPOINT_PART_LIMIT');
      await this.journal('active');this.last=Date.now();
    }
    async finish(){await this.checkpoint();}
    async complete(){await this.journal('complete');}
    async abort(){if(this.writer)try{await this.writer.abort();}catch(ignore){}this.writer=null;}
  }
  class RecPartSink {
    constructor(name, directory, ext, options={}) {
      const suffix = typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID().replace(/-/g,'') : Date.now().toString(36)+Math.random().toString(36).slice(2);
      this.name = name.replace(/(\.[^.]+)$/, '_'+suffix+'$1');
      this.ext = ext; this.bytes = 0; this.chunks = []; this.writer = null; this.error = null; this.closed = false;
      this.checkpoints=directory && typeof directory.getDirectoryHandle==='function' && ['ts','mp4'].includes(ext) ? new RecCheckpointStore(directory,this.name,ext,options) : null;
      this.tail = Promise.resolve();
      this.ready = directory ? directory.getFileHandle(this.name, {create:true}).then(fh => {
        this.handle=fh; return fh.createWritable();
      }).then(w => {
        this.writer=w; const chunks=this.chunks;this.chunks=[];for(const chunk of chunks)this.enqueue(chunk);
      }).catch(() => { this.writer=null; }) : Promise.resolve();
    }
    enqueue(chunk) {
      this.tail=this.tail.then(async()=>{if(this.error)return;try{await this.writer.write(chunk);if(this.checkpoints)await this.checkpoints.write(chunk);}catch(e){this.error=e;}});
    }
    push(chunk) {
      if(this.closed)throw Error('PART_CLOSED');
      this.bytes+=chunk.length;
      if(this.writer)this.enqueue(chunk);else this.chunks.push(chunk);
    }
    // Producers await this before fetching another segment; slow disks cannot build
    // an unbounded chain of writes. Open failure keeps the bounded Blob fallback.
    async flush() {
      await this.ready; await this.tail;
      if (this.error) throw Error('PART_WRITE_FAILED');
    }
    continuousDisk() {
      return !!this.writer && !this.error && !this.closed && (this.ext==='ts'||this.ext==='mp4');
    }
    async close() {
      if(this.closed)throw Error('PART_ALREADY_CLOSED');this.closed=true;
      await this.ready;await this.tail;
      if(this.error){try{await this.writer.abort();}catch(e){}if(this.checkpoints)await this.checkpoints.abort();throw Error('PART_WRITE_FAILED');}
      if(this.writer){
        try{if(this.checkpoints)await this.checkpoints.finish();await this.writer.close();const file=await this.handle.getFile();if(file.size!==this.bytes)throw Error('PART_SIZE_MISMATCH');
          if(this.checkpoints)await this.checkpoints.complete();
          /* v2.5.0(P1): 保存確定イベント契約 — HASHED段階の実測値(計算不能時はnullを返し、
             偽のハッシュ段階を記録しない。計算は保存完了後に行い、保存経路を遅らせない) */
          const hashHex=await recSha256Hex(file);
          if(typeof RECENV.backupPart==='function'&&this.bytes>0)try{await RECENV.backupPart(file,this.name,{file:this.name,bytes:this.bytes});}catch(e){}
          return {confirmed:true,stage:'FILE_CLOSED',file:this.name,hashHex,...(this.checkpoints?{checkpoint:{status:'complete',chunks:this.checkpoints.parts.length,committedBytes:this.checkpoints.bytes}}:{})};
        }catch(e){if(this.checkpoints)await this.checkpoints.abort();try{await this.writer.abort();}catch(ignore){}throw Error('PART_CLOSE_FAILED');}
      }
      if(this.bytes===0)return {confirmed:false,stage:'EMPTY',file:this.name};
      const blob=new Blob(this.chunks,{type:this.ext==='flv'?'video/x-flv':(this.ext==='mp4'?'video/mp4':'video/mp2t')});
      const result=await RECENV.download(blob,this.name);
      if(result&&result.confirmed&&typeof RECENV.backupPart==='function')try{await RECENV.backupPart(blob,this.name,{file:this.name,bytes:this.bytes});}catch(e){}
      const hashHex=await recSha256Hex(blob); // v2.5.0(P1): HASHED段階の実測値
      return {file:this.name,confirmed:!!(result&&result.confirmed),stage:result&&result.stage||'DOWNLOAD_REQUESTED',hashHex};
    }
  }
  /* v2.5.0(P2): 診断出力用URL秘匿 — クエリ(署名/key2)とフラグメントを除去し
     origin+pathだけを残す。RAM内の取得経路は変更しない(出力のみの変換)。 */
  function recRedactUrl(u) {
    try {
      const s = String(u || '');
      if (!s) return s;
      const i = s.search(/[?#]/);
      return i < 0 ? s : s.slice(0, i);
    } catch (e) { return String(u || ''); }
  }

  /* v2.5.0(P1): 保存確定イベント契約 — パート台帳の段階記録。
     REQUESTED → FILE_WRITTEN → BROWSER_DONE → HASHED → DECODED/CONTINUITY の順で
     各段階の実測時のみ追記し、段階を飛ばしてSUCCESS扱いにしない。
     (ブラウザー側はDECODED/CONTINUITYをffprobeなしでは達成できないため
     structureValidated=セグメント単位の構造検査証拠として記録し、
     完全デコード監査はCLI --qauditの担当と明示分離する) */
  function recLedgerStage(entry, stage, detail) {
    if (!entry) return;
    if (!entry.stages) entry.stages = [];
    const last = entry.stages[entry.stages.length - 1];
    if (last && last.stage === stage) return; // 同段階の二重追記をしない
    entry.stages.push(Object.assign({ stage: stage, at: new Date().toISOString() }, detail || {}));
  }
  function recLedgerStatus(entry) {
    if (!entry || !entry.stages || !entry.stages.length) return 'unknown';
    if (entry.saveState === 'failed') return 'failed';
    const names = entry.stages.map(function (s) { return s.stage; });
    const confirmed = names.indexOf('BROWSER_DONE') >= 0 || names.indexOf('FILE_WRITTEN') >= 0;
    const hashed = names.indexOf('HASHED') >= 0;
    /* SUCCESSは「適用可能な全段階が実測された」場合のみ。ブラウザーでは
       DECODED/CONTINUITYが適用外のため、 confirmed+hashed を最高到達段階とし
       saveState(検証済み段階)と共に明示する(飛ばし無し) */
    if (entry.saveState === 'failed') return 'failed';
    if (confirmed && hashed && entry.structureValidated) return 'CONFIRMED_HASHED_STRUCTURE';
    if (confirmed && hashed) return 'CONFIRMED_HASHED';
    if (confirmed) return 'CONFIRMED_UNHASHED';
    return 'PENDING_' + entry.saveState;
  }
  /* v2.5.0(P1): パート本体のsha256(crypto.subtle不可環境はnull — 偽らない) */
  async function recSha256Hex(blobOrFile) {
    try { return await RspSha256.hashBlob(blobOrFile); }
    catch(e) { return null; } // A read failure must not become a fake HASHED stage.
  }

  /* v2.6.0(P1/P2): HLSコアが文脈単位で累積した数値証拠(世代復旧・fMP4 MAP宣言・
     LL-HLS指標タグ)を情報JSON用に整形する。証拠が1つも無いときはundefinedを返し
     偽の零を作らない(ブラウザー側はffprobe不在のためDECODED相関はCLI --qaudit担当)。 */
  function recRecoveryEvidence(owner, audioOwner) {
    function recov(o) { return (o && o._hlsRecovery) ? o._hlsRecovery : undefined; }
    function fmp(o) { return (o && o._hlsFmp4) ? o._hlsFmp4 : undefined; }
    function llh(o) { return (o && o._hlsLlhlsIndicators) ? { indicatorTags: o._hlsLlhlsIndicators } : undefined; }
    const v = recov(owner) || fmp(owner) || llh(owner);
    const a = recov(audioOwner) || fmp(audioOwner) || llh(audioOwner);
    if (!v && !a) return undefined;
    return {
      generationRecovery: {
        video: recov(owner), audio: recov(audioOwner),
        provenance: 'manifest_sequence_and_uri_classification'
      },
      fmp4Evidence: {
        video: fmp(owner), audio: fmp(audioOwner),
        provenance: 'manifest_map_declarations',
        note: 'MAP切替はパート境界分割で初期化セグメント混在を防止。DISCONTINUITY無し切替は計数(拒否しない)'
      },
      llhlsEvidence: {
        video: llh(owner), audio: llh(audioOwner),
        policy: 'EXT-X-SKIP(差分playlist)はHLS_LLHLS_SKIPで拒否。PRELOAD-HINT/SERVER-CONTROL等は取得せず計数のみ',
        provenance: 'manifest_tag_counts'
      }
    };
  }

  // A join job contains local file identities only. It is not proof of playback quality.
  function recJoinJob(owner) {
    const parts=owner._joinParts&&owner._joinParts.length?owner._joinParts:(owner.partsLog||[]);
    if(!parts.length)throw Error('JOIN_NO_PARTS');
    return {schema:'rsp.join.v1',tool:'RPLAY Stable Player v2.56.0',
      truncated:!!owner._joinTruncated,
      incomplete:!!((owner.segFails||0)+(owner.gapCount||0)+(owner.failedSaves||0)),
      parts:parts.map(p=>({file:p.file,bytes:p.bytes,...(p.sha256?{sha256:p.sha256}:{})})),
      ...(owner.audio&&owner.audio.partsLog&&owner.audio.partsLog.length?{audioRendition:{parts:owner.audio.partsLog.map(p=>({file:p.file,bytes:p.bytes}))}}:{})};
  }

  /* ================= v1.11.0: AudioRecorder(音声レンディション個別録画) =================
   masterの#EXT-X-MEDIA(TYPE=AUDIO,URI付き)を映像TSとは別のaudio-*.tsへ並行録画する。
   - ポーリング/バックオフのポリシーは映像と同一(TARGETDURATION基準±10%ジッタ・
     403=60秒・429=指数バックオフ最大300秒)だが、カウンタは音声内で独立
   - 要求開始は映像ループから0.3〜0.5秒遅らせ、CDN観測上は1セッションに近似させる
   - 404/410=レンディション欠落とみなし即停止(映像は継続・同URIの自動再開なし)
   - FLV代替へ移行したら即停止(FLVは音声多重のため)。TSへ戻ると再評価する
   - セグメント検証(0x47)/分割(20分/600MB)/テンプレート命名は映像と共通の実装を再利用
   - すべての異常はこのクラス内で吸収し、映像パイプラインへは統計とログ1行のみ通知 */
  async function recFetchDescriptor(owner,item) {
    const REC_TRANSIENT_TRANSFER_ERRORS=['HLS_BODY_LENGTH','HLS_RANGE_LENGTH','HLS_EMPTY_BODY'];
    const generation=owner._hlsGeneration||0;
    const audio=!!owner.rec, clock=owner.rec||owner;
    const wait=REC_REQ_MIN_GAP_MS-(Date.now()-clock._lastReqAt);
    if(wait>0)await new Promise(r=>setTimeout(r,wait));
    if(!HLS.alive(owner,generation))return {};
    clock._lastReqAt=Date.now();item.tries++;
    if(!owner._hlsTransfer)owner._hlsTransfer=HLS.createTransfer(fetch,REC_SEG_TIMEOUT_MS);
    const result=await HLS.fetchItem(owner,item);
    if(!HLS.alive(owner,generation))return {};
    if(result.bytes){
      if(item._cdn404Retries)owner._cdn404Recovered=(owner._cdn404Recovered||0)+1;
      if(item._transientTransferRetries)owner._transientTransferRecovered=(owner._transientTransferRecovered||0)+1;
      return {...result,data:result.bytes};
    }
    if(result.error==='HLS_ABORTED')return {};
    if(result.status===429){
      const count=audio?++owner.c429:++owner.consecutive429;
      const ms=recRetryAfterMs(result.retryAfter)||Math.min(REC_429_BASE_MS*Math.pow(2,count-1),REC_429_MAX_MS);
      owner[audio?'backoffUntil':'segBackoffUntil']=Date.now()+ms;item.tries--;return {retry:true};
    }
    if(result.status===404 && item.tries<3){
      item._cdn404Retries=(item._cdn404Retries||0)+1;owner._cdn404Retries=(owner._cdn404Retries||0)+1;
      owner[audio?'backoffUntil':'segBackoffUntil']=Date.now()+1000;
      owner.log('セグメント404 — CDN反映待ちを最大2回、順序を保って再確認');return {retry:true};
    }
    if(result.status===0 && REC_TRANSIENT_TRANSFER_ERRORS.includes(result.error) && item.tries<3){
      item._transientTransferRetries=(item._transientTransferRetries||0)+1;
      owner._transientTransferRetries=(owner._transientTransferRetries||0)+1;
      owner[audio?'backoffUntil':'segBackoffUntil']=Date.now()+500;
      owner.log('セグメント転送途切れ('+result.error+') — 順序を保って再取得');return {retry:true};
    }
    if(result.status===403)owner[audio?'backoffUntil':'segBackoffUntil']=Date.now()+REC_403_COOLDOWN_MS;
    if(result.status===503){
      const delay=recRetryAfterMs(result.retryAfter);
      if(delay>0)owner[audio?'backoffUntil':'segBackoffUntil']=Date.now()+delay;
    }
    if(result.status===0&&['HLS_NETWORK','HLS_TIMEOUT'].includes(result.error)||result.status>=500)return {retry:true};
    if(result.status===404)owner._cdn404Drops=(owner._cdn404Drops||0)+1;
    if(REC_TRANSIENT_TRANSFER_ERRORS.includes(result.error))owner._transientTransferDrops=(owner._transientTransferDrops||0)+1;
    HLS.noteTerminal(owner,item);owner.segFails++;owner.log('HLSデータを採用せず: '+(result.error||'HTTP '+result.status));return {};
  }

  class AudioRecorder {
    constructor(rec) {
      this.rec = rec;
      this.running = false;
      this.stopReason = '';      // '' | 404 | stall | flv | standby | off | resolve
      this.uri = ''; this.group = ''; this.label = ''; this.channels = ''; this.bw = 0;
      this.deadUri = '';         // 同一URIの自動再開を禁止するための記録(セッション内)
      /* 独立ループ状態 */
      this.seen = new Set();
      this.queue = [];
      this.lastSeq = -1;
      this.targetDur = 0;
      this.lastPollAt = 0; this._playlistBody = null; this._playlistUri = '';
      this.curPollMs = 3000;
      this.backoffUntil = 0;
      this.c429 = 0;
      this.startAt = 0;          // 要求開始許可時刻(オフセット用)
      this.lastNewSegAt = 0;
      this._retryResolve = false;
      this._busy = false;
      /* パート管理(映像と独立・audio-*.ts命名) */
      this.partOpen = false; this.partIndex = 0; this.partName = '';
      this.fileStartedAt = 0;
      this.partsLog = []; this._joinTruncated=false; this._joinParts=[]; this._hlsPartBoundaries={};       // 音声パートの記録(情報JSONのaudioRendition.parts用)
      this.chunks = []; this.bytes = 0; this.bytesTotal = 0; this.writer = null;
      /* 統計 */
      this.segTotal = 0; this.segFails = 0; this.filesSaved = 0; this.saveRequests = 0; this.failedSaves = 0;
      this.stoppedAt = '';
      this.abandonedQueuedOnSourceChange = 0;
      this.abandonedQueuedHistoryComplete = true;
      // v0.15: queued items and a currently worked-on item are different evidence.
      this.activeSegmentAtSourceChange = 0;
      // v0.16: stale completion evidence is separate from missing segments.
      this.staleSegmentResultsIgnored = 0;
      this._inFlightSegmentWork = false;
      this._inFlightSegmentGeneration = null;
    }

    enabled() { return this.rec.recAudio(); }
    log(m) { this.rec.log('[音声] ' + m); }

    /* 新しい配信セッション(追跡再開/復帰)の開始: 最終停止扱いを解除して再挑戦可に */
    onNewSession() {
      this.pause('');
      this.stopReason = ''; this.stoppedAt = '';
      this.deadUri = '';
      this.seen.clear(); this.queue.length = 0;
      this.lastSeq = -1; this.targetDur = 0; this.curPollMs = 3000;
      this.backoffUntil = 0; this.c429 = 0; this._retryResolve = false;
    }

    /* 映像variantの解決/切替に追従して音声源を(再)解決する。
     グループが同一なら音声録画は継続し、URIが変わったら再解決する(設計§3.2) */
    sync(why) {
      if (this.rec.stopped || !this.enabled()) return;
      const preferJapanese = !!(this.rec.preferJapaneseAudio && this.rec.preferJapaneseAudio());
      const g = parseAudioGroups(this.rec._masterTxt || '', this.rec.masterUrl || '', preferJapanese);
      const gid = this.rec.selVariant ? this.rec.selVariant.audioGroup : '';
      const grp = g[gid] || null;
      if (!grp || !grp.uri) {
        if (this.running) {
          this.pause('resolve');
          this.log('音声グループのURIが解決できなくなりました(' + why + ') — 映像のみで録画を継続します');
        }
        return;
      }
      if (this.running && this.uri === grp.uri) {
        // The same URI can be advertised under a new group or label.
        this.group = gid; this.label = grp.name || gid; this.channels = grp.channels || ''; this.bw = grp.bw || 0;
        return;
      }
      if (!this.running && grp.uri === this.deadUri) return; // 欠落済みURIの自動再開はしない
      const wasRun = this.running;
      if (wasRun) this.closePart(); // グループ/URIが変わる → パートを区切る
      this.uri = grp.uri; this.group = gid;
      if (preferJapanese && !grp.preferredMatched) this.log('日本語の別音声が見つからないため、既定・帯域を基準に別音声を選択しました');
      this.label = grp.name || gid; this.channels = grp.channels || ''; this.bw = grp.bw || 0;
      const abandoned = this.queue.length;
      // A shifted segment may still be fetching/writing and is not in queue.
      // This counts operations observed at switching, NOT confirmed missing media.
      const activeAtSwitch = this._inFlightSegmentWork === true &&
        this._inFlightSegmentGeneration === (this._hlsGeneration || 0) ? 1 : 0;
      if (abandoned) {
        const prior = this.abandonedQueuedOnSourceChange === undefined ? 0 : this.abandonedQueuedOnSourceChange;
        if (Number.isSafeInteger(prior) && prior >= 0 && prior <= Number.MAX_SAFE_INTEGER - abandoned) {
          this.abandonedQueuedOnSourceChange = prior + abandoned;
        } else { this.abandonedQueuedHistoryComplete = false; }
        if (typeof HLS.noteTerminal === 'function') for (const item of this.queue) HLS.noteTerminal(this, item);
        this.log('音声源の切替で未処理キュー ' + abandoned + ' 件を破棄しました（欠落の可能性）');
      }
      if (activeAtSwitch) {
        const prior = this.activeSegmentAtSourceChange === undefined ? 0 : this.activeSegmentAtSourceChange;
        if (Number.isSafeInteger(prior) && prior >= 0 && prior < Number.MAX_SAFE_INTEGER) {
          this.activeSegmentAtSourceChange = prior + 1;
        } else { this.abandonedQueuedHistoryComplete = false; }
        this.log('音声源の切替時に処理中の項目を検出しました（成否は不明）');
      }
      HLS.reset(this);this.seen.clear(); this.queue.length = 0; this.lastSeq = -1;
      // The old promise may still settle, but must not be counted in the new generation.
      this._inFlightSegmentWork = false;
      this._inFlightSegmentGeneration = null;
      if ((abandoned || activeAtSwitch) && this.rec && typeof this.rec.persistSession === 'function') this.rec.persistSession();
      this.running = true; this.stopReason = ''; this.stoppedAt = '';
      /* 要求オフセット(0.3〜0.5秒): 映像との同時リクエストを避け1セッションに近似 */
      this.startAt = Date.now() + REC_AUDIO_OFFSET_MS_MIN +
        Math.floor(Math.random() * (REC_AUDIO_OFFSET_MS_MAX - REC_AUDIO_OFFSET_MS_MIN));
      this.lastPollAt = 0; this._playlistBody = null; this._playlistUri = ''; this.backoffUntil = 0; this.c429 = 0;
      this.targetDur = 0; this.curPollMs = 3000; this._retryResolve = false;
      this.lastNewSegAt = Date.now();
      this.log((wasRun ? '音声源を再解決(' + why + ')' : '音声トラックの録画を開始(' + why + ')') + ': ' +
        this.label + (this.channels ? '(' + this.channels + 'ch)' : '') +
        (this.bw ? ' ' + Math.round(this.bw / 1000) + 'kbps' : '') + ' — audio-*.tsとして並行保存');
    }

    /* 再開可能な一時停止(FLV移行/追跡待機/トグルOFF)。パートは確定保存 */
    pause(reason) {
      const was = this.running;
      this.running = false;HLS.abort(this);
      if (reason) this.stopReason = reason;
      if (was && !this.stoppedAt) this.stoppedAt = new Date().toISOString();
      this.closePart();
    }

    /* 最終停止(404/stall): 同一URIの自動再開を禁止 */
    stopFinal(reason, msg) {
      this.pause(reason);
      this.deadUri = this.uri;
      if (msg) this.log(msg);
    }

    /* FLV代替への移行: FLVは映像に音声多重のため音声単独録画の意味が消える */
    onFlvStart() {
      if (this.running) {
        this.pause('flv');
        this.log('FLV代替へ移行 — 音声多重ストリームのため音声個別録画を停止しました(TS復帰時に再評価)');
      }
    }

    /* メインループ(Recorder.tickのRUN/ts時に呼ぶ・非同期で独立・例外は内部吸収) */
    async tick() {
      if (this._busy) return;
      this._busy = true;
      try {
        if (!this.enabled()) { if (this.running) this.pause('off'); return; }
        if (!this.running || this.rec.stopped || this.rec.state !== 'RUN' || this.rec.medium !== 'ts') return;
        const now = Date.now();
        if (now < this.startAt) return; // 要求オフセット(0.3〜0.5秒)
        /* 403後の1回再解決: masterを再取得してからsync(URIが更新されていれば追随) */
        if (this._retryResolve && now >= this.backoffUntil) {
          this._retryResolve = false;
          try {
            if (this.rec.masterUrl) {
              const r = await this.rec.fetchPlaylistOnce(this.rec.masterUrl);
              if (r.status === 200 && r.txt) this.rec._masterTxt = r.txt;
            }
            this.sync('403再解決');
          } catch (e) {}
          return;
        }
        if (now < this.backoffUntil) return; // 403/429バックオフ中(音声のみ)
        if (now - this.lastPollAt >= this.curPollMs) await this.poll(now);
        await this.drain();
        this.checkStall(now);
        this.maybeSplit();
      } catch (e) { /* すべての異常を吸収(映像に影響させない) */ }
      finally { this._busy = false; }
    }

    pollIntervalMs(changed=true) { return recHlsReloadMs(this.targetDur,changed); }

    async poll(now) {
      this.lastPollAt = now;
      const url = this.uri;
      const generation=this._hlsGeneration||0;
      if(!this._hlsPlaylistTransfer)this._hlsPlaylistTransfer=HLS.createTransfer(fetch,REC_API_TIMEOUT_MS);
      const result=await this._hlsPlaylistTransfer.request({uri:url},2*1048576);
      if(!HLS.alive(this,generation))return;
      const status=result.status,txt=result.bytes?new TextDecoder().decode(result.bytes):null,ra=recRetryAfterMs(result.retryAfter);
      if (status === 200 && txt != null) {
        this.c429 = 0;
        this._c404 = 0;
        let parsed,queued;
        try{parsed=HLS.parse(txt,this.uri,(this.rec&&this.rec.extinfMode)?this.rec.extinfMode():'legacy',!!(this.rec&&this.rec.inheritQuery&&this.rec.inheritQuery()));queued=HLS.enqueue(this,parsed,this.uri);}
        catch(e){
          const code=String(e&&e.message||'');
          if(this.segTotal>0&&['HLS_BAD_PLAYLIST','HLS_BAD_TARGET','HLS_DANGLING_TAG','HLS_DANGLING_RANGE','HLS_BAD_EXTINF'].includes(code)){
            this._badPlaylistConsec=(this._badPlaylistConsec||0)+1;
            this._badPlaylistTotal=(this._badPlaylistTotal||0)+1;
            if(this._badPlaylistConsec<=2){
              this.log('音声プレイリスト一時破損('+code+') — 停止せず次回ポーリングで再確認します('+this._badPlaylistConsec+'/2)');
              return;
            }
          }
          this.stopFinal('unsupported','音声HLSを安全に処理できません: '+code);return;
        }
        if(this._badPlaylistConsec>0){this._badPlaylistRecovered=(this._badPlaylistRecovered||0)+1;this._badPlaylistConsec=0;}
        if(parsed.target>0)this.targetDur=parsed.target;
        this.lastSeq=parsed.sequence;this.segFails+=queued.missing;
        if(queued.added)this.lastNewSegAt=Date.now();
        const changed=this._playlistBody!==txt || this._playlistUri!==this.uri;
        this._playlistBody=txt;this._playlistUri=this.uri;
        this.curPollMs = this.pollIntervalMs(changed); // 次の取得間隔(TARGETDURATION基準±ジッタ)
        if (txt.indexOf('ENDLIST') >= 0) {
          // 音声playlistの終端は映像側の終了検出に任せる(ここでは停止しない)
          this.lastNewSegAt = Math.min(this.lastNewSegAt, Date.now() - REC_AUDIO_STALL_MS + 30000);
        }
      } else if (status === 404 || status === 410) {
        if (status === 404 && this.segTotal > 0 && (this._c404 = (this._c404 || 0) + 1) < 2) {
          this.log('音声m3u8が一時404 — CDN更新待ちのため次回ポーリングで再確認します');
          return;
        }
        this.stopFinal('404', '音声m3u8が' + status + ' — レンディション欠落とみなし音声録画を停止(映像は継続・自動再開なし)');
      } else if (status === 403) {
        this.backoffUntil = Date.now() + REC_403_COOLDOWN_MS;
        this._retryResolve = true;
        this.log('音声m3u8が403 — ' + Math.round(REC_403_COOLDOWN_MS / 1000) + '秒待機後に1回再解決を試みます');
      } else if (status === 429) {
        this.c429++;
        const ms = ra || Math.min(REC_429_BASE_MS * Math.pow(2, this.c429 - 1), REC_429_MAX_MS); // v1.12.0: RA優先
        this.backoffUntil = Date.now() + ms;
        this.log('音声m3u8が429 — ' + Math.round(ms / 1000) + '秒待機します(音声のみ・映像は継続)' +
          (ra ? '(Retry-After指定)' : ''));
      }
      // 5xx/0(タイムアウト)は次のポーリングで再試行
    }

    async drain() {
      const rec = this.rec;
      while (this.queue.length && this.running && rec.state === 'RUN' && !rec.stopped) {
        if (Date.now() < this.backoffUntil) return;
        /* 要求間隔の下限はrecFetchDescriptor内で映像と共用(二重待機を排除) */
        const item = this.queue.shift();
        const generation=this._hlsGeneration||0;
        // Keep this true through append; a source change can occur during either await.
        this._inFlightSegmentWork = true;
        this._inFlightSegmentGeneration = generation;
        try {
          const r = await this.fetchSeg(item);
          // A late retry must never be unshifted into the next source's FIFO.
          // Do not interpret a discarded result as a confirmed media loss.
          if ((this._hlsGeneration || 0) !== generation || !this.running) {
            const prior = this.staleSegmentResultsIgnored;
            if (Number.isSafeInteger(prior) && prior >= 0 && prior < Number.MAX_SAFE_INTEGER) {
              this.staleSegmentResultsIgnored = prior + 1;
            } else { this.abandonedQueuedHistoryComplete = false; }
            if (rec && typeof rec.persistSession === 'function') rec.persistSession();
            return;
          }
          if (this.stopped || (this.rec && this.rec.stopped)) return;
          if (r.data) { if(!await HLS.append(this,item,r,generation))return;this.segTotal++;this.segCount++; }
          if (r.retry) {
            if (item.tries < REC_SEG_MAX_TRIES) { this.queue.unshift(item); return; } // 順序厳密
            HLS.noteTerminal(this,item);this.segFails++;
            this.log('音声セグメント取得断念(' + item.tries + '回): ...' + item.name.slice(-28));
          }
        } finally {
          // Do not clear a newer drain's in-flight marker on late settlement.
          if (this._inFlightSegmentGeneration === generation) {
            this._inFlightSegmentWork = false;
            this._inFlightSegmentGeneration = null;
          }
        }
      }
    }

    async fetchSeg(item) { return recFetchDescriptor(this,item); }

    checkStall(now) {
      if (!this.queue.length && now - this.lastNewSegAt > REC_AUDIO_STALL_MS) {
        this.stopFinal('stall', '音声セグメントが' + Math.round(REC_AUDIO_STALL_MS / 1000) +
          '秒間停止 — 音声録画を停止(映像は継続)');
      }
    }

    /* ---- パート入出力(映像と同じ分割/命名/保存インフラを音声用に運用) ---- */
    ensurePart() {
      if (this.partOpen) return;
      const rec = this.rec;
      const _d = new Date();
      /* テンプレートの{quality}にaudioラベルを反映(例: 256k(2ch)_audio) */
      const qCtx = (this.label ? this.label + '_audio' : 'audio');
      this.partExt=this.mediaFormat==='mp4'?'mp4':'ts';
      this.partName = recFileName(rec.nameTpl(), {
        date: '' + _d.getFullYear() + pad2(_d.getMonth() + 1) + pad2(_d.getDate()),
        time: pad2(_d.getHours()) + pad2(_d.getMinutes()) + pad2(_d.getSeconds()),
        creator: rec.creatorName(), title: rec.recTitle(),
        quality: qCtx, part: this.partIndex + 1, ext: this.partExt
      }, 'RPLAY_' + safeName(rec.creatorName()) + '_' + stampNow() + '_audio-p' + (this.partIndex + 1) + '.'+this.partExt);
      this.partOpen = true;
      this.bytes = 0; this.segCount = 0; this.chunks = [];
      this.fileStartedAt = Date.now();
      this._partAuditStart=rspPartCommit.snapshot(this,HLS);
      if(typeof HLS.startPartAudit==='function')HLS.startPartAudit(this);
      this.partIO = new RecPartSink(this.partName, rec.dirHandle, this.partExt);
      this.partName = this.partIO.name;
    }

    async pushData(u8) {
      this.ensurePart();const io=this.partIO;
      io.push(u8);this.bytes+=u8.length;this.bytesTotal+=u8.length;
      try { await io.flush(); }
      catch (e) {
        this.log('ディスク書き込み失敗 — 録画を停止します');
        if(this.rec)this.stopFinal('write_error','音声書き込み失敗');
        else this.stop(false);
        throw e;
      }
    }

    waitForSaves() { return recWaitSaves(this); }
    closePart() {
      if (!this.partOpen) return Promise.resolve();
      this.partOpen=false;
      const io=this.partIO, bytes=this.bytes, ext=this.partExt;
      const auditFrom=this._partAuditStart,auditTo=rspPartCommit.snapshot(this,HLS);this._partAuditStart=null;
      const partSeq=typeof HLS.takePartAudit==='function'?HLS.takePartAudit(this):null;
      const entry={file:this.partName,ext,bytes,segments:this.segCount||0,
        startedAt:new Date(this.fileStartedAt).toISOString(),endedAt:new Date().toISOString(),saveState:'pending',
        structureValidated:(ext==='ts'||ext==='mp4')};
      if (true) entry.kind='audio';
      if(bytes>0){if(!this._joinParts)this._joinParts=[];if(this._joinParts.length<4096)this._joinParts.push(entry);else this._joinTruncated=true;if(this.partsLog.length>=500)this.partsLog.shift();this.partsLog.push(entry);}
      this.partIO=null;this.chunks=[];this.bytes=0;this.segCount=0;this.partIndex++;
      const job=io.close().then(result=>{
        rspPartCommit.correlate(entry,auditFrom,auditTo,result,entry.kind||'video',partSeq);
        entry.saveState=result.stage;
        entry.hashState=result.hashHex?'hashed':'unavailable';
        if(bytes>0&&result.confirmed){this.filesSaved++;if(this.filesByExt)this.filesByExt[ext]=(this.filesByExt[ext]||0)+1;}
        else if(bytes>0)this.saveRequests=(this.saveRequests||0)+1;
        if(bytes>0)this.log((result.confirmed?'ローカル保存確定: ':'DL要求・完了未確認: ')+entry.file);
        if(bytes>0)recLedgerStage(entry,'REQUESTED',{at:new Date(this.fileStartedAt).toISOString(),segments:entry.segments});
        if(bytes>0&&result.confirmed){
          recLedgerStage(entry,'FILE_WRITTEN',{bytes:bytes,sinkStage:result.stage});
          if(result.stage!=='FILE_CLOSED')recLedgerStage(entry,'BROWSER_DONE',{sinkStage:result.stage,bytes:bytes});
        }
        if(bytes>0&&result.hashHex){entry.sha256=result.hashHex;recLedgerStage(entry,'HASHED',{sha256:result.hashHex});}
        if(bytes>0)entry.ledgerStatus=recLedgerStatus(entry);
        if(bytes>0&&this.rec&&typeof this.rec.persistSession==='function')this.rec.persistSession();
        return result;
      }).catch(()=>{rspPartCommit.correlate(entry,auditFrom,auditTo,{stage:'ERROR',confirmed:false},entry.kind||'video',partSeq);entry.saveState='failed';if(bytes>0){recLedgerStage(entry,'REQUESTED',{at:new Date(this.fileStartedAt).toISOString(),segments:entry.segments});entry.ledgerStatus='failed';}this.failedSaves=(this.failedSaves||0)+1;this.log('保存失敗: '+entry.file+' — 元データ/復旧状態を確認してください');});
      return recTrackSave(this,job);
    }

    splitOnDiscontinuity() { return this.rec && this.rec.splitOnDiscontinuity ? this.rec.splitOnDiscontinuity() : false; }
    maybeSplit() {
      if (!this.partOpen) return;
      const minMs = this.rec.splitMinutes() * 60000;
      const cap = (this.rec && this.rec.fileCapBytes) ? this.rec.fileCapBytes() : REC_FILE_CAP_BYTES;
      if ((minMs > 0 && Date.now() - this.fileStartedAt >= minMs) ||
          (!(minMs===0 && this.partIO && typeof this.partIO.continuousDisk==='function' && this.partIO.continuousDisk()) && this.bytes >= (this.partIO && this.partIO.writer ? cap : Math.min(cap,REC_FILE_CAP_BYTES)))) {
        const ev=this._hlsPartBoundaries||(this._hlsPartBoundaries={});const reason=this.bytes>=(this.partIO&&this.partIO.writer?cap:Math.min(cap,REC_FILE_CAP_BYTES))?'sizeLimit':'timeLimit';ev[reason]=(ev[reason]||0)+1;
        this.log('自動分割: ' + (this.bytes / 1048576).toFixed(1) + 'MB を保存(音声' + (this.partIndex + 1) + '本目)');
        this.closePart();
      }
    }

    stats() {
      return {
        enabled: this.enabled(), running: this.running,
        stopReason: this.stopReason || '',
        label: this.label || '', group: this.group || '',
        channels: this.channels || '', bw: this.bw || 0,
        uri: this.uri || '',
        segTotal: this.segTotal, segFails: this.segFails,
        abandonedQueuedOnSourceChange: this.abandonedQueuedOnSourceChange || 0,
        abandonedQueuedHistoryComplete: this.abandonedQueuedHistoryComplete === true,
        activeSegmentAtSourceChange: this.activeSegmentAtSourceChange,
        staleSegmentResultsIgnored: this.staleSegmentResultsIgnored,
        bytes: this.bytesTotal, files: this.filesSaved, saveRequests:this.saveRequests||0, failedSaves:this.failedSaves||0,
        parts: this.partIndex,
        partsLog: this.partsLog.slice(),
        stoppedAt: this.stoppedAt || ''
      };
    }
  }

  class Recorder {
    /* v2.0 Step1: deps注入(録画コアが認証/予約レイヤへ依存する関数を明示化)。
     deps省略時は従来どおりアンビエント関数を使用(後方互換・挙動同一)。
     Step2(offscreen)ではmount()と同じ形状のdepsをホスト側から渡す。 */
    constructor(id, ui, deps) {
      const D = deps || {};
      this._fResolveMember = D.resolveMemberLive || resolveMemberLive;
      this._fResolveSched = D.resolveScheduleInfo || resolveScheduleInfo;
      this._fSchedFor = D.fetchSchedulesFor || fetchSchedulesFor;
      this._fMemberHint = D.memberFailHint || memberFailHint;
      this._fBaseLabel = D.liveBaseLabel || liveBaseLabel;
      this.id = id;
      this.ui = ui;
      this.recording = false;
      this.stopped = true;
      this.state = 'IDLE';            // IDLE | RUN | STANDBY
      this.medium = 'ts';             // ts | flv
      this.apiBase = API_BASE;
      /* パート(保存ファイル)管理 */
      this.partOpen = false;
      this.partIndex = 0;
      this.partName = '';
      this.partExt = 'ts';
      this.chunks = [];               // メモリモードの現パート
      this.bytes = 0;                 // 現パートbyte数
      this.bytesTotal = 0;            // セッション累計byte数
      this.writer = null;             // File System Access の書き込み先
      this.dirHandle = null;
      this.dirLabel = '';
      /* 統計 */
      this.segCount = 0;   // 現パート内セグメント数
      this.segTotal = 0;   // セッション累計
      this.segFails = 0;   // 断念したセグメント(累計)
      this.gapCount = 0;   // ポーリング間隔での取りこぼし疑い
      this.byterangeSkipped = 0; // v1.12.0: BYTERANGE防御で取得不能だったセグメント数
      this.filesSaved = 0; this.saveRequests = 0; this.failedSaves = 0;
      this.filesByExt = { ts: 0, flv: 0 };
      this.startedAt = 0;
      this.fileStartedAt = 0;
      this.standbySince = 0;
      this.resumes = 0;    // 追跡による自動再開回数
      /* プレイリスト監視 */
      this.seen = new Set();
      this.queue = [];
      this.consecutive404 = 0;
      this.lastMediaSeq = -1;
      this._skipBacklog = false;
      this.lastNewSegAt = 0;
      this.pendingEnd = null;
      /* サーバー配慮(v1.4.0): 適応ポーリング/バックオフ/リクエスト間隔 */
      this.targetDur = 0;          // プレイリストのTARGETDURATION
      this.lastPollAt = 0; this._playlistBody = null; this._playlistUri = '';         // 最後にプレイリストを取得した時刻
      this.curPollMs = 3000;       // 現在の取得間隔(ジッタ付き・取得のたびに更新)
      this.lastStandbyAt = 0;      // 最後に追跡探索した時刻
      this.plBackoffUntil = 0;     // プレイリスト403/429時のバックオフ期限
      this.segBackoffUntil = 0;    // セグメント403/429時のバックオフ期限
      this.consecutive429 = 0;
      this.lastDisAnchor = null;   // ディスコンティニュイティ検出用アンカー
      this._lastReqAt = 0;         // 最後のリクエスト開始時刻(間隔下限用)
      this._spd = [];              // 転送速度計算用リング
      this.partsLog = []; this._joinTruncated=false; this._joinParts=[]; this._hlsPartBoundaries={};          // 保存済みパートの記録(情報JSON用)
      /* FLV */
      this.flvAbort = null;
      this.flvRunning = false;
      this.flvGotData = false;
      this.flvLastFail = 0;
      /* フック(外部注入可: 試験やカスタム用) */
      this.getCustomM3u8 = null;
      this.getFlvUrl = null;
      this.getCreatorName = null;
      this.getUrlMode = null;       // v2.40.0: 任意HLS URL録画モード(true=URL録画セッション)
      this.m3u8 = CDN_BASE + id + '.m3u8';
      this.memberPlaylist = '';    // 限定配信(会員限定)のplaylist(key2認証)
      this.accessMode = 'public';  // public | member
      this.liveInfo = null;        // 詮索結果(live/play応答) — Engineと共有
      this.liveM3u8 = '';          // 探查で生きたと確認されたHLS源(abr/IVS含む)
      this.sourceKind = '';        // 採用源: member|custom|abr|legacy|ivs|flv
      this.memberResolveAt = 0;    // 限定解決の最終試行(節流・サーバー配慮)
      this.memberReResolveAt = 0;  // v1.8.0: 限定録画中の鍵更新再解決(90秒節流)
      this.schedItem = null;       // v1.8.0: 配信予約(直近1件) {title, scheduledAt}
      this.schedNotifyAt = 0;      // 予約開始の通知済み時刻(重複通知防止)
      this.schedNotified5 = false; // 5分前通知済み
      this.schedNotified10 = false; // v1.10.0: 10分前リマインド済み
      this.schedLastLog = '';      // 予約カウントダウンの重複ログ防止
      /* v1.10.0: 統計レポート(セッション単位の累積 — 追加の通信は発生しない) */
      this.pollCount = 0;          // プレイリスト取得回数
      this.sourceSwitches = 0;     // HLS源(基盤)切替回数
      this.sourceHistory = [];     // 切替履歴(最大20)
      this.qualityFallbacks = 0;   // 画質フォールバック回数
      this.qualityHistory = [];    // 画質変遷(昇格/フォールバック・最大20)
      this.segIntervalSum = 0;     // セグメント取得間隔の累計(ms)
      this.segIntervalN = 0;       // 間隔サンプル数
      this._lastSegAddedAt = 0;
      this._queueWarnAt = 0;
      this.audioTxt = '';          // 音声レンディション表示(例: 256k(2ch))
      this._verifier = null;       // TS検証(Worker・遅延生成)
      this.verifyChecked = 0;      // 検証済みセグメント数
      this._lastInfo = null;       // 最後に保存した情報JSON(試験フック用)
      this._lastCsv = '';          // 最後に保存した統計CSV(試験フック用)
      this._masterTxt = '';        // 最後に取得したmaster playlist原文(音声解析用)
      this.audio = null;           // v1.11.0: AudioRecorder(音声レンディション個別録画)
      /* v1.9.0: 画質選択(最高画質) */
      this._variantOf = '';        // 解決済みvariant URL(直接ポーリング用)
      this.masterUrl = '';         // master playlistのURL(media playlist源では空)
      this.variants = [];          // 最後に取得したmasterのvariant一覧
      this.selVariant = null;      // 録画中のvariant(画質)
      this.qualityTxt = '';        // UI表示用(例: 1080p60(8.5Mbps))
      this.qualityUpgrades = 0;    // 録画中の画質昇格回数
      this.deadVariants = new Set(); // 消失(404/410)したvariant URL(フォールバック除外)
      this._qUpAt = 0;             // 最終の画質昇格チェック時刻
      this._qUpRunning = false;
      this._qFbAt = 0;             // 最終のvariantフォールバック時刻
      this.ticker = null;
      this.tickN = 0;
      this.busy = false;
      this._unload = null;
      this._titleBase = null;
      this._titleMin = -1;
    }

    /* ---- 設定(UI参照) ---- */
    follow() { return this.ui.followChecked ? !!this.ui.followChecked() : true; }
    flvFallback() { return this.ui.flvFallbackChecked ? !!this.ui.flvFallbackChecked() : true; }
    backlog() { return this.ui.backlogChecked ? !!this.ui.backlogChecked() : true; }
    /* v2.5.0: EXTINF検証モード(P1) — 既定legacy(未宣言を診断計数)、RFC 8216厳格モードは拒否 */
    extinfMode() { try { return (this.ui && this.ui.rfcExtinfChecked && this.ui.rfcExtinfChecked()) ? 'rfc' : 'legacy'; } catch (e) { return 'legacy'; } }
    infoJson() { return this.ui.infoJsonChecked ? !!this.ui.infoJsonChecked() : false; }
    /* v1.9.0: 最高画質での録画(既定ON)。OFF時はプレイリスト先頭variant(サーバー指定順) */
    bestQ() { return this.ui.bestQualityChecked ? !!this.ui.bestQualityChecked() : true; }
    /* v1.11.0: 音声トラックの並行録画(既定OFF — 帯域約1.2〜1.5倍増のため明示ON制) */
    recAudio() { return this.ui.recAudioChecked ? !!this.ui.recAudioChecked() : false; }
    preferJapaneseAudio() { return this.ui && this.ui.preferJapaneseAudioChecked ? !!this.ui.preferJapaneseAudioChecked() : false; }
    /* v1.10.0: 保存ファイル名テンプレート(空=従来命名・後方互換) */
    nameTpl() {
      try { if (this.ui.nameTplValue) return this.ui.nameTplValue() || ''; } catch (e) {}
      return RECENV.storageGet('rsp_name_tpl') || ''; // v2.0 Step1: RECENV経由
      return '';
    }
    /* v1.10.0: 統計CSVの保存(情報JSONと同時に出力) */
    csvOut() { return this.ui.csvChecked ? !!this.ui.csvChecked() : false; }
    /* v1.10.0: 予約リマインドのモード(both|10|5|off) */
    remindMode() {
      try { if (this.ui.remindValue) { const v = this.ui.remindValue(); if (v) return v; } } catch (e) {}
      try { const v = localStorage.getItem('rsp_remind'); if (v) return v; } catch (e) {}
      return 'both';
    }
    /* v1.10.0: 配信タイトル(詮索結果) — ファイル名テンプレートと履歴用 */
    recTitle() {
      try { const t = this.liveInfo && this.liveInfo.title; if (t) return String(t); } catch (e) {}
      return '';
    }
    splitMinutes() { return this.ui && this.ui.splitMinutes ? this.ui.splitMinutes() : 0; }
    splitOnDiscontinuity() { return this.ui && this.ui.splitDiscChecked ? !!this.ui.splitDiscChecked() : false; }
    inheritQuery() { return this.ui && this.ui.inheritQueryChecked ? !!this.ui.inheritQueryChecked() : false; }
    adKeyword() {
      try { if (this.ui && typeof this.ui.adKeywordValue === "function") return String(this.ui.adKeywordValue() || "").trim(); } catch (e) {}
      try { if (typeof RECENV !== "undefined" && RECENV && typeof RECENV.storageGet === "function") return String(RECENV.storageGet("rsp_ad_keyword") || "").trim(); } catch (e) {} return "";
    }
    setAdKeyword(pattern) {
      const clean = String(pattern || "").trim();
      if (!clean) {
        this._adKeyword = "";
        this._adKeywordRe = null;
        return true;
      }
      if (clean.length > 256) throw Error("AD_KEYWORD_TOO_LONG");
      this._adKeywordRe = new RegExp(clean);
      this._adKeyword = clean;
      return true;
    }
    fileCapBytes() { return this.dirHandle ? 2048 * 1048576 : REC_FILE_CAP_BYTES; }
    creatorName() {
      try { const n = this.getCreatorName && this.getCreatorName(); if (n) return n; } catch (e) {}
      return this.id;
    }
    urlMode() { try { return !!(this.getUrlMode && this.getUrlMode()); } catch (e) { return false; } }
    playlistUrl() {
      // 限定配信の解決が済んでいれば最優先(公開URLが403でも確実に録画を継続)
      if (this.memberPlaylist) return this.memberPlaylist;
      const custom = this.getCustomM3u8 ? (this.getCustomM3u8() || '') : '';
      if (custom) return custom;
      // 新旧基盤の多段: 探查で生きた源(liveM3u8)があれば優先、なければ従来源
      if (this.liveM3u8) return this.liveM3u8;
      return rspSourceCandidates(this.liveInfo, this.m3u8)[0] || this.m3u8;
    }
    flvUrl() {
      try { if (this.getFlvUrl) { const u = this.getFlvUrl(); if (u) return u; } } catch (e) {}
      return CDN_BASE + this.id + '_abrhd.flv?creatorId=' + this.id + '&resolution=hd&abr_pts=-800';
    }
    saveTargetLabel() { return this.dirHandle ? 'フォルダ「' + this.dirLabel + '」' : 'ダウンロード'; }

    log(msg) { this.ui.log('[REC] ' + msg); }

    /* ---- 開始 / 停止 ---- */
    start() {
      if (this.recording || this.isDraining) return;
      this.recording = true;
      this.stopped = false;
      HLS.reset(this);HLS.clearWriteEvidence(this);
      this.state = 'RUN';
      this.medium = 'ts';
      this.startedAt = Date.now();
      this.fileStartedAt = Date.now();
      this.lastNewSegAt = Date.now();
      this.partIndex = 0;
      this.resumes = 0;
      this.pendingEnd = null;
      this._skipBacklog = !this.backlog(); // 追跡による再開(resume)では適用しない
      this.resetQualityState(); // v1.9.0: 前回セッションの画質状態を引き継がない
      this.lastPollAt = 0; this._playlistBody = null; this._playlistUri = '';
      this.curPollMs = 3000;
      this.lastStandbyAt = 0;
      this.lastDisAnchor = null;
      this.plBackoffUntil = 0;
      this.segBackoffUntil = 0;
      this.consecutive429 = 0;
      this.partsLog = []; this._joinTruncated=false; this._joinParts=[]; this._hlsPartBoundaries={};
      this._spd = [];
      try { if (!this._adKeywordRe && this.adKeyword()) this.setAdKeyword(this.adKeyword()); } catch (e) { this._adKeywordRe = null; }
      this.resetStatsBlock(); // v1.10.0: セッション統計の初期化(復帰/再開は累積を維持)
      this.audio = new AudioRecorder(this); // v1.11.0: 音声録画(トグルON+URI解決で稼働)
      this.ticker = createTicker(REC_POLL_MS, () => this.tick());
      this.log('録画開始(追跡' + (this.follow() ? 'ON' : 'OFF') +
        (this.follow() && this.flvFallback() ? ' / FLV代替ON' : '') +
        ' / 分割' + (this.splitMinutes() || 'なし') + '分ごと / バックログ' + (this.backlog() ? '取得' : 'スキップ') +
        ' / 画質' + (this.bestQ() ? '最高(自動昇格)' : '先頭(サーバー指定順)') +
        ' / 音声' + (this.recAudio() ? '併録(audio-*.ts)' : 'なし') +
        ' / 保存先: ' + this.saveTargetLabel() +
        ' / タイマー: ' + (this.ticker.usingWorker() ? 'Worker' : '通常') + ')');
      if (this.nameTpl()) this.log('ファイル名テンプレート: ' + this.nameTpl()); // v1.10.0
      this.ui.recState(true, this.state, this.medium);
      const rec = this;
      this._unload = function (e) {
        if (rec.recording && (rec.bytes > 0 || rec.filesSaved > 0)) { e.preventDefault(); e.returnValue = ''; }
      };
      RECENV.onUnload(this._unload); // v2.0 Step1: RECENV経由
      this._titleMin = -1;
      this.updateTitle(true);
      this.persistSession();
    }

    stop(autoSaved) {
      if (!this.recording) return this._stopTask || Promise.resolve();
      this.recording=false;this.stopped=true;this.state='IDLE';this.isDraining=true;HLS.abort(this);
      this.abortFlv();if(this.ticker){this.ticker.stop();this.ticker=null;}
      if(this.audio)this.audio.pause('off');
      if(this._unload){RECENV.offUnload(this._unload);this._unload=null;}
      this.restoreTitle();this.closePart();
      this.ui.recState(false,'DRAINING',this.medium);
      this._stopTask=Promise.all([recWaitSaves(this),this.audio?recWaitSaves(this.audio):Promise.resolve()]).then(async()=>{
        if(this.partsLog.length>1)try{await this.saveJoinJob();}catch(e){this.log('結合リストを保存できませんでした');}
        if(this.infoJson())this.saveInfoJson();this.saveHistory();
        if(!(this.failedSaves||(this.audio&&this.audio.failedSaves)))this.clearSession();
        if(typeof RECENV.sessionEnded==='function'){try{const _p=RECENV.sessionEnded(this);if(_p&&_p.catch)_p.catch(function(){});}catch(e){}}
        this.ui.recState(false,'IDLE',this.medium);
        this.log('録画停止 — ローカル保存'+this.filesSaved+'本 / DL未確認'+(this.saveRequests||0)+'本 / 保存失敗'+(this.failedSaves||0)+'本');
      }).finally(()=>{this.isDraining=false;});
      return this._stopTask;
    }

    toggle() { if (this.recording) this.stop(false); else this.start(); }

    /* ---- v1.6.0: セッション永続化(断点復帰)と通知 ----
     録画状態を約6秒ごとにlocalStorageへ書き、クラッシュ/誤操作でタブを
     失っても、同じ配信ページを開けばワンクリックで録画を引き継げる。
     (メモリ上の未保存チャンクは失われるため、自動分割20分/600MBとの併用
      で最大損失窗を最小化。フォルダ直書きなら即時確定) */
    persistSession() {
      if (!this.recording || this.stopped) return;
      try {
        const cleanParts = typeof recSanitizePersistedParts === 'function'
          ? recSanitizePersistedParts(this.partsLog)
          : [];
        const cleanAudioParts = (this.audio && typeof recSanitizePersistedParts === 'function')
          ? recSanitizePersistedParts(this.audio.partsLog)
          : [];
        const payload = {
          v: 2,
          id: this.id,
          creator: this.creatorName(),
          startedAt: this.startedAt,
          updatedAt: Date.now(),
          state: this.state,             // RUN | STANDBY(追跡待機も引き継ぐ)
          accessMode: this.accessMode,
          segTotal: this.segTotal,
          bytesTotal: this.bytesTotal,
          resumes: this.resumes,
          partIndex: this.partIndex,
          filesSaved: this.filesSaved || 0,
          segFails: this.segFails,
          gapCount: this.gapCount,
          partsLog: cleanParts,
          audioPartsLog: cleanAudioParts,
          audioQueueAbandoned: this.audio && Number.isSafeInteger(this.audio.abandonedQueuedOnSourceChange) && this.audio.abandonedQueuedOnSourceChange >= 0 ? this.audio.abandonedQueuedOnSourceChange : null,
          audioActiveAtSourceChange: this.audio && Number.isSafeInteger(this.audio.activeSegmentAtSourceChange) && this.audio.activeSegmentAtSourceChange >= 0 ? this.audio.activeSegmentAtSourceChange : null,
          audioStaleResultsIgnored: this.audio && Number.isSafeInteger(this.audio.staleSegmentResultsIgnored) && this.audio.staleSegmentResultsIgnored >= 0 ? this.audio.staleSegmentResultsIgnored : null
        };
        let json = JSON.stringify(payload);
        if (json.length > 49152) {
          payload.partsLog = cleanParts.slice(-32);
          payload.audioPartsLog = cleanAudioParts.slice(-16);
          json = JSON.stringify(payload);
        }
        RECENV.storageSet(REC_SESSION_KEY, json);
      } catch (e) {}
    }

    clearSession() {
      RECENV.storageDel(REC_SESSION_KEY); // v2.0 Step1: RECENV経由
    }

    /* v1.10.0: セッション統計の初期化(start時のみ — 復帰/再開は累積を維持) */
    resetStatsBlock() {
      this.pollCount = 0; this.sourceSwitches = 0; this.sourceHistory = [];
      this.qualityFallbacks = 0; this.qualityHistory = [];
      this.segIntervalSum = 0; this.segIntervalN = 0; this._lastSegAddedAt = 0;
      this.verifyChecked = 0;
      this._sessionTracker = { initialStreamStartSec: null, latestStreamStartSec: null, thresholdSec: 600, sameSessionResumes: 0, newSessionSplits: 0, transitions: [] };
      this._errTaxonomy = { SOURCE: 0, NETWORK: 0, AUTH: 0, PLATFORM: 0, COMPATIBILITY: 0, INTERNAL: 0 };
      this._sameSessionStandbyContinuations = 0;
    }
    noteStreamStart(info) {
      if (!info || typeof info !== 'object') return;
      const raw = info.streamStartTime || info.startedAt || null;
      const sec = rspParseStreamStartSec(raw);
      if (sec === null) return;
      if (!this._sessionTracker) this._sessionTracker = { initialStreamStartSec: null, latestStreamStartSec: null, thresholdSec: 600, sameSessionResumes: 0, newSessionSplits: 0, transitions: [] };
      const st = this._sessionTracker;
      if (st.initialStreamStartSec === null) {
        st.initialStreamStartSec = sec;
        st.latestStreamStartSec = sec;
        return;
      }
      const cls = rspClassifySessionChange(st.latestStreamStartSec, sec, st.thresholdSec);
      st.latestStreamStartSec = sec;
      if (cls.changed) {
        if (cls.classification === 'same_session_resumed') { st.sameSessionResumes++; this._sameSessionStandbyContinuations = (this._sameSessionStandbyContinuations || 0) + 1; }
        else if (cls.classification === 'new_session_split') st.newSessionSplits++;
        st.transitions.push({ gapSec: cls.gapSec, classification: cls.classification, at: new Date().toISOString() });
      }
    }
    noteErrKind(kind) {
      if (!this._errTaxonomy) this._errTaxonomy = { SOURCE: 0, NETWORK: 0, AUTH: 0, PLATFORM: 0, COMPATIBILITY: 0, INTERNAL: 0 };
      if (Object.prototype.hasOwnProperty.call(this._errTaxonomy, kind)) this._errTaxonomy[kind]++;
    }
    /* v1.10.0: セッション要約を履歴(IndexedDB)へ保存(失敗は無視 — 本体に影響させない) */
    saveHistory() {
      if (this.segTotal <= 0 && this.bytesTotal <= 0) return;
      const entry = {
        endedAt: new Date().toISOString(),
        creator: this.creatorName(),
        creatorOid: this.id,
        title: this.recTitle(),
        durationMs: Date.now() - this.startedAt,
        bytes: this.bytesTotal,
        segTotal: this.segTotal,
        missing: this.segFails + this.gapCount + (this.byterangeSkipped || 0), // v1.12.0
        files: this.filesSaved, saveRequests:this.saveRequests||0, failedSaves:this.failedSaves||0,
        quality: this.qualityTxt,
        audio: this.audioTxt,
        audioSeg: (this.audio && this.audio.segTotal) || 0, // v1.11.0
        resumes: this.resumes,
        sourceSwitches: this.sourceSwitches,
        sourceKind: this.sourceKind,
        accessMode: this.accessMode
      };
      const self = this;
      idbAddSession(entry).then(function (ok) {
        if (ok) self.log('録画履歴を保存(🕘 録画履歴で一覧表示)');
      });
    }
    /* v1.10.0: 統計ブロック(セッション単位の集計) */
    statsBlock() {
      const total = this.segTotal + this.segFails + this.gapCount + (this.byterangeSkipped || 0); // v1.12.0
      return {
        missingRate: total > 0 ? Math.round(((this.segFails + this.gapCount) / total) * 1000) / 1000 : 0,
        missingSuspect: this.segFails + this.gapCount,
        segmentWriteEvidence: ((typeof HLS.writeEvidence === 'function') ? HLS.writeEvidence(this) : undefined),
        byterangeSkipped: this.byterangeSkipped || 0, // v1.12.0
        reconnects: this.resumes,
        sourceSwitches: this.sourceSwitches,
        sourceHistory: this.sourceHistory.slice(),
        qualityUpgrades: this.qualityUpgrades,
        qualityFallbacks: this.qualityFallbacks,
        qualityHistory: this.qualityHistory.slice(),
        avgSegIntervalMs: this.segIntervalN > 0 ? Math.round(this.segIntervalSum / this.segIntervalN) : 0,
        pollCount: this.pollCount,
        verifiedSegs: this.verifyChecked,
        verifyWorker: this._verifier ? this._verifier.usingWorker() : false,
        files: this.filesSaved, saveRequests:this.saveRequests||0, failedSaves:this.failedSaves||0,
        filesByExt: Object.assign({}, this.filesByExt)
      };
    }
    /* v1.10.0: 統計CSVの保存(情報JSONと同じ内容をCSV行に起こす) */
    saveInfoCsv(info) {
      try {
        const q = function (v) { return '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"'; };
        const rows = [['section', 'key', 'value'].join(',')];
        const s = info.stats || {};
        const add = function (k, v) { rows.push(['summary', k, q(v)].join(',')); };
        add('tool', info.tool); add('creator', info.creator); add('accessMode', info.accessMode);
        add('sourceKind', info.sourceKind); add('durationSec', info.durationSec);
        add('totalBytes', info.totalBytes); add('segments', info.segments);
        add('missingSuspect', s.missingSuspect); add('missingRate', s.missingRate);
        add('reconnects', s.reconnects); add('sourceSwitches', s.sourceSwitches);
        add('qualityUpgrades', s.qualityUpgrades); add('qualityFallbacks', s.qualityFallbacks);
        add('avgSegIntervalMs', s.avgSegIntervalMs); add('pollCount', s.pollCount);
        add('qualitySelected', info.quality ? info.quality.selected : '');
        /* v1.11.0: 音声レンディションの列 */
        const ar = info.audioRendition || null;
        add('audioLabel', info.audio || '');
        add('audioRecorded', ar ? (ar.running ? 'yes' : (ar.segTotal ? 'stopped:' + (ar.stopped || '') : 'no')) : 'no');
        add('audioSegTotal', ar ? ar.segTotal : 0);
        add('audioBytes', ar ? ar.bytes : 0);
        add('audioBandwidth', ar ? (ar.bandwidth || 0) : 0);
        (info.parts || []).forEach(function (p) { rows.push(['part', q(p.file), q(p.bytes)].join(',')); });
        (s.qualityHistory || []).forEach(function (h) { rows.push(['qualityChange', q(h.from + ' -> ' + h.to), q(h.why)].join(',')); });
        (s.sourceHistory || []).forEach(function (h) { rows.push(['sourceChange', q(h.to), q(h.at)].join(',')); });
        const csv = rows.join('\r\n');
        this._lastCsv = csv;
        const name = 'RPLAY_' + safeName(this.creatorName()) + '_' + stampNow() + '_stats.csv';
        RECENV.download(new Blob([csv], { type: 'text/csv' }), name); // v2.0 Step1
        this.log('統計CSVを保存: ' + name);
      } catch (e) { this.log('統計CSVの保存に失敗: ' + (e && e.message || e)); }
    }
    notify(title, body) {
      if (!this.ui.notifyChecked || !this.ui.notifyChecked()) return;
      RECENV.notify(title, body); // v2.0 Step2: 権限確認はRECENV実装側の責務(ページ=Notification権限確認/offscreen=SW中継で権限不要)
    }

    /* クラッシュ/再読み込み前のセッションを引き継いで録画を再開 */
    resumeFromCrash(s) {
      if (this.recording || this.isDraining) return;
      this.recording = true;
      this.stopped = false;
      HLS.reset(this);HLS.clearWriteEvidence(this);
      this.state = (s.state === 'STANDBY') ? 'STANDBY' : 'RUN';
      this.medium = 'ts'; // 復帰は必ずHLSから再確立(FLV代替は必要なら自動切替)
      this.startedAt = s.startedAt || Date.now();
      this.fileStartedAt = Date.now();
      this.partIndex = s.partIndex || 0;   // パート番号を引き継ぎ(連番が続く)
      this.segTotal = s.segTotal || 0;
      this.bytesTotal = s.bytesTotal || 0;
      this.resumes = s.resumes || 0;
      this.segFails = s.segFails || 0;
      this.gapCount = s.gapCount || 0;
      this.byterangeSkipped = s.byterangeSkipped || 0; // v1.12.0
      this.accessMode = (s.accessMode === 'member') ? 'member' : 'public';
      this.memberPlaylist = ''; // Re-resolve under the current authorized session, never restore a signed URL.
      this.resetQualityState(); // v1.9.0: 復帰時は画質を再解決
      this.audio = new AudioRecorder(this); // 復旧時は記録済み数だけを下限として引き継ぐ。
      this.audio.abandonedQueuedOnSourceChange = Number.isSafeInteger(s.audioQueueAbandoned) && s.audioQueueAbandoned >= 0 ? s.audioQueueAbandoned : 0;
      // A crash or failed storage write can have occurred after the last snapshot.
      this.audio.abandonedQueuedHistoryComplete = false;
      this.audio.activeSegmentAtSourceChange = Number.isSafeInteger(s.audioActiveAtSourceChange) && s.audioActiveAtSourceChange >= 0 ? s.audioActiveAtSourceChange : 0;
      this.audio.staleSegmentResultsIgnored = Number.isSafeInteger(s.audioStaleResultsIgnored) && s.audioStaleResultsIgnored >= 0 ? s.audioStaleResultsIgnored : 0;
      this._skipBacklog = true;  // 復帰直後の既存ウィンドウはスキップ(重複防止)
      this.lastPollAt = 0; this._playlistBody = null; this._playlistUri = '';
      this.curPollMs = 3000;
      this.lastStandbyAt = 0;
      this.lastDisAnchor = null;
      this.plBackoffUntil = 0;
      this.segBackoffUntil = 0;
      this.consecutive429 = 0;
      const restoredParts = (typeof recSanitizePersistedParts === 'function') ? recSanitizePersistedParts(s.partsLog) : [];
      this.partsLog = restoredParts.slice();
      this._joinTruncated = false;
      this._joinParts = restoredParts.slice();
      this._hlsPartBoundaries = {};
      this.filesSaved = (Number.isSafeInteger(s.filesSaved) && s.filesSaved >= restoredParts.length) ? s.filesSaved : restoredParts.length;
      if (restoredParts.length > this.partIndex) this.partIndex = restoredParts.length;
      if (this.audio && Array.isArray(s.audioPartsLog) && typeof recSanitizePersistedParts === 'function') {
        const restoredAudio = recSanitizePersistedParts(s.audioPartsLog);
        this.audio.partsLog = restoredAudio.slice();
        this.audio._joinParts = restoredAudio.slice();
        this.audio.filesSaved = restoredAudio.length;
        if (restoredAudio.length > this.audio.partIndex) this.audio.partIndex = restoredAudio.length;
      }
      this._spd = [];
      this.ticker = createTicker(REC_POLL_MS, () => this.tick());
      this.log('録画セッションを復帰 — 前回: seg' + this.segTotal + ' / ' +
        (this.bytesTotal / 1048576).toFixed(1) + 'MB' +
        (this.resumes ? ' / 再開' + this.resumes + '回' : '') +
        (this.state === 'STANDBY' ? ' / 追跡待機から継続' : '') +
        ' (中断直後の数segは重複/欠落の可能性があります)');
      this.ui.recState(true, this.state, this.medium);
      if (this.state === 'STANDBY') this.standbySince = Date.now();
      const rec = this;
      this._unload = function (e) {
        if (rec.recording && (rec.bytes > 0 || rec.filesSaved > 0)) { e.preventDefault(); e.returnValue = ''; }
      };
      RECENV.onUnload(this._unload); // v2.0 Step1: RECENV経由
      this._titleMin = -1;
      this.updateTitle(true);
      this.persistSession();
      if (this.state === 'RUN') {
        const self = this;
        this._resolvingResume=true;
        this._resumeReady=(async()=>{
          if(self.accessMode==='member'){
            const result=await self._fResolveMember(self.id,m=>self.log(m));
            if(self.stopped)return;
            if(!result || !result.ok){self.log('復帰時の視聴権限を確認できませんでした。録画を停止します');await self.stop(false);return;}
            self.memberPlaylist=result.playlist;self.sourceKind='member';
          }
          if(self.stopped)return;
          await self.pollPlaylist();await self.drain();
        })().catch(async()=>{if(!self.stopped){self.log('復帰処理に失敗しました。録画を停止します');await self.stop(false);}}).finally(()=>{self._resolvingResume=false;});
      }
    }

    async saveJoinJob() {
      if(this.recording) { this.log('結合リストは録画停止後に保存してください'); return; }
      await recWaitSaves(this);
      const job=recJoinJob(this);
      const name='RPLAY_'+this.id+'_join_'+Date.now()+'.json';
      await RECENV.download(new Blob([JSON.stringify(job,null,2)],{type:'application/json'}),name);
      this.log('結合リストを保存: '+name+' — 録画ファイルと同じフォルダーで結合ツールを実行できます');
      return job;
    }

    /* セッションの録画情報JSON(yt-dlpの.info.json相当)を保存 */
    saveInfoJson() {
      if (!this.partsLog.length) return;
      const selfRef = this; // v1.11.0: audioRendition生成用
      const _recov = (typeof RECENV.recoveredParts === 'function') ? RECENV.recoveredParts() : [];
      /* v2.6.0(P1/P2): 世代復旧・fMP4 MAP宣言・LL-HLS指標の数値証拠(CLIと同形式) */
      const _evd = recRecoveryEvidence(this, this.audio);
      /* v2.7.0(A-02/A-03): 認証・canary証拠(RECENVフック経由 — 未供給なら出さない) */
      const _auth = (typeof RECENV.authStats === 'function') ? RECENV.authStats() : undefined;
      const _canary = (typeof RECENV.canaryEvidence === 'function') ? RECENV.canaryEvidence() : undefined;
      const info = {
        partBoundaryEvidence: this._hlsPartBoundaries || {},
        tool: 'RPLAY Stable Player v2.56.0',
        creator: this.creatorName(),
        creatorOid: this.id,
        playlist: recRedactUrl(this.playlistUrl()), // v2.5.0(P2): 署名/key2クエリを出力しない
        sourceKind: this.sourceKind || (this.accessMode === 'member' ? 'member' : 'legacy'),
        accessMode: this.accessMode,
        quality: this.selVariant ? {
          selected: this.qualityTxt,
          url: recRedactUrl(this.selVariant.url), // v2.5.0(P2)
          width: this.selVariant.width,
          height: this.selVariant.height,
          fps: this.selVariant.fps,
          bandwidth: this.selVariant.bwEff,
          upgrades: this.qualityUpgrades,
          available: (this.variants || []).map(function (v) {
            return { label: qualityLabel(v), bandwidth: v.bwEff, url: recRedactUrl(v.url) }; // v2.5.0(P2)
          })
        } : undefined,
        streamBase: this.liveInfo ? this._fBaseLabel(this.liveInfo) : undefined,
        schedule: this.schedItem ? { title: this.schedItem.title, scheduledAt: new Date(this.schedItem.scheduledAt).toISOString() } : undefined,
        startedAt: new Date(this.startedAt).toISOString(),
        endedAt: new Date().toISOString(),
        durationSec: Math.round((Date.now() - this.startedAt) / 1000),
        totalBytes: this.bytesTotal,
        segments: this.segTotal,
        missingSuspect: this.segFails + this.gapCount,
        segmentWriteEvidence: ((typeof HLS.writeEvidence === 'function') ? HLS.writeEvidence(this) : undefined),
        byterangeSkipped: this.byterangeSkipped || 0, // v1.12.0
        trackingResumes: this.resumes,
        recoveredParts: (_recov && _recov.length) ? _recov : undefined, // v2.1.0(設計書§4.3)
        audio: this.audioTxt || undefined, // v1.10.0
        audioRendition: (function () {     // v1.11.0: 音声レンディション録画の記録
          const a = selfRef.audio ? selfRef.audio.stats() : null;
          // トグルOFF等で音声データが1件も無いセッションは記録しない('off'は停止理由扱いにしない)
          if (!a || (!a.running && !a.segTotal && !(a.abandonedQueuedOnSourceChange > 0) && a.abandonedQueuedHistoryComplete !== false && (!a.stopReason || a.stopReason === 'off'))) return undefined;
          return {
            enabled: a.enabled, running: a.running, group: a.group, uri: recRedactUrl(a.uri), // v2.5.0(P2)
            bandwidth: a.bw, channels: a.channels, label: a.label,
            segTotal: a.segTotal, segFails: a.segFails, abandonedQueuedOnSourceChange: a.abandonedQueuedOnSourceChange, abandonedQueuedHistoryComplete: a.abandonedQueuedHistoryComplete, activeSegmentAtSourceChange: a.activeSegmentAtSourceChange, staleSegmentResultsIgnored: a.staleSegmentResultsIgnored, bytes: a.bytes, files: a.files,
            segmentWriteEvidence: ((typeof HLS.writeEvidence === 'function') ? HLS.writeEvidence(selfRef.audio) : undefined),
            stopped: a.stopReason || undefined, stoppedAt: a.stoppedAt || undefined,
            parts: a.partsLog
          };
        })(),
        stats: this.statsBlock(),          // v1.10.0: 欠落率/再接続/基盤切替/画質履歴/平均間隔
        generationRecovery: _evd && _evd.generationRecovery,  // v2.6.0: 世代復旧の数値証拠
        fmp4Evidence: _evd && _evd.fmp4Evidence,              // v2.6.0(P1): EXT-X-MAP宣言証拠
        llhlsEvidence: _evd && _evd.llhlsEvidence,            // v2.6.0(P2): LL-HLS指標タグ計数
        authEvidence: _auth,                                  // v2.7.0(A-02): 認証方式と401分類
        canaryEvidence: _canary,                              // v2.7.0(A-03): 応答形状canary
        sessionTrackingEvidence: (function () {               // v2.8.0(W-01): streamStartTime 10分閾値追跡
          if (selfRef.liveInfo) selfRef.noteStreamStart(selfRef.liveInfo);
          return selfRef._sessionTracker ? rspSessionTrackingEvidence(selfRef._sessionTracker) : undefined;
        })(),
        errorTaxonomyEvidence: selfRef._errTaxonomy ? rspErrorTaxonomyEvidence(selfRef._errTaxonomy) : undefined, // v2.8.0(W-02): 4層ErrorKind分類
        subtitleEvidence: ((typeof rspSubtitleEvidenceBlock === 'function') ? rspSubtitleEvidenceBlock(this._masterTxt, this.variants) : undefined), // v2.9.0(A-09): 字幕レンディション観測(取得しない・未供給環境では出さない)
        ...(this._cdn404Retries?{segment404Evidence:{retries:this._cdn404Retries,recoveredSegments:this._cdn404Recovered||0,failedSegments:this._cdn404Drops||0}}:{}),
        ...(this._transientTransferRetries?{segmentTransferRetryEvidence:{retries:this._transientTransferRetries,recoveredSegments:this._transientTransferRecovered||0,failedSegments:this._transientTransferDrops||0}}:{}),
        ...(this._badPlaylistTotal?{playlistParseGraceEvidence:{transientFailures:this._badPlaylistTotal,recoveredPolls:this._badPlaylistRecovered||0}}:{}),
        adFilterEvidence:{adKeywordConfigured:!!(this._adKeywordRe||this.adKeyword()),videoScte35Indicators:this._hlsScte35Indicators||0,audioScte35Indicators:(this.audio&&this.audio._hlsScte35Indicators)||0,videoFilteredSegments:this._hlsAdFilteredSegments||0,audioFilteredSegments:(this.audio&&this.audio._hlsAdFilteredSegments)||0},
        partContinuityEvidence: ((typeof rspPartContinuityEvidence === 'function') ? rspPartContinuityEvidence({
          splitMinutes: (typeof this.splitMinutes === 'function') ? this.splitMinutes() : 0,
          maxSizeMb: Math.round(((typeof this.fileCapBytes === 'function') ? this.fileCapBytes() : 600 * 1048576) / 1048576),
          splitOnDiscontinuity: (typeof this.splitOnDiscontinuity === 'function') ? this.splitOnDiscontinuity() : false,
          discontinuityMergedCount: (this._hlsContinuity && this._hlsContinuity.discontinuityMergedCount) || 0,
          discontinuitySplitCount: (this._hlsContinuity && this._hlsContinuity.discontinuitySplitCount) || 0,
          sameSessionStandbyContinuations: this._sameSessionStandbyContinuations || 0,
          partsConcatenated: 0,
          concatOutput: null
        }) : undefined), // v2.11.0(W-05): TS細切れ防止・単一ファイル継続の証拠,
        externalDownloaderEvidence: ((typeof rspExternalDownloaderEvidence === 'function') ? rspExternalDownloaderEvidence(
          rspBuildM3u8dlExport({
            url: this.activePlaylist || '',
            saveName: 'RPLAY_' + this.id,
            headers: { Referer: 'https://rplay.live/' },
            liveRealTimeMerge: true
          }),
          {
            tsDisguiseStrippedCount: this._hlsDisguiseStripped || 0,
            tsDisguiseBytesTotal: this._hlsDisguiseBytes || 0,
            queryInheritedCount: this._hlsQueryInherited || 0
          }
        ) : undefined), // v2.15.0(C-01/C-02/C-03): cat-catch知見(TS偽装ヘッダ除去・クエリ継承・m3u8dl連携)
        aesFallbackEvidence: (this._aesFallback && this._aesFallback.attempts > 0) ? Object.assign({}, this._aesFallback) : undefined, // v2.37.0(N-01)
        continuityCounterEvidence: ((typeof HLS !== 'undefined' && HLS.ccEvidence) ? HLS.ccEvidence(this._hlsCcAudit) : undefined), // v2.37.0(N-03)
        parts: this.partsLog.slice()
      };
      this._lastInfo = info; // v1.10.0: 試験フック用
      try {
        const name = 'RPLAY_' + safeName(this.creatorName()) + '_' + stampNow() + '_info.json';
        RECENV.download(new Blob([JSON.stringify(info, null, 2)], { type: 'application/json' }), name); // v2.0 Step1
        this.log('録画情報JSONを保存: ' + name + ' (パート' + info.parts.length + '本)');
        if (this.csvOut()) this.saveInfoCsv(info); // v1.10.0: 統計CSV
      } catch (e) {
        this.log('情報JSONの保存に失敗: ' + (e && e.message || e));
      }
    }

    /* ---- パート(ファイル)入出力 ---- */
    ensurePart() {
      if (this.partOpen) return;
      this.partExt = (this.medium === 'flv') ? 'flv' : (this.mediaFormat==='mp4'?'mp4':'ts');
      const _d = new Date(); // v1.10.0: テンプレート対応(未設定なら従来命名)
      this.partName = recFileName(this.nameTpl(), {
        date: '' + _d.getFullYear() + pad2(_d.getMonth() + 1) + pad2(_d.getDate()),
        time: pad2(_d.getHours()) + pad2(_d.getMinutes()) + pad2(_d.getSeconds()),
        creator: this.creatorName(), title: this.recTitle(),
        quality: this.qualityTxt || '', part: this.partIndex + 1, ext: this.partExt
      }, 'RPLAY_' + safeName(this.creatorName()) + '_' + stampNow() +
        '_p' + (this.partIndex + 1) + '.' + this.partExt);
      this.partOpen = true;
      this.bytes = 0; this.segCount = 0; this.chunks = [];
      this.fileStartedAt = Date.now();
      this._partAuditStart=rspPartCommit.snapshot(this,HLS);
      if(typeof HLS.startPartAudit==='function')HLS.startPartAudit(this);
      this.partIO = new RecPartSink(this.partName, this.dirHandle, this.partExt);
      this.partName = this.partIO.name;
    }

    async pushData(u8) {
      this.ensurePart();const io=this.partIO;
      io.push(u8);this.bytes+=u8.length;this.bytesTotal+=u8.length;
      try { await io.flush(); }
      catch (e) {
        this.log('ディスク書き込み失敗 — 録画を停止します');
        if(this.rec)this.stopFinal('write_error','音声書き込み失敗');
        else this.stop(false);
        throw e;
      }
    }

    waitForSaves() { return recWaitSaves(this); }
    closePart() {
      if (!this.partOpen) return Promise.resolve();
      this.partOpen=false;
      const io=this.partIO, bytes=this.bytes, ext=this.partExt;
      const auditFrom=this._partAuditStart,auditTo=rspPartCommit.snapshot(this,HLS);this._partAuditStart=null;
      const partSeq=typeof HLS.takePartAudit==='function'?HLS.takePartAudit(this):null;
      const entry={file:this.partName,ext,bytes,segments:this.segCount||0,
        startedAt:new Date(this.fileStartedAt).toISOString(),endedAt:new Date().toISOString(),saveState:'pending',
        structureValidated:(ext==='ts'||ext==='mp4')};
      if (false) entry.kind='audio';
      if(bytes>0){if(!this._joinParts)this._joinParts=[];if(this._joinParts.length<4096)this._joinParts.push(entry);else this._joinTruncated=true;if(this.partsLog.length>=500)this.partsLog.shift();this.partsLog.push(entry);}
      this.partIO=null;this.chunks=[];this.bytes=0;this.segCount=0;this.partIndex++;
      const job=io.close().then(result=>{
        rspPartCommit.correlate(entry,auditFrom,auditTo,result,entry.kind||'video',partSeq);
        entry.saveState=result.stage;
        entry.hashState=result.hashHex?'hashed':'unavailable';
        if(bytes>0&&result.confirmed){this.filesSaved++;if(this.filesByExt)this.filesByExt[ext]=(this.filesByExt[ext]||0)+1;}
        else if(bytes>0)this.saveRequests=(this.saveRequests||0)+1;
        if(bytes>0)this.log((result.confirmed?'ローカル保存確定: ':'DL要求・完了未確認: ')+entry.file);
        if(bytes>0)recLedgerStage(entry,'REQUESTED',{at:new Date(this.fileStartedAt).toISOString(),segments:entry.segments});
        if(bytes>0&&result.confirmed){
          recLedgerStage(entry,'FILE_WRITTEN',{bytes:bytes,sinkStage:result.stage});
          if(result.stage!=='FILE_CLOSED')recLedgerStage(entry,'BROWSER_DONE',{sinkStage:result.stage,bytes:bytes});
        }
        if(bytes>0&&result.hashHex){entry.sha256=result.hashHex;recLedgerStage(entry,'HASHED',{sha256:result.hashHex});}
        if(bytes>0)entry.ledgerStatus=recLedgerStatus(entry);
        if(bytes>0&&typeof this.persistSession==='function')this.persistSession();
        return result;
      }).catch(()=>{rspPartCommit.correlate(entry,auditFrom,auditTo,{stage:'ERROR',confirmed:false},entry.kind||'video',partSeq);entry.saveState='failed';if(bytes>0){recLedgerStage(entry,'REQUESTED',{at:new Date(this.fileStartedAt).toISOString(),segments:entry.segments});entry.ledgerStatus='failed';}this.failedSaves=(this.failedSaves||0)+1;this.log('保存失敗: '+entry.file+' — 元データ/復旧状態を確認してください');});
      return recTrackSave(this,job);
    }

    maybeSplit() {
      if (!this.partOpen) return;
      const minMs = this.splitMinutes() * 60000;
      if ((minMs > 0 && Date.now() - this.fileStartedAt >= minMs) ||
          (!(minMs===0 && this.partIO && typeof this.partIO.continuousDisk==='function' && this.partIO.continuousDisk()) && this.bytes >= (this.partIO && this.partIO.writer ? this.fileCapBytes() : Math.min(this.fileCapBytes(),REC_FILE_CAP_BYTES)))) {
        const ev=this._hlsPartBoundaries||(this._hlsPartBoundaries={});const reason=this.bytes>=(this.partIO&&this.partIO.writer?this.fileCapBytes():Math.min(this.fileCapBytes(),REC_FILE_CAP_BYTES))?'sizeLimit':'timeLimit';ev[reason]=(ev[reason]||0)+1;
        this.log('自動分割: ' + (this.bytes / 1048576).toFixed(1) + 'MB を保存(' + (this.partIndex + 1) + '本目)');
        this.closePart();
      }
    }

    /* ---- メインループ(3秒tick / 実アクセスは適応間隔でゲート) ---- */
    async tick() {
      if (this.stopped || this.busy || this._resolvingResume) return;
      this.busy = true;
      this.tickN++;
      if ((this.tickN % REC_SESSION_WRITE_EVERY) === 0) this.persistSession(); // 約6秒ごとに永続化
      try {
        this._spd.push([Date.now(), this.bytesTotal]);
        if (this._spd.length > 12) this._spd.shift();
        if (this.state === 'RUN' && this.medium === 'ts') {
          if (!this.pendingEnd && Date.now() - this.lastPollAt >= this.curPollMs) await this.pollPlaylist();
          await this.drain();
          if (this.audio) await this.audio.tick();
          if (this.pendingEnd && this.queue.length===0 && (!this.audio || !this.audio.running || (!this.audio._busy && this.audio.queue.length===0))) {
            const r = this.pendingEnd;
            this.pendingEnd = null;
            this.finishRun(r);
          } else if (this.state === 'RUN') {
            this.checkStall();
            this.maybeSplit();
            this.maybeQualityUpgrade(); // v1.9.0: 画質昇格の定期再走査(内部で節流・非同期)

          }
        } else if (this.state === 'RUN' && this.medium === 'flv') {
          this.maybeSplit(); // FLV受信ループが別途動作中。分割判定のみ
        } else if (this.state === 'STANDBY') {
          if (Date.now() - this.lastStandbyAt >= this.standbyInterval()) await this.standbyProbe();
        }
        this.updateTitle();
        this.ui.recUpdate(this.stats());
      } catch (e) {}
      this.busy = false;
    }

    checkStall() {
      if (this.queue.length === 0 && Date.now() - this.lastNewSegAt > REC_END_STALL_MS) {
        this.pendingEnd = '新セグメント' + Math.round(REC_END_STALL_MS / 1000) + '秒間停止';
      }
    }

    finishRun(reason) {
      if (!this.recording) return;
      if (this.follow()) {
        this.state = 'STANDBY';
        this.standbySince = Date.now();
        this.abortFlv();
        if (this.audio) this.audio.pause('standby'); // v1.11.0: 音声も確定保存(次セッションで再評価)
        this.closePart(); // 終了時点までのデータを確定保存
        this.medium = 'ts';
        this.log('配信終了を検出(' + reason + ') → 追跡待機へ。次の配信を自動探索します(' +
          Math.round(REC_STANDBY_MS / 1000) + '秒間隔・ジッタ付き)');
        this.ui.recState(true, 'STANDBY', 'ts');
        this.notify('RPLAY録画 — 追跡待機', '配信終了を検出。次の配信で自動録画を再開します(' + this.creatorName() + ')');
        this.persistSession();
      } else {
        this.stop(true);
      }
    }

    /* ---- プレイリスト監視(HLS録画) ---- */
    async probePlaylist(candidate) {
      const base=candidate||this.playlistUrl();
      try {
        const classify=r=>{
          if(r.status===401||r.status===403)return 'token';
          if(r.status===404||r.status===410)return 'offline';
          if(r.status!==200)return 'server';
          if(!/^\uFEFF?#EXTM3U(?:\r?\n|$)/.test(r.txt||''))return 'offline';
          // An ended media playlist must not keep background recording alive.
          if(/^#EXT-X-ENDLIST(?:\r?$)/m.test(r.txt))return 'offline';
          return /^#EXTINF:/m.test(r.txt)?'live':null;
        };
        const result=await this.fetchPlaylistOnce(base),state=classify(result);
        if(state)return state;
        if(/^#EXT-X-STREAM-INF:/m.test(result.txt||'')){
          const variant=this.resolveVariantUrl(result.txt,base);
          if(variant)return classify(await this.fetchPlaylistOnce(variant))||'offline';
        }
        return 'offline';
      }catch(e){return 'server';}
    }

    /* RPLAY API: {"viewerCount":n,"streamState":"live"|"twitch"|...} */
    async apiStreamState() {
      try {
        const ctl = new AbortController();
        const to = setTimeout(() => ctl.abort(), REC_API_TIMEOUT_MS);
        const res = await fetch(this.apiBase + '/live/stream?creatorOid=' + encodeURIComponent(this.id),
          { cache: 'no-store', signal: ctl.signal });
        clearTimeout(to);
        if (res.status !== 200) return 'off';
        let j = null;
        try { j = await res.json(); } catch (e2) { return 'unknown'; }
        return (j && j.streamState === 'live') ? 'live' : 'off';
      } catch (e) { return 'unknown'; } // CORS/ネットワーク: 判定不能(m3u8 probeを優先)
    }

    /* サーバー負荷配慮: プレイリスト取得間隔はTARGETDURATION基準(公式プレイヤー級) */
    pollInterval(changed=true) { return recHlsReloadMs(this.targetDur,changed); }
    standbyInterval() {
      return Math.round(REC_STANDBY_MS * (1 - REC_POLL_JITTER + Math.random() * REC_POLL_JITTER * 2));
    }

    /* ---- v1.7.0: 新旧基盤の源フォールバック ---- */
    /* 単一源の生存確認(#EXTM3U/#EXTINF/#EXT-X-STREAM-INFのいずれか) */
    async probeSourceOk(base) {
      if(!base)return false;
      return (await this.probePlaylist(base)) === 'live';
    }
    /* 源の再探査: live/playを最新化し、採用源を除く候補を試して切替する。
     BytePlus→IVS等の基盤変更(突然の切替)への追従用。60秒節流。 */
    async refreshLiveSource(reason) {
      if (this.urlMode()) return false; /* v2.40.0: URL録画はRPLAY APIで源を探査しない */
      if (this._srcRefrAt && Date.now() - this._srcRefrAt < 60000) return false;
      this._srcRefrAt = Date.now();
      try {
        const q = new URLSearchParams({ creatorOid: this.id });
        RspAuth.probe();
        for (const k in RspAuth.requestorQuery()) q.set(k, RspAuth.requestorQuery()[k]);
        const r = await authedJson(this.apiBase + '/live/play?' + q.toString(), { timeoutMs: 8000 });
        this.liveInfo = (r && r.ok && r.json) ? r.json : null;
        if (this.liveInfo) this.noteStreamStart(this.liveInfo);
      } catch (e) { /* 詮索失敗 → 旧情報のまま候補を試す */ }
      const cur = this.playlistUrl();
      const cands = rspSourceCandidates(this.liveInfo, CDN_BASE + this.id + '.m3u8');
      for (const base of cands) {
        if (base === cur || base === this.memberPlaylist || base === (this.getCustomM3u8 ? this.getCustomM3u8() : '')) continue;
        if (await this.probeSourceOk(base)) {
          this.liveM3u8 = base;
          this.resetQualityState(); // v1.9.0: 基盤切替時は画質状態を引き継がない
          this.sourceKind = base === (this.liveInfo && this.liveInfo.playUrl) ? 'ivs' :
            (base === (this.liveInfo && this.liveInfo.bytePlusPlaybackUrl) ? 'abr' : 'legacy');
          // v1.10.0: 基盤切替の統計
          this.sourceSwitches++;
          this.sourceHistory.push({ at: new Date().toISOString(), to: this.sourceKind });
          if (this.sourceHistory.length > 20) this.sourceHistory.shift();
          this.log('HLS源を切替(' + (reason || '探査') + '): ' + this.sourceKind.toUpperCase() + ' ' + base);
          return true;
        }
      }
      return false;
    }

    /* v1.7.0: master playlist(#EXT-X-STREAM-INF付き)→最高画質variant(media playlist)の解決。
     BytePlusのabr.m3u8はmaster一覧で、variant(/live/<id>_abrhd/index.m3u8等)を
     セグメントとして扱ってしまう旧実装のバグを修正。解決結果はキャッシュ。
     v1.9.0: 選択基準を「解像度→fps→帯域」の最高に更新(qualityFrom経由)。
     副作用: this.variants/selVariant/qualityTxtを更新する。 */
    resolveVariantUrl(txt, base) {
      const best = this.qualityFrom(txt, base);
      return best ? best.url : null;
    }
    /* プレイリスト1件fetch(200:text / その他: status) — pollPlaylistとvariant降下で共用 */
    async fetchPlaylistOnce(base) {
      const url=base;
      const startedAt=Date.now(),generation=this._hlsGeneration||0;
      if(!this._hlsPlaylistTransfer)this._hlsPlaylistTransfer=HLS.createTransfer(fetch,REC_API_TIMEOUT_MS);
      let r=await this._hlsPlaylistTransfer.request({uri:url},2*1048576);
      if(!HLS.alive(this,generation))return {status:0};
      if(r.status===403 && !this.urlMode() && typeof RECENV.butterToken==='function'){ /* v2.40.0: URL録画は外部ホストへ資格を送らない */
        this.noteErrKind('AUTH');
        try{
          const bt=await RECENV.butterToken();
          if(bt && HLS.alive(this,generation)){
            r=await this._hlsPlaylistTransfer.request({uri:url,butter:bt},2*1048576);
            if(!HLS.alive(this,generation))return {status:0};
          }
        }catch(e){}
      }
      if(r.bytes){
        const txt=new TextDecoder().decode(r.bytes);
        if(txt.indexOf('#EXT-X-STREAM-INF')<0&&txt.indexOf('#EXT-X-TARGETDURATION:')>=0){this._lastMediaRequestStart=startedAt;this._lastMediaRequestUri=base;}
        return {status:r.status,txt};
      }
      if(r.status>=500)this.noteErrKind('SOURCE');
      else if(r.status===0)this.noteErrKind('NETWORK');
      else if(r.status===401||r.status===403)this.noteErrKind('AUTH');
      return {status:r.status,retryAfter:recRetryAfterMs(r.retryAfter)};
    }

    /* ---- v1.9.0: 画質選択(最高画質) ----
     master playlistから最高variant(解像度→fps→帯域)を選び、録画中も定期
     再走査で昇格/消失フォールバックする(streamlink/N_m3u8DL-RE踏襲)。 */
    resetQualityState() {
      this.masterUrl = ''; this._variantOf = ''; this.variants = [];
      this.selVariant = null; this.qualityTxt = '';
      this.deadVariants.clear();
      this._qUpAt = 0; this._qFbAt = 0;
    }
    qualityFrom(txt, base) {
      this._masterTxt = String(txt || ''); // v1.10.0: 音声グループ解析用に原文を保持
      const vars = parseVariants(txt, base);
      if (!vars.length) return null;
      const best = this.bestQ() ? pickBestVariant(vars, this.deadVariants) : vars[0];
      if (!best) return null;
      this.variants = vars;
      this.selVariant = best;
      this.qualityTxt = qualityLabel(best);
      return best;
    }
    qualityCandidatesText() {
      const labs = [];
      for (let i = 0; i < this.variants.length && i < 6; i++) labs.push(qualityLabel(this.variants[i]));
      return labs.join(' / ');
    }
    /* variantの切替(画質昇格/消失フォールバック共通):
     現パートを区切って保存(画質が混在するファイルを作らない)し、
     新variantのライブエッジから継続(既存ウィンドウは重複防止で除外) */
    applyVariantSwitch(nextUrl, why) {
      if (this.partOpen && this.bytes > 0) this.closePart();
      this._variantOf = nextUrl;
      this._skipBacklog = true;
      this.lastMediaSeq = -1;
      this.log(why);
      if (this.audio) this.audio.sync('variant切替'); // v1.11.0: AUDIO属性が変わったら音声も追従再解決
    }
    /* master再走査: より高い画質が出現していれば昇格(下げはしない) */
    async maybeQualityUpgrade() {
      if (!this.masterUrl || !this.bestQ() || this._qUpRunning) return;
      if(this.bytesTotal>0)return; // 録画開始後は画質昇格による不要な分割を抑える。消失時fallbackは維持。
      if (Date.now() - this._qUpAt < REC_QUALITY_RESCAN_MS) return;
      this._qUpAt = Date.now();
      this._qUpRunning = true;
      try {
        const r = await this.fetchPlaylistOnce(this.masterUrl);
        if (r.status !== 200 || !r.txt) return;
        this._masterTxt = r.txt; // v1.11.0: 音声解析用の原文も更新
        const vars = parseVariants(r.txt, this.masterUrl);
        if (!vars.length) return;
        this.variants = vars;
        const best = pickBestVariant(vars, this.deadVariants);
        if (!best || !this.selVariant) return;
        if (best.url !== this._variantOf && isBetterVariant(best, this.selVariant)) {
          const from = this.qualityTxt;
          this.selVariant = best;
          this.qualityTxt = qualityLabel(best);
          this.qualityUpgrades++;
          this.qualityHistory.push({ at: new Date().toISOString(), from: from || '', to: this.qualityTxt, why: 'upgrade' }); // v1.10.0
          if (this.qualityHistory.length > 20) this.qualityHistory.shift();
          this.deadVariants.clear();
          this.applyVariantSwitch(best.url,
            '画質を昇格: ' + (from || '不明') + ' → ' + this.qualityTxt + ' — パートを区切って新しい画質で録画を続行します');
        }
      } catch (e) { /* 再走査失敗 → 次回 */ }
      finally { this._qUpRunning = false; }
    }
    /* variant消失(404/410)時: masterから次の画質へフォールバック。
     戻り値: 切替先のvariant(切替不可ならnull) */
    async fallbackVariant(deadUrl) {
      if (!this.masterUrl || !this.bestQ()) return null;
      if (Date.now() - this._qFbAt < REC_QUALITY_FALLBACK_MS) return null;
      this._qFbAt = Date.now();
      try {
        const r = await this.fetchPlaylistOnce(this.masterUrl);
        if (r.status !== 200 || !r.txt) return null;
        this._masterTxt = r.txt; // v1.11.0: 音声解析用の原文も更新
        this.deadVariants.add(deadUrl);
        const vars = parseVariants(r.txt, this.masterUrl);
        if (!vars.length) return null;
        this.variants = vars;
        const best = pickBestVariant(vars, this.deadVariants);
        if (!best || best.url === deadUrl) return null;
        const from = this.qualityTxt;
        this.selVariant = best;
        this.qualityTxt = qualityLabel(best);
        this.qualityFallbacks++; // v1.10.0: フォールバック統計
        this.qualityHistory.push({ at: new Date().toISOString(), from: from || '', to: this.qualityTxt, why: 'fallback' });
        if (this.qualityHistory.length > 20) this.qualityHistory.shift();
        this.applyVariantSwitch(best.url,
          'variantが消失(404) → 次の画質へフォールバック: ' + (from || '不明') + ' → ' + this.qualityTxt + ' — 録画を継続します');
        return best;
      } catch (e) { return null; }
    }

    async pollPlaylist() {
      if (Date.now() < this.plBackoffUntil) return; // 403/429バックオフ中は静かに待機
      const base = this.playlistUrl();
      let effBase = base;
      let txt = null;
      let saw404 = false;
      let saw403 = false;
      let saw401 = false;
      let saw429 = false;
      let saw429RA = 0; // v1.12.0: Retry-After(サーバー指定待機)
      this.lastPollAt = Date.now();
      this.pollCount++; // v1.10.0: 統計
      // v1.9.0: 解決済みvariantの直接ポーリング(master再取得を省略 — リクエスト数を
      // 半減。masterは画質昇格チェック(maybeQualityUpgrade)でのみ定期再走査する。
      // streamlink/N_m3u8DL-REと同じ「lock→定期再走査」モデル)
      const cachedVariant = this.bestQ() && this.masterUrl === base && this._variantOf;
      try {
        if (cachedVariant) {
          effBase = this._variantOf;
          const rv = await this.fetchPlaylistOnce(effBase);
          if (rv.status === 200) txt = rv.txt;
          else if (rv.status === 404 || rv.status === 410) {
            // variant消失 → 次の画質へフォールバックを試す
            const fb = await this.fallbackVariant(effBase);
            if (fb) {
              effBase = fb.url;
              const r3 = await this.fetchPlaylistOnce(effBase);
              if (r3.status === 200) txt = r3.txt; else { saw404 = true; txt = null; }
            } else { saw404 = true; txt = null; }
          }
          else if (rv.status === 403 || rv.status === 401) { saw403 = true; txt = null; }
          else if (rv.status === 429) { saw429 = true; saw429RA = rv.retryAfter || saw429RA; txt = null; } // v1.12.0
          else txt = null;
        } else {
          const r1 = await this.fetchPlaylistOnce(base);
          if (r1.status === 200) {
            txt = r1.txt;
            /* master playlistなら最高画質variantへ一段降りて即再取得
             (abr.m3u8等。源がmasterのまま録画に回る旧バグはv1.7.0で修正、
              v1.9.0で選択基準を「解像度→fps→帯域」の最高に更新) */
            if (txt.indexOf('#EXT-X-STREAM-INF') >= 0) {
              this.masterUrl = base;
              const v = this.resolveVariantUrl(txt, base);
              if (v) {
                if (this._variantOf !== v) {
                  this._variantOf = v;
                  this.log('master playlist → variant解決: ' + v);
                  this.log('画質: ' + this.qualityTxt + ' を選択' +
                    (this.variants.length > 1 ? '(最高・候補' + this.variants.length + '件: ' + this.qualityCandidatesText() + ')' : ''));
                  this.logAudioInfo(); // v1.10.0: 音声レンディションの表示
                  if (this.audio) this.audio.sync('variant解決'); // v1.11.0: 音声源の解決/再解決
                }
                effBase = v;
                const r2 = await this.fetchPlaylistOnce(v);
                if (r2.status === 200) txt = r2.txt;
                else if (r2.status === 404 || r2.status === 410) {
                  const fb = await this.fallbackVariant(v);
                  if (fb) {
                    effBase = fb.url;
                    const r3 = await this.fetchPlaylistOnce(effBase);
                    if (r3.status === 200) txt = r3.txt; else { saw404 = true; txt = null; }
                  } else { if (rspDetectPaywallBlocked(200, r2.status)) { this.noteErrKind('AUTH'); this.log('master 200 / variant ' + r2.status + ' (paywall_blocked: 有料壁/権限不足の可能性)'); } saw404 = true; txt = null; }
                }
                else if (r2.status === 403 || r2.status === 401) { saw403 = true; txt = null; }
                else if (r2.status === 429) { saw429 = true; saw429RA = r2.retryAfter || saw429RA; txt = null; } // v1.12.0
                else txt = null;
              } else {
                this.log('master playlistだがvariantが解決できません — 次tickで再確認');
                txt = null;
              }
            } else if (this.masterUrl === base) {
              // 源がmedia playlistに戻った(基盤切替後など) → 画質状態をリセット
              this.resetQualityState();
            }
          }
          else if (r1.status === 404 || r1.status === 410) saw404 = true;
          else if (r1.status === 403 || r1.status === 401) saw403 = true;
          else if (r1.status === 429) { saw429 = true; saw429RA = r1.retryAfter || saw429RA; } // v1.12.0
          // 5xx/タイムアウトは一時障害扱い(次tickで再試行)
        }
      } catch (e) { /* 次tickで再試行 */ }
      if (this.stopped) return;

      const dirBase = effBase.slice(0, effBase.lastIndexOf('/') + 1);
      if (saw403 || saw401) {
        const code = saw401 ? '401' : '403';
        // アクセス制限 — 連打せず待機(サーバー配慮)。404とは区別(終了扱いにしない)
        this.plBackoffUntil = Date.now() + REC_403_COOLDOWN_MS;
        this.log('プレイリスト' + code + ' — アクセス制限の可能性。' +
          Math.round(REC_403_COOLDOWN_MS / 1000) + '秒待機して再確認します');
        if (this.accessMode === 'member') {
          // v1.8.0: 録画中の限定playlist 401/403 → key2/トークンを更新して再解決
          // (JWT短命化(約4分)・key2失効への追従。90秒節流でサーバーに優しく)
          if (Date.now() - (this.memberReResolveAt || 0) > 90000) {
            this.memberReResolveAt = Date.now();
            this.log('限定プレイリストが制限されました(' + code + ') — 鍵(key2)とトークンを更新して再解決します');
            try {
              _memberResolveCache.result = null; // キャッシュを無効化して強制再取得
              const r = await this._fResolveMember(this.id, (m) => this.log(m));
              if (r && r.ok) {
                this.memberPlaylist = r.playlist;
                this.consecutive404 = 0;
                this.plBackoffUntil = 0;
                this.log('限定配信を再解決(鍵更新) → 同じplaylistで録画を継続します');
              } else {
                this.log(this._fMemberHint(r));
              }
            } catch (e) { /* 解決失敗 → 次の節流で再試行 */ }
          }
          return;
        }
        // 限定配信(会員限定)の可能性: 自分のログイン会話で解決を試みる
        // (5分節流 — サーバーに優しく)
        if (Date.now() - this.memberResolveAt > 300000) {
          this.memberResolveAt = Date.now();
          try {
            const r = await this._fResolveMember(this.id, (m) => this.log(m));
            if (r && r.ok) {
              this.memberPlaylist = r.playlist;
              this.accessMode = 'member';
              this.consecutive404 = 0;
              this.log('限定配信を解決(key2認証) → このプレイリストで録画を継続します');
              this.plBackoffUntil = 0;
            } else {
              this.log(this._fMemberHint(r));
            }
          } catch (e) { /* 解決失敗 → 通常の退避継続 */ }
        }
        return;
      }
      if (saw429) {
        this.consecutive429++;
        /* v1.12.0: Retry-After優先(サーバー指定があれば指数バックオフの代わりに使う) */
        const ms = saw429RA ||
          Math.min(REC_429_BASE_MS * Math.pow(2, this.consecutive429 - 1), REC_429_MAX_MS);
        this.plBackoffUntil = Date.now() + ms;
        this.log('レート制限(429) — サーバー負荷配慮で' + Math.round(ms / 1000) + '秒待機します' +
          (saw429RA ? '(Retry-After指定)' : ''));
        return;
      }
      this.consecutive429 = 0;

      if (saw404) {
        this.consecutive404++;
        if (this.consecutive404 === 2) {
          this.log('プレイリスト404 — 配信終了/切替の可能性、確認中');
          // 基盤切替(BytePlus→IVS等)の可能性: 源の再探査を一度だけ試す
          try {
            const switched = await this.refreshLiveSource('404確認');
            if (switched && !this.stopped) {
              this.consecutive404 = 0;      // 新源で継続(配信終了ではない)
              this.pendingEnd = null;
              return;                        // 次tickで新源のplaylistを取りに行く
            }
          } catch (e) { /* 探査失敗 → 通常の終了判定へ */ }
        }
        const limit = this.follow() ? REC_404_STANDBY : REC_404_GIVE_UP;
        if (this.consecutive404 >= limit) this.pendingEnd = 'プレイリスト404×' + this.consecutive404;
        return;
      }
      this.consecutive404 = 0;
      if (txt == null) return;

      let parsed,queued;
      try{parsed=HLS.parse(txt,effBase,this.extinfMode(),this.inheritQuery());queued=HLS.enqueue(this,parsed,effBase);}
      catch(e){
        const code=String(e&&e.message||'');
        if(this.segTotal>0&&['HLS_BAD_PLAYLIST','HLS_BAD_TARGET','HLS_DANGLING_TAG','HLS_DANGLING_RANGE','HLS_BAD_EXTINF'].includes(code)){
          this._badPlaylistConsec=(this._badPlaylistConsec||0)+1;
          this._badPlaylistTotal=(this._badPlaylistTotal||0)+1;
          if(this._badPlaylistConsec<=2){
            this.log('プレイリスト一時破損('+code+') — 録画を中断せず次回ポーリングで再確認します('+this._badPlaylistConsec+'/2)');
            return;
          }
        }
        this.log('HLSを安全に処理できません: '+code);await this.stop(false);return;
      }
      if(this._badPlaylistConsec>0){this._badPlaylistRecovered=(this._badPlaylistRecovered||0)+1;this._badPlaylistConsec=0;}
      if(parsed.target>0)this.targetDur=parsed.target;
      const changed=this._playlistBody!==txt||this._playlistUri!==effBase;
      this._playlistBody=txt;this._playlistUri=effBase;
      if(this._lastMediaRequestUri===effBase)this.lastPollAt=this._lastMediaRequestStart;
      this.curPollMs=this.pollInterval(changed);this.lastMediaSeq=parsed.sequence;
      this.gapCount+=queued.missing;
      if(queued.added||queued.skipped)this.lastNewSegAt=Date.now();
      if(queued.added){const now=Date.now();if(this._lastSegAddedAt){this.segIntervalSum+=now-this._lastSegAddedAt;this.segIntervalN++;}this._lastSegAddedAt=now;}
      if(parsed.endList)this.pendingEnd='ENDLIST(正常終了)';
    }

    async drain() {
      // v1.10.0: キュー滞留の可視化(退避中などに肥大化したら警告・60秒節流)
      if (this.queue.length > 1500 && Date.now() - this._queueWarnAt > REC_QUEUE_WARN_MS) {
        this._queueWarnAt = Date.now();
        this.log('注意: 未取得セグメントのキューが' + this.queue.length + '件に滞留しています(退避/回線の可能性)');
      }
      while (this.queue.length && !this.stopped && this.state === 'RUN') {
        if (Date.now() < this.segBackoffUntil) return; // 403/429バックオフ中は静かに待機
        const item = this.queue.shift();
        const generation=this._hlsGeneration||0;
        const r = await this.fetchSeg(item);
        if (this.stopped || (this.rec && this.rec.stopped)) return;
        if (r.data) {
          if(!await HLS.append(this,item,r,generation))return;
          this.segCount++;
          this.segTotal++;
        }
        if (r.retry) {
          // 順序厳密保証: 再試行は必ずキュー先頭に戻し、後続を書かない
          // (旧実装の「末尾再キュー」は失敗中に後続segを先に書く順序反転の潜在バグがあった)
          if (item.tries < REC_SEG_MAX_TRIES) { this.queue.unshift(item); return; }
          HLS.noteTerminal(this,item);this.segFails++;
          this.log('セグメント取得断念(' + item.tries + '回): ...' + item.name.slice(-28));
        }
      }
    }

    /* セグメント1件取得。ステータスで挙動を厳密に分類(サーバー配慮):
       200=検証して返す / 404,410=廃棄済み→即断念(再試行しない) /
       403=アクセス制限→全体で60秒待機 / 429=レート制限→指数バックオフ /
       5xx・ネットワーク・タイムアウト=時間差で再試行 */
    async fetchSeg(item) { return recFetchDescriptor(this,item); }

    /* v1.10.0: TS検証(Worker並列・同期フォールバック) */
    async verifyTs(u8) {
      if (!this._verifier) this._verifier = createTsVerifier();
      return this._verifier.check(u8);
    }
    verifyStats() {
      return {
        usingWorker: this._verifier ? this._verifier.usingWorker() : false,
        checked: this.verifyChecked
      };
    }
    /* v1.10.0: メモリ統計(長時間録画の監視フック — window.__RSP.memStats) */
    memStats() {
      const heap = RECENV.perfHeap(); // v2.0 Step1: RECENV経由
      return {
        seen: this.seen.size, queue: this.queue.length,
        chunks: this.chunks.length, partBytes: this.bytes,
        bytesTotal: this.bytesTotal, partsLog: this.partsLog.length,
        jsHeapBytes: heap
      };
    }
    /* v1.10.0: 音声レンディション表示(選択variantのAUDIO groupを表示/JSONへ) */
    logAudioInfo() {
      try {
        const g = parseAudioGroups(this._masterTxt || '', this.masterUrl || '');
        const lab = this.selVariant ? audioLabelFor(this.selVariant.audioGroup, g) : '';
        this.audioTxt = lab || '';
        if (lab) this.log('音声: ' + lab);
      } catch (e) { /* 解析失敗は表示のみスキップ */ }
    }

    /* ---- 追跡待機: 次の配信を探す(20秒間隔・ジッタ付き) ---- */
    async standbyProbe() {
      this.lastStandbyAt = Date.now();
      // 1) 同一URLのプレイリストが生き返ったか(最優先・一番確実な信号)
      const cls = await this.probePlaylist();
      if (this.stopped || !this.recording || this.state !== 'STANDBY') return;
      if (cls === 'live') { await this.resume('ts', '配信の復帰を検出'); return; }
      if (this.urlMode()) return;
      // 基盤切替(旧源が死んで新基盤で再開する)の追従: 探査で新源が生きていれば切替
      if ((cls === 'offline') && Date.now() - (this._srcRefrAt || 0) > 60000) {
        try {
          if (await this.refreshLiveSource('待機中探査')) {
            this.lastMediaSeq = -1;
            await this.resume('ts', '配信基盤の切替を検出(新源で再開)');
            return;
          }
        } catch (e) { /* 次回再試行 */ }
      }
      if (cls === 'token' && this.accessMode !== 'member' && Date.now() - this.memberResolveAt > 180000) {
        // 403が続く → 限定配信が始まった可能性(次配信が会員限定のケース)
        this.memberResolveAt = Date.now();
        try {
          const r = await this._fResolveMember(this.id, (m) => this.log(m));
          if (this.stopped || !this.recording || this.state !== 'STANDBY') return;
          if (r && r.ok) {
            this.memberPlaylist = r.playlist;
            this.accessMode = 'member';
            this.sourceKind = 'member';
            await this.resume('ts', '限定配信(会員限定)の開始を検出');
            return;
          } else {
            this.log(this._fMemberHint(r));
          }
        } catch (e) { /* 次回再試行 */ }
      }

      // 2) RPLAY API(creatorOid基準) — プレイリスト公開より早く「live」を返すことがある
      const st = await this.apiStreamState();
      if (this.stopped || !this.recording || this.state !== 'STANDBY') return;
      if (st === 'live') {
        // APIはliveだがプレイリストは無し → 限定配信の可能性(会員 playlist は公開probeに映らない)
        // または基盤切替の可能性 → 先に源探査を試す(60秒節流)
        try {
          if (await this.refreshLiveSource('API検出')) {
            this.lastMediaSeq = -1;
            await this.resume('ts', 'API検出+配信基盤の切替に成功');
            return;
          }
        } catch (e) { /* 次の限定解決へ */ }
        if (this.accessMode !== 'member' && Date.now() - this.memberResolveAt > 180000) {
          this.memberResolveAt = Date.now();
          try {
            const r = await this._fResolveMember(this.id, (m) => this.log(m));
            if (this.stopped || !this.recording || this.state !== 'STANDBY') return;
            if (r && r.ok) {
              this.memberPlaylist = r.playlist;
              this.accessMode = 'member';
              this.sourceKind = 'member';
              await this.resume('ts', 'API検出+限定配信の解決に成功');
              return;
            } else {
              this.log(this._fMemberHint(r));
            }
          } catch (e) { /* 次回再試行 */ }
        }
        this.lastStandbyAt = 0; // 次のtick(3秒後)に再探索
        return;
      }

      // 2.5) 配信予約(v1.8.0): 予約時刻の接近/到来で通知と探索強化
      //      (live/schedulesはログイン会話が必要。未ログイン/404等は静かにスキップ)
      try {
        const item = await this._fResolveSched(this.id);
        if (this.stopped || !this.recording || this.state !== 'STANDBY') return;
        if (item) {
          this.schedItem = item;
          const remainMs = item.scheduledAt - Date.now();
          const hm = new Date(item.scheduledAt).toTimeString().slice(0, 5);
          const label = '📡 予約「' + (item.title || '無題') + '」' + hm + '開始予定';
          // v1.10.0: 開始前リマインド(10分前/5分前・設定で選択・試験フックで閾値短縮可)
          const mode = this.remindMode();
          const t10 = (function () { try { const v = Number(RECENV.testHooks().remind10Ms); return v > 0 ? v : REC_REMIND10_MS; } catch (e) { return REC_REMIND10_MS; } })();
          const t5 = (function () { try { const v = Number(RECENV.testHooks().remind5Ms); return v > 0 ? v : REC_REMIND5_MS; } catch (e) { return REC_REMIND5_MS; } })();
          if (remainMs > 0 && mode !== 'off' && (mode === 'both' || mode === '10') &&
              remainMs <= t10 && remainMs > t5 && !this.schedNotified10) {
            this.schedNotified10 = true;
            this.log(label + ' — リマインド(10分前): 残り' + Math.ceil(remainMs / 60000) + '分');
            this.notify('RPLAY録画 — 予約リマインド(10分前)', label + ' 残り' + Math.ceil(remainMs / 60000) + '分');
          }
          if (remainMs > 0) {
            const remainMin = Math.ceil(remainMs / 60000);
            const key = label + '#' + remainMin;
            if (remainMin <= 5 && key !== this.schedLastLog) {
              this.schedLastLog = key;
              this.log(label + ' — 残り' + remainMin + '分');
              // v1.10.0: リマインド設定(both/5)のとき5分前通知
              if (!this.schedNotified5 && (mode === 'both' || mode === '5')) {
                this.schedNotified5 = true;
                this.log(label + ' — リマインド(5分前): 残り' + remainMin + '分');
                this.notify('RPLAY録画 — 予約配信まもなく', label + '(残り' + remainMin + '分)');
              }
            }
          } else {
            if (this.schedNotifyAt !== item.scheduledAt) {
              this.schedNotifyAt = item.scheduledAt;
              this.notify('RPLAY録画 — 予約配信の開始時刻', label + ' — 探索を強化します');
              this.log(label + ' — 開始時刻を過ぎました。探索を強化します');
            }
            this.lastStandbyAt = 0; // 次のtick(3秒後)に即時探索 → 予約配信を素早く検出
          }
        }
      } catch (e) { /* 予約なし/取得失敗 → 何もしない */ }

      // 3) FLV代替(HLS系が全滅している間の受け皿)
      //    限定配信(会員限定)ではFLV代替は使えない(公開CDNのため403) → スキップ
      if (this.accessMode === 'member') return;
      if (this.flvFallback() && !this.flvRunning && Date.now() - this.flvLastFail > REC_FLV_COOLDOWN_MS) {
        await this.tryFlv();
      }
    }

    async resume(medium, why) {
      if (!this.recording || this.stopped) return;
      /* v2.39.0: 追跡再開(全開始経路のpolicy統一)。保存済み設定が自動開始を
         禁止しているときは再開せず追跡待機を続ける(追跡自体は止めない —
         許可に戻すと次の探索で再開する)。設定が読めない場合は再開しない
         (fail-closed — BG開始のSTART_SETTINGS_UNAVAILABLEと同じ安全側)。 */
      const _policy = (typeof RECENV.autoPolicy === 'function') ? await RECENV.autoPolicy() : { verdict: 'allowed' };
      if (this.stopped || !this.recording) return; /* 判定中に状態が変わった */
      if (_policy.verdict === 'denied') {
        if (this._autoDenyKey !== 'denied') {
          this._autoDenyKey = 'denied';
          this.log('保存済み設定により自動再開は禁止されています(追跡待機は継続 — 許可すると次の探索で再開)');
          this.notify('RPLAY録画 — 自動再開を禁止', '保存済み設定により自動再開を禁止しています(' + this.creatorName() + ')');
        }
        return;
      }
      if (_policy.verdict === 'unavailable') {
        if (this._autoDenyKey !== 'unavailable') {
          this._autoDenyKey = 'unavailable';
          this.log('開始設定を確認できないため自動再開しません(次の探索で再確認します)');
        }
        return;
      }
      this._autoDenyKey = '';
      HLS.reset(this, true); /* v2.5.0: 追跡再開は録画済みpath記録を保持(復帰windowの重複防止) */
      this.medium = medium;
      this.state = 'RUN';
      this.consecutive404 = 0;
      this.lastMediaSeq = -1;
      this.resetQualityState(); // v1.9.0: 新セッションの画質を取り直す
      if (this.audio) this.audio.onNewSession(); // v1.11.0: 音声も新セッション扱い(404等の最終停止を解除)
      this._skipBacklog = false; // 再開時は新セッションの内容を全て取得
      this.lastNewSegAt = Date.now();
      this.pendingEnd = null;
      this.resumes++;
      // Reauthorize this session before any member playlist request.
      if (this.accessMode === 'member' && medium === 'ts') {
        const generation=this._hlsGeneration||0;
        this.memberPlaylist='';
        try {
          const r=await this._fResolveMember(this.id,m=>this.log(m));
          if(!HLS.alive(this,generation))return;
          if(!r||!r.ok){this.log('再開時の視聴権限を確認できませんでした');await this.stop(false);return;}
          this.memberPlaylist=r.playlist;this.sourceKind='member';
        }catch(e){if(!this.stopped){this.log('再開の認証処理に失敗しました');await this.stop(false);}return;}
      }
      if(this.stopped)return;
      this.log(why + ' → 録画を再開(' + medium.toUpperCase() +
        (this.accessMode === 'member' ? ' / 限定配信' : '') +
        ' / セッション' + (this.resumes + 1) + ')');
      this.notify('RPLAY録画 — 再開', why + '(' + this.creatorName() + ')');
      this.persistSession();
      this.ui.recState(true, 'RUN', this.medium);
      if (medium === 'ts') {
        await this.pollPlaylist();
        await this.drain();
      }
    }

    /* 再生エンジンが先にLIVEを検出したときの即時復帰確認 */
    nudgeResume() {
      if (this.recording && this.state === 'STANDBY' && !this.busy) {
        this.log('再生側がLIVEを検出 → 録画復帰を即時確認');
        this.standbyProbe().catch(function () {});
      }
    }

    /* ---- FLV代替録画(fetchストリームを無劣化保存) ---- */
    tryFlv() {
      const self = this;
      return new Promise(function (resolve) {
        let settled = false;
        const done = function (ok) { if (!settled) { settled = true; resolve(!!ok); } };
        if (!self.recording || self.stopped || self.state !== 'STANDBY' || self.flvRunning) return done(false);
        if (self.urlMode()) return done(false); /* v2.40.0: FLV代替URLはRPLAY CDN固有 — URL録画では使わない */
        /* v2.39.0: FLV代替開始も共通policyに従う(拒否/不明なら開始しない) */
        const _policy = (typeof RECENV.autoPolicy === 'function') ? RECENV.autoPolicy() : Promise.resolve({ verdict: 'allowed' });
        _policy.then(function (p) {
          if (!self.recording || self.stopped || self.state !== 'STANDBY' || self.flvRunning) return done(false);
          if (p && p.verdict === 'denied') {
            if (self._autoDenyKey !== 'flv-denied') { self._autoDenyKey = 'flv-denied'; self.log('保存済み設定によりFLV代替の自動開始は禁止されています'); }
            return done(false);
          }
          if (!p || p.verdict !== 'allowed') {
            if (self._autoDenyKey !== 'flv-unavailable') { self._autoDenyKey = 'flv-unavailable'; self.log('開始設定を確認できないためFLV代替を開始しません'); }
            return done(false);
          }
          const ctl = new AbortController();
          self.flvAbort = ctl;
          self.flvGotData = false;
          self.flvRunning = true;
          self.medium = 'flv';
          self.log('HLS不通 → FLVストリームへ代替録画を試行…');
          fetch(self.flvUrl(), { cache: 'no-store', signal: ctl.signal }).then(function (res) {
          if (!res.ok || !res.body) throw new Error('HTTP ' + res.status);
          const reader = res.body.getReader();
          let head = new Uint8Array(0);
          let headerOk = false;
          function pump() {
            return reader.read().then(async function (r) {
              if (self.stopped || !self.recording) { try { reader.cancel(); } catch (e2) {} return done(true); }
              if (r.done) throw new Error('ストリーム終端');
              const u8 = r.value;
              if (!headerOk) {
                head = u8Concat(head, u8);
                if (head.length < 9) return pump();
                if (!(head[0] === 0x46 && head[1] === 0x4c && head[2] === 0x56)) throw new Error('FLVヘッダ不一致');
                headerOk = true;
                await self.pushData(head);
                head = null;
              } else {
                await self.pushData(u8);
              }
              self.lastNewSegAt = Date.now();
              if (!self.flvGotData) {
                self.flvGotData = true;
                self.state = 'RUN';
                self.fileStartedAt = Date.now();
                if (self.audio) self.audio.onFlvStart(); // v1.11.0: FLVは音声多重 → 音声個別録画は停止
                self.log('FLV受信を確認 — FLV無劣化のまま録画を継続します');
                self.ui.recState(true, 'RUN', 'flv');
                done(true); // Promiseを解決するのみ(受信ループは継続)
              }
              return pump();
            });
          }
          pump().catch(function (e) { self.flvFailed(e, done); });
        }).catch(function (e) { self.flvFailed(e, done); });
        }).catch(function () { done(false); }); /* policy問い合わせ自体の失敗は開始しない */
      });
    }

    flvFailed(e, done) {
      const had = this.flvGotData;
      const tiny = had && this.bytes > 0 && this.bytes < 512 * 1024; // すぐ切れた小さな断片は頻発防止のため猶予
      this.flvRunning = false;
      this.flvGotData = false;
      if (this.flvAbort) { try { this.flvAbort.abort(); } catch (e2) {} this.flvAbort = null; }
      if (had) this.closePart();
      this.medium = 'ts';
      this.flvLastFail = Date.now() + (tiny ? 90000 : 0);
      if (this.recording && !this.stopped && this.state === 'RUN') {
        this.state = 'STANDBY';
        this.standbySince = Date.now();
        this.ui.recState(true, 'STANDBY', 'ts');
        this.log('FLV切断(' + (e && e.message || e) + ') → 追跡待機へ戻る');
      }
      if (done) done(had);
    }

    abortFlv() {
      if (this.flvAbort) { try { this.flvAbort.abort(); } catch (e) {} this.flvAbort = null; }
      this.flvRunning = false;
    }

    /* ---- 保存先フォルダ(File System Access API) ---- */
    async pickFolder() {
      if (this.dirHandle) {
        this.dirHandle = null;
        this.dirLabel = '';
        return null; // 解除
      }
      if (!window.showDirectoryPicker) {
        throw new Error('このブラウザは保存先フォルダ機能に非対応です(Chrome/Edge推奨)');
      }
      const dh = await window.showDirectoryPicker({ mode: 'readwrite' });
      this.dirHandle = dh;
      this.dirLabel = dh.name || 'folder';
      return this.dirLabel;
    }

    /* ---- 統計 / タイトル ---- */
    stats() {
      return {
        recording: this.recording,
        state: this.state,
        medium: this.medium,
        elapsedMs: this.recording ? Date.now() - this.startedAt : 0,
        standbyMs: this.state === 'STANDBY' ? Date.now() - this.standbySince : 0,
        partMb: this.bytes / 1048576,
        totalMb: this.bytesTotal / 1048576,
        seg: this.segCount,
        total: this.segTotal,
        speedMBs: this.speedMBs(),
        fails: this.segFails,
        gap: this.gapCount,
        files: this.filesSaved, saveRequests:this.saveRequests||0, failedSaves:this.failedSaves||0,
        filesTs: this.filesByExt.ts || 0,
        filesFlv: this.filesByExt.flv || 0,
        pending: this.queue.length,
        part: this.partIndex + (this.partOpen ? 1 : 0),
        resumes: this.resumes,
        schedMs: (this.schedItem && this.schedItem.scheduledAt > Date.now())
          ? this.schedItem.scheduledAt - Date.now() : 0,
        schedTitle: this.schedItem ? this.schedItem.title : '',
        quality: this.qualityTxt || '',
        audio: this.audioTxt || '',          // v1.10.0
        audioRec: this.audio ? this.audio.running : false, // v1.11.0: 音声併録中はREC表示に+audio
        audioSt: this.audio ? this.audio.stats() : null,   // v1.11.0: 音声録画の詳細統計
        pollCount: this.pollCount,           // v1.10.0
        sourceSwitches: this.sourceSwitches, // v1.10.0
        qualityFallbacks: this.qualityFallbacks, // v1.10.0
        verify: this.verifyStats()           // v1.10.0
      };
    }

    /* 直近約30秒の平均転送速度(MB/s) */
    speedMBs() {
      const sp = this._spd;
      if (sp.length < 2) return 0;
      const a = sp[0], b = sp[sp.length - 1];
      const dt = (b[0] - a[0]) / 1000;
      if (dt <= 0) return 0;
      return Math.max(0, (b[1] - a[1]) / 1048576 / dt);
    }

    updateTitle(force) {
      if (!this.recording) return;
      const min = Math.floor((Date.now() - this.startedAt) / 60000);
      if (force || min !== this._titleMin) {
        this._titleMin = min;
        try {
          if (this._titleBase == null) this._titleBase = RECENV.getTitle();
          const tag = (this.state === 'STANDBY') ? '⏸追跡中' : '●REC';
          RECENV.setTitle(tag + ' ' + fmtDur(Date.now() - this.startedAt) + ' - ' + this._titleBase);
        } catch (e) {}
      }
    }

    restoreTitle() {
      const base = this._titleBase;
      if (base != null) RECENV.setTitle(base); // v2.0 Step1: RECENV経由
      this._titleBase = null;
      this._titleMin = -1;
    }
  }
  /* ==== RSP RECORDING CORE — v2.0 Step1 切出し(END) ==== */

  /* ================= VodDl: 動画(/play/<id>)のダウンロード =================
   「視聴権限のある自分の会話」でのみ動作する無劣化DL:
    ① content API でメタデータ+視聴可能m3u8を取得(DRM保護は明確に拒否)
    ② master playlist → 最高帯域variant → media playlist を解決
    ③ AES-128暗号化HLSは、権限のある会話で鍵を取得しWebCryptoで復号
    ④ セグメントを並列取得(順序厳密書込・403/429退避・要求間隔下限)
    ⑤ 保存: フォルダ直書き(FS Access API)またはメモリ→容量分割ダウンロード
   認証の回避は行わない(権限が無ければ403で明示して終了)。 */
  const VOD_PARALLEL = 3;              // 同時取得数(控えめにしてCDNに配慮)
  const VOD_REQ_MIN_GAP_MS = 400;      // 要求開始間隔の下限
  const VOD_SEG_TIMEOUT_MS = 30000;
  const VOD_SEG_MAX_TRIES = 6;
  const VOD_429_BASE_MS = 30000;
  const VOD_429_MAX_MS = 300000;
  const VOD_403_COOLDOWN_MS = 60000;

  class VodDl {
    constructor(oid, ui) {
      this.oid = oid;
      this.ui = ui;
      this.running = false;
      this.cancelled = false;
      this.title = '';
      this.creator = '';
      this.m3u8Url = '';
      this.segs = [];            // [{url, key: Uint8Array|null, iv: Uint8Array|null}]
      this.bytesTotal = 0;
      this.segDone = 0;
      this.segFails = 0;
      this.startedAt = 0;
      this.finishedAt = 0;
      this.writer = null;
      this.chunks = [];
      this.bytes = 0;
      this.partIndex = 0;
      this.dirHandle = null;
      this.dirLabel = '';
      this._lastReqAt = 0;
      this._abort = null;
      this._writeChain = Promise.resolve();
      this._buf = new Map();
      this._writeIdx = 0;
      this._spd = [];
      this.backoffUntil = 0;
    }
    log(m) { this.ui.log('[VOD] ' + m); }
    progress() {
      return {
        running: this.running, title: this.title, segDone: this.segDone,
        segAll: this.segs.length, bytes: this.bytesTotal, fails: this.segFails,
        mbps: this.speedMbps(), encrypted: this.anyEncrypted
      };
    }
    speedMbps() {
      const now = Date.now();
      this._spd = this._spd.filter(p => now - p.t < 5000);
      if (this._spd.length < 2) return 0;
      const dt = (this._spd[this._spd.length - 1].t - this._spd[0].t) / 1000;
      const db = this._spd[this._spd.length - 1].b - this._spd[0].b;
      return dt > 0 ? (db / dt / 1048576) : 0;
    }

    /* ---- ①メタデータ取得(DRM/権限の明確な判定) ---- */
    async fetchInfo() {
      RspAuth.probe();
      const q = new URLSearchParams({
        contentOid: this.oid, status: 'published',
        withComments: 'false', requestCanView: 'true'
      });
      for (const k in RspAuth.requestorQuery()) q.set(k, RspAuth.requestorQuery()[k]);
      const r = await fetchJsonWithRetry(API_BASE + '/content?' + q.toString(), RspAuth.jwtHeaders(), 10000);
      if (!r.ok) {
        if (r.status === 401 || r.status === 403) throw new Error('コンテンツ情報APIが' + r.status + ' — ログイン会話が無効の可能性(ページ再読込で更新されます)');
        throw new Error('コンテンツ情報APIが' + (r.status || 'ネットワークエラー') + ' — しばらくして再試行してください');
      }
      const info = r.json || {};
      this.title = info.title || ('動画_' + this.oid);
      this.creator = (info.creatorInfo && info.creatorInfo.nickname) || '';
      if (info.drm) throw new Error('この動画はDRM保護されています — ダウンロードには対応していません');
      const m3u8 = info.canView && info.canView.url;
      if (!m3u8) {
        const free = info.viewableTiers && info.viewableTiers.free;
        throw new Error(free
          ? 'この動画は無料プラン加入限定です。プランに加入するとダウンロードできます'
          : 'この動画への視聴権限がありません(購入/プラン加入が必要) — 権限が無い動画は取得しません');
      }
      // 相対パスが来ても絶対URLに正規化(new URLのbase要件)
      this.m3u8Url = new URL(m3u8, location.href).href;
      this.info = info;
      return info;
    }

    /* ---- ②プレイリスト解決(master→variant→media) ---- */
    async fetchPlaylistText(url) {
      const butter = await butterToken();
      for (let a = 0; a < 3; a++) {
        if(this.cancelled)throw Error('VOD_CANCELLED');
        try {
          const transfer=HLS.createTransfer(fetch,15000);this._playlistTransfer=transfer;
          let res;
          try{res=await transfer.request({uri:url,butter:butter||undefined},2*1048576);}
          finally{transfer.abort();if(this._playlistTransfer===transfer)this._playlistTransfer=null;}
          if(this.cancelled)throw Error('VOD_CANCELLED');
          if(res.error)throw Error(res.error);
          if(res.status===200){const text=new TextDecoder('utf-8',{fatal:true}).decode(res.bytes);if(!/^\uFEFF?#EXTM3U(?:\r?\n|$)/.test(text))throw Error('VOD_BAD_PLAYLIST');return text;}
          if (res.status === 401) throw Error('VOD_AUTH_401');
          if (res.status === 403) throw new Error('プレイリストが403 — 視聴権限が反映されていない可能性(ページ再読込/プラン加入を確認)');
          if (res.status === 404 || res.status === 410) throw new Error('プレイリストが存在しません(削除済み/非公開)');
          if (res.status === 429) {
            const ms = Math.min(VOD_429_BASE_MS * Math.pow(2, a), VOD_429_MAX_MS);
            this.log('レート制限(429) — ' + Math.round(ms / 1000) + '秒待機します');
            await this.waitPlaylistRetry(ms);
            continue;
          }
          await this.waitPlaylistRetry(1000 * (a + 1));
        } catch (e) {
          if (e && /403|VOD_AUTH_401|存在しません|VOD_CANCELLED|VOD_BAD_PLAYLIST|HLS_BODY_LIMIT/.test(e.message)) throw e;
          if (a === 2) throw new Error('プレイリスト取得に失敗: ' + (e && e.message ? e.message : e));
        }
      }
      throw new Error('プレイリスト取得に失敗(リトライ上限)');
    }

    waitPlaylistRetry(ms) {
      if(this.cancelled)return Promise.reject(Error('VOD_CANCELLED'));
      return new Promise((resolve,reject)=>{
        const finish=cancelled=>{clearTimeout(timer);if(this._retryCancel===cancel)this._retryCancel=null;cancelled?reject(Error('VOD_CANCELLED')):resolve();};
        const cancel=()=>finish(true),timer=setTimeout(()=>finish(false),ms);
        this._retryCancel=cancel;
      });
    }

    async resolvePlaylist() {
      let url = this.m3u8Url;
      let txt = await this.fetchPlaylistText(url);
      // master playlistなら最高画質のvariantを選ぶ(v1.9.0: 解像度→fps→帯域)
      if (txt.indexOf('#EXT-X-STREAM-INF') >= 0) {
        const vars = parseVariants(txt, url);
        const best = vars.length ? pickBestVariant(vars) : null;
        if (!best) throw new Error('master playlistにvariantがありません');
        url = best.url;
        this.log('画質: ' + qualityLabel(best) + ' を選択' + (vars.length > 1 ? '(最高・候補' + vars.length + '件: ' + vars.map(function (v) { return qualityLabel(v); }).join(' / ') + ')' : '') + ' — ' + url.slice(0, 80) + '…');
        txt = await this.fetchPlaylistText(url);
      }
      this.m3u8Url = url;

      // media playlist解析(セグメント+鍵+IV)
      const lines = txt.split('\n');
      let mediaSeq = 0;
      let curKey = null;           // {uri, ivHex}
      const keyUris = [];
      const segs = [];
      for (let i = 0; i < lines.length; i++) {
        const s = lines[i].trim();
        if (s.indexOf('#EXT-X-MEDIA-SEQUENCE:') === 0) mediaSeq = parseInt(s.slice(22), 10) || 0;
        else if (s.indexOf('#EXT-X-KEY:') === 0) {
          const method = (s.match(/METHOD=([A-Z0-9-]+)/) || [])[1] || 'NONE';
          if (method === 'NONE') { curKey = null; continue; }
          const uri = (s.match(/URI="([^"]+)"/) || [])[1];
          const ivHex = (s.match(/IV=0[xX]([0-9a-fA-F]+)/) || [])[1];
          if (!uri) throw new Error('EXT-X-KEYにURIがありません(METHOD=' + method + ')');
          curKey = { uri: new URL(uri, url).href, ivHex: ivHex || null, seqOfRef: mediaSeq + segs.length };
          if (keyUris.indexOf(curKey.uri) < 0) keyUris.push(curKey.uri);
        } else if (s && s.charAt(0) !== '#') { // HLS仕様: 非コメント行はすべてセグメントURI
          segs.push({ url: new URL(s, url).href, key: curKey, ivHex: curKey ? curKey.ivHex : null, seq: mediaSeq + segs.length });
        }
      }
      if (!segs.length) throw new Error('プレイリストにセグメントがありません');
      this.anyEncrypted = keyUris.length > 0;
      this.segs = segs;

      // 鍵の取得(視聴権限のある会話でのみサーバーが応答する)
      if (keyUris.length) {
        this.keys = {};
        for (const ku of keyUris) {
          const key16 = await this.fetchKey(ku);
          if (!key16) throw new Error('復号鍵を取得できませんでした(権限が無いか通信エラー) — 権限が無い動画は取得しません');
          this.keys[ku] = key16;
        }
      }
      this.log('セグメント' + segs.length + '件を解決' + (keyUris.length ? '(AES-128暗号化 — 鍵' + keyUris.length + '本を取得済み)' : '(暗号化なし)'));
    }

    async fetchKey(keyUri) {
      // RPLAYの非公開コンテンツ鍵は要求者を示すヘッダが必要(公式プレイヤーと同一)
      // + ageヘッダ(公式フロントエンドが乱数で付与するアンチボット署名、1〜4999)
      const headers = {
        'rplay-private-content-requestor': RspAuth.userOid || 'not-logged-in',
        'age': String(1 + Math.floor(Math.random() * 4999))
      };
      for (let a = 0; a < 3; a++) {
        try {
          const ctl = new AbortController();
          const to = setTimeout(() => ctl.abort(), 15000);
          const res = await fetch(keyUri, { cache: 'no-store', headers: headers, signal: ctl.signal });
          clearTimeout(to);
          if (res.status === 200) {
            const u8 = new Uint8Array(await res.arrayBuffer());
            if (u8.length !== 16) { this.log('鍵の長さが異常(' + u8.length + 'B)'); return null; }
            return u8;
          }
          if (res.status === 403) { this.log('鍵リクエストが403 — この動画への視聴権限がありません'); return null; }
          if (res.status === 429) {
            const ms = Math.min(VOD_429_BASE_MS * Math.pow(2, a), VOD_429_MAX_MS);
            this.log('レート制限(429) — ' + Math.round(ms / 1000) + '秒待機します');
            await new Promise(r2 => setTimeout(r2, ms));
            continue;
          }
          await new Promise(r2 => setTimeout(r2, 1000 * (a + 1)));
        } catch (e) { if (a === 2) return null; }
      }
      return null;
    }

    ivFor(seg) {
      if (seg.ivHex) {
        const clean = seg.ivHex.length % 2 ? '0' + seg.ivHex : seg.ivHex;
        const bytes = new Uint8Array(16);
        const off = 16 - clean.length / 2;
        for (let i = 0; i < clean.length / 2; i++) bytes[off + i] = parseInt(clean.substr(i * 2, 2), 16);
        return bytes;
      }
      // IV属性が無い場合はメディアシーケンス番号(64bit big-endian)
      const bytes = new Uint8Array(16);
      const seq = seg.seq || 0;
      const hi = Math.floor(seq / 4294967296), lo = seq >>> 0;
      bytes[8] = (hi >>> 24) & 255; bytes[9] = (hi >>> 16) & 255; bytes[10] = (hi >>> 8) & 255; bytes[11] = hi & 255;
      bytes[12] = (lo >>> 24) & 255; bytes[13] = (lo >>> 16) & 255; bytes[14] = (lo >>> 8) & 255; bytes[15] = lo & 255;
      return bytes;
    }

    async decryptSeg(data, seg) {
      const key16 = seg.key ? this.keys[seg.key.uri] : null;
      if (!key16) return data;
      /* v2.37.0(N-01): cat-catch lib/m3u8-decrypt.js系譜のソフトウェアAES-128-CBCフォールバック。
         crypto.subtleが利用不可の環境(非セキュアコンテキスト等)や、WebCryptoがOperationErrorで
         拒否した場合も、決定的なAES-CBC仕様によりWebCryptoとバイト一致の復号を行う。
         フォールバック実施状況はaesFallbackEvidenceとして情報JSONへ出力する。 */
      const fb = this._aesFallback || (this._aesFallback = { attempts: 0, webcryptoOk: 0, softwareSuccesses: 0, softwareFailures: 0, lastReason: null });
      fb.attempts++;
      const subtle = (typeof crypto !== 'undefined' && crypto && crypto.subtle) ? crypto.subtle : null;
      if (subtle) {
        try {
          const k = await subtle.importKey('raw', key16, { name: 'AES-CBC' }, false, ['decrypt']);
          const plain = new Uint8Array(await subtle.decrypt({ name: 'AES-CBC', iv: this.ivFor(seg) }, k, data));
          fb.webcryptoOk++;
          return plain;
        } catch (e) {
          fb.lastReason = 'webcrypto:' + ((e && e.name) || 'error'); // OperationError等
        }
      } else {
        fb.lastReason = 'webcrypto:unavailable'; // 非セキュアコンテキスト等
      }
      try {
        const plain = HLS.decryptCbc(key16, this.ivFor(seg), data); // PKCS7厳密除去込み
        fb.softwareSuccesses++;
        this.log('WebCrypto経由不可(' + (fb.lastReason || 'unknown') + ') — ソフトウェアAES-128で復号(seq=' + seg.seq + ')');
        return plain;
      } catch (e2) {
        fb.softwareFailures++;
        fb.lastReason = 'software:' + ((e2 && e2.message) || e2);
        this.log('復号失敗(seq=' + seg.seq + '): ' + (e2 && e2.message ? e2.message.slice(0, 60) : e2));
        return null;
      }
    }

    /* ---- ③セグメント取得(厳密分類・並列は呼び出し側で制御) ---- */
    async fetchSeg(seg, idx) {
      for (let tries = 0; tries < VOD_SEG_MAX_TRIES && !this.cancelled; tries++) {
        if (Date.now() < this.backoffUntil) await new Promise(r => setTimeout(r, this.backoffUntil - Date.now()));
        const gap = VOD_REQ_MIN_GAP_MS - (Date.now() - this._lastReqAt);
        if (gap > 0) await new Promise(r => setTimeout(r, gap));
        this._lastReqAt = Date.now();
        try {
          const ctl = new AbortController();
          this._abort = ctl;
          const to = setTimeout(() => ctl.abort(), VOD_SEG_TIMEOUT_MS);
          const res = await fetch(seg.url, { cache: 'no-store', signal: ctl.signal });
          clearTimeout(to);
          if (res.status === 200) {
            const u8 = new Uint8Array(await res.arrayBuffer());
            this._spd.push({ t: Date.now(), b: this.bytesTotal + u8.length });
            if (u8.length < 4) { this.segFails++; return null; }
            if (!seg.key && u8[0] !== 0x47) { // 平文TSのみ同期バイト検証(暗号は復号後に検証)
              this.segFails++;
              this.log('不正セグメント(同期バイト不一致): seg' + idx);
              return null;
            }
            return u8;
          }
          if (res.status === 403) {
            this.backoffUntil = Date.now() + VOD_403_COOLDOWN_MS;
            this.log('セグメント403 — ' + Math.round(VOD_403_COOLDOWN_MS / 1000) + '秒待機して再試行(' + (tries + 1) + '/' + VOD_SEG_MAX_TRIES + ')');
          } else if (res.status === 429) {
            const ms = Math.min(VOD_429_BASE_MS * Math.pow(2, tries), VOD_429_MAX_MS);
            this.backoffUntil = Date.now() + ms;
            this.log('レート制限(429) — ' + Math.round(ms / 1000) + '秒待機します');
          } else if (res.status === 404 || res.status === 410) {
            this.segFails++;
            this.log('セグメントが存在しません(404): seg' + idx);
            return null;
          } else {
            await new Promise(r => setTimeout(r, 1000 * (tries + 1))); // 5xx等
          }
        } catch (e) { /* ネットワーク/タイムアウト → 再試行 */ }
      }
      if (!this.cancelled) { this.segFails++; this.log('セグメント取得断念: seg' + idx); }
      return null;
    }

    /* ---- ④順序厳密書込(完了したものから連続して書く) ---- */
    enqueueDone(idx, data) {
      this._buf.set(idx, data);
      this._writeChain = this._writeChain.then(() => this.drainBuffer()).catch(() => {});
    }
    async drainBuffer() {
      while (this._buf.has(this._writeIdx)) {
        const d = this._buf.get(this._writeIdx);
        this._buf.delete(this._writeIdx);
        await this.pushData(d);
        this._writeIdx++;
        this.segDone++;
      }
    }
    async pushData(u8) {
      this.bytesTotal += u8.length;
      if (this.dirHandle && typeof this.dirHandle.createWritable === 'function') {
        if (!this.writer) await this.openPart();
        await this.writer.write(u8);
        this.bytes += u8.length;
        if (this.bytes >= REC_FILE_CAP_BYTES) await this.closePart();
      } else {
        if (this.bytes > 0 && this.bytes + u8.length > REC_FILE_CAP_BYTES) this.closePart();
        this.chunks.push(u8);
        this.bytes += u8.length;
      }
    }
    async openPart() {
      this.partIndex++;
      const name = 'RPLAY_VOD_' + safeName(this.title) + '_' + stampNow() + '_p' + this.partIndex + '.ts';
      try {
        const fh = await this.dirHandle.getFileHandle(name, { create: true });
        this.writer = await fh.createWritable();
        this.partName = name;
        this.log('パート' + this.partIndex + 'をフォルダへ書き込み開始: ' + name);
      } catch (e) {
        this.log('フォルダ書き込みを開始できず(' + e.message + ') — メモリ保存へ切替');
        this.dirHandle = null;
      }
    }
    closePart() {
      if (this.writer) {
        try { const w = this.writer; this.writer = null; w.close(); } catch (e) {}
      } else if (this.chunks.length && this.bytes > 0) {
        const blob = new Blob(this.chunks, { type: 'video/mp2t' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = 'RPLAY_VOD_' + safeName(this.title) + '_' + stampNow() + '_p' + (this.partIndex + 1) + '.ts';
        document.body.appendChild(a); a.click();
        rspDelayedBlobRelease(a.href, a, blob.size); // v2.9.1(B-01): 遅延解放契約
        this.partIndex++;
        this.log('パート' + this.partIndex + 'を保存(' + (this.bytes / 1048576).toFixed(1) + 'MB)');
        this.chunks = [];
      }
      this.bytes = 0;
    }

    /* ---- ⑤メイン ---- */
    async run() {
      if (this.running) return;
      this.running = true;
      this.cancelled = false;
      this.startedAt = Date.now();
      this.segDone = 0; this.segFails = 0; this.bytesTotal = 0;
      this._buf.clear(); this._writeIdx = 0; this._writeChain = Promise.resolve();
      try {
        this.log('動画情報を取得中… (' + this.oid + ')');
        await this.fetchInfo();
        this.log('「' + this.title + '」' + (this.creator ? ' / ' + this.creator : '') +
          (this.info && this.info.isReplayContent ? '(配信アーカイブ)' : ''));
        this.ui.vodMeta(this);
        await this.resolvePlaylist();
        this.ui.vodMeta(this);
        // 保存先の確認(フォルダ指定があればそれを使う)
        if (current && current.recorder && current.recorder.dirHandle) {
          this.dirHandle = current.recorder.dirHandle;
          this.dirLabel = current.recorder.dirLabel;
          this.log('録画と同じ保存先フォルダを使用: ' + this.dirLabel);
        }
        this.log('ダウンロード開始 — ' + this.segs.length + 'seg / 並列' + VOD_PARALLEL + ' / 間隔下限' + VOD_REQ_MIN_GAP_MS + 'ms');
        let cursor = 0;
        const self = this;
        const worker = async function () {
          while (!self.cancelled) {
            const i = cursor++;
            if (i >= self.segs.length) return;
            const seg = self.segs[i];
            let data = await self.fetchSeg(seg, i);
            if (self.cancelled) return;
            if (data && seg.key) {
              data = await self.decryptSeg(data, seg);
              if (data && data[0] !== 0x47) {
                self.segFails++;
                self.log('復号後のセグメントが不正(TS同期バイト不一致): seg' + i);
                data = null;
              }
            }
            if (data) self.enqueueDone(i, data);
          }
        };
        const workers = [];
        for (let w = 0; w < VOD_PARALLEL; w++) workers.push(worker());
        await Promise.all(workers);
        await this._writeChain;
        if (this.cancelled) {
          this.log('ダウンロードを中止しました(取得済み分を保存します)');
        }
        this.closePart();
        this.finishedAt = Date.now();
        this.saveInfoJson();
        const miss = this.segDone < this.segs.length ? '(未取得' + (this.segs.length - this.segDone) + 'seg)' : '';
        this.log('完了 — ' + this.segDone + '/' + this.segs.length + 'seg / ' +
          (this.bytesTotal / 1048576).toFixed(1) + 'MB / ' +
          fmtDur(this.finishedAt - this.startedAt) + miss +
          (this.segFails ? ' / 失敗' + this.segFails : ''));
        if (!this.anyEncrypted && this.segDone > 0) {
          this.log('変換例(ffmpeg): ffmpeg -i "入力.ts" -c copy "出力.mp4"');
        }
      } catch (e) {
        this.log('エラー: ' + (e && e.message ? e.message : e));
        this.log('※ 視聴権限の無い動画の取得は行わない設計です(プラン加入/購入で見られるようになります)');
      } finally {
        this.running = false;
        this.ui.vodMeta(this);
      }
    }
    saveInfoJson() {
      const info = {
        tool: 'RPLAY Stable Player v1.6.0 (VOD DL)',
        contentOid: this.oid,
        title: this.title,
        creator: this.creator,
        playlist: this.m3u8Url,
        encryptedHls: !!this.anyEncrypted,
        startedAt: new Date(this.startedAt).toISOString(),
        finishedAt: new Date(this.finishedAt || Date.now()).toISOString(),
        durationSec: Math.round(((this.finishedAt || Date.now()) - this.startedAt) / 1000),
        totalBytes: this.bytesTotal,
        segments: this.segDone,
        segmentsAll: this.segs.length,
        failed: this.segFails,
        parts: this.partIndex
      };
      try {
        const blob = new Blob([JSON.stringify(info, null, 2)], { type: 'application/json' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = 'RPLAY_VOD_' + safeName(this.title) + '_info.json';
        document.body.appendChild(a); a.click();
        rspDelayedBlobRelease(a.href, a, blob.size); // v2.9.1(B-01): 遅延解放契約
      } catch (e) {}
    }
    cancel() {
      if (!this.running) return;
      this.cancelled = true;
      if(this._retryCancel)this._retryCancel();
      if(this._playlistTransfer)this._playlistTransfer.abort();
      try { if (this._abort) this._abort.abort(); } catch (e) {}
      this.log('中止を要求しました…');
    }
  }

  /* ---- 公式プレイヤー停止(帯域二重消費の防止) ---- */
  function stopOfficialPlayers(ui) {
    let n = 0;
    document.querySelectorAll('video').forEach(function (v) {
      if (v === ui.video || v.getAttribute('data-rsp') === '1') return;
      try { v.pause(); v.muted = true; n++; } catch (e) {}
    });
    return n;
  }

  /* ================= UI ================= */
  const CSS = [
    // v1.10.0: 配色をCSS変数化(ダーク既定+ライトテーマ。data-theme属性で上書き)
    '#rsp-panel{--rsp-bg:#14171c;--rsp-bg2:#1a1f27;--rsp-fg:#e8eaed;--rsp-muted:#8b93a0;--rsp-auto:#aeb4bf;',
    '--rsp-border:#2a2f39;--rsp-border2:#232833;--rsp-btnbg:#242a34;--rsp-btnborder:#333b47;--rsp-btnhov:#2e3642;',
    '--rsp-inputbg:#0f1216;--rsp-logc:#7f8794;--rsp-chipbg:#3a3f4a;--rsp-chipfg:#aab2bd;',
    '--rsp-qbg:#1d2330;--rsp-qfg:#dfe6f3;--rsp-qborder:#2a3347;',
    'position:fixed;right:16px;bottom:16px;width:400px;max-width:calc(100vw - 24px);z-index:2147483646;',
    'background:var(--rsp-bg);color:var(--rsp-fg);border:1px solid var(--rsp-border);border-radius:14px;',
    'box-shadow:0 12px 40px rgba(0,0,0,.55);overflow:hidden;',
    'font:12px/1.5 -apple-system,"Segoe UI","Hiragino Kaku Gothic ProN","Noto Sans JP",Meiryo,sans-serif;}',
    // ライトテーマ(手動設定)
    '#rsp-panel[data-theme="light"]{--rsp-bg:#ffffff;--rsp-bg2:#f2f4f8;--rsp-fg:#1c2128;--rsp-muted:#5b6472;--rsp-auto:#4a5260;',
    '--rsp-border:#d5dae2;--rsp-border2:#e3e7ee;--rsp-btnbg:#eef1f6;--rsp-btnborder:#ccd3dd;--rsp-btnhov:#e2e7ef;',
    '--rsp-inputbg:#f7f9fc;--rsp-logc:#5f6874;--rsp-chipbg:#dde2ea;--rsp-chipfg:#4a5260;',
    '--rsp-qbg:#eef1f6;--rsp-qfg:#1c2128;--rsp-qborder:#ccd3dd;box-shadow:0 12px 40px rgba(30,40,60,.22);}',
    // ライトテーマ(OS追従: prefers-color-scheme)
    '@media (prefers-color-scheme: light){#rsp-panel[data-theme="auto"]{--rsp-bg:#ffffff;--rsp-bg2:#f2f4f8;--rsp-fg:#1c2128;--rsp-muted:#5b6472;--rsp-auto:#4a5260;',
    '--rsp-border:#d5dae2;--rsp-border2:#e3e7ee;--rsp-btnbg:#eef1f6;--rsp-btnborder:#ccd3dd;--rsp-btnhov:#e2e7ef;',
    '--rsp-inputbg:#f7f9fc;--rsp-logc:#5f6874;--rsp-chipbg:#dde2ea;--rsp-chipfg:#4a5260;',
    '--rsp-qbg:#eef1f6;--rsp-qfg:#1c2128;--rsp-qborder:#ccd3dd;box-shadow:0 12px 40px rgba(30,40,60,.22);}}',
    '#rsp-panel.rsp-min{width:220px;}',
    '#rsp-panel.rsp-min .rsp-body{display:none;}',
    '.rsp-head{display:flex;align-items:center;gap:8px;padding:8px 10px;background:var(--rsp-bg2);user-select:none;}',
    '.rsp-recdot{width:9px;height:9px;border-radius:50%;background:#ff3c6e;display:none;flex:none;}',
    '.rsp-recdot.on{display:inline-block;box-shadow:0 0 7px #ff3c6e;animation:rspPulse 1.2s infinite;}',
    '.rsp-recdot.sb{display:inline-block;background:#ffb84d;box-shadow:0 0 7px #ffb84d;animation:rspPulse 2s infinite;}',
    '.rsp-qsel{background:var(--rsp-qbg);color:var(--rsp-qfg);border:1px solid var(--rsp-qborder);border-radius:8px;height:26px;padding:0 4px;max-width:118px;font-size:11px;flex:none;cursor:pointer;}',
    '@keyframes rspPulse{0%,100%{opacity:1}50%{opacity:.3}}',
    '.rsp-badge{font-weight:700;font-size:10px;padding:2px 8px;border-radius:99px;background:var(--rsp-chipbg);color:var(--rsp-chipfg);letter-spacing:.5px;white-space:nowrap;}',
    '.rsp-badge.live{background:#1d3b2a;color:#3ddc84;}',
    '.rsp-badge.warn{background:#3b2f1d;color:#ffb84d;}',
    '.rsp-badge.err{background:#3b1d24;color:#ff5c7a;}',
    '.rsp-title{font-weight:700;font-size:12px;flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}',
    '.rsp-minbtn{background:var(--rsp-btnbg);color:var(--rsp-fg);border:none;border-radius:6px;width:22px;height:22px;cursor:pointer;font-size:12px;line-height:1;}',
    '.rsp-minbtn:hover{background:var(--rsp-btnhov);}',
    '.rsp-stage{position:relative;background:#000;aspect-ratio:16/9;}',
    '.rsp-stage video{width:100%;height:100%;display:block;background:#000;object-fit:contain;}',
    '.rsp-stage:fullscreen{aspect-ratio:auto;}',
    '.rsp-cover{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;',
    'background:rgba(0,0,0,.6);color:#cfd3da;text-align:center;padding:12px;white-space:pre-line;font-size:12.5px;}',
    '.rsp-pill{position:absolute;left:50%;bottom:10px;transform:translateX(-50%);display:none;',
    'background:rgba(0,0,0,.72);border:1px solid #3a4150;color:#e8eaed;border-radius:99px;',
    'padding:4px 12px;font-size:11.5px;cursor:pointer;white-space:nowrap;}',
    '.rsp-ctrls{display:flex;gap:6px;padding:8px 10px;align-items:center;flex-wrap:wrap;}',
    '.rsp-btn{background:var(--rsp-btnbg);color:var(--rsp-fg);border:1px solid var(--rsp-btnborder);border-radius:8px;padding:5px 9px;font-size:11.5px;cursor:pointer;}',
    '.rsp-btn:hover{background:var(--rsp-btnhov);}',
    '.rsp-btn:disabled{opacity:.45;cursor:default;}',
    '.rsp-btn.acc{background:#ff3c6e;border-color:#ff3c6e;color:#fff;font-weight:700;}',
    '.rsp-btn.acc:hover{background:#ff5c84;}',
    '.rsp-vol{width:70px;accent-color:#ff3c6e;}',
    '.rsp-auto{display:flex;align-items:center;gap:4px;color:var(--rsp-auto);font-size:10.5px;cursor:pointer;white-space:nowrap;}',
    '.rsp-stats{display:grid;grid-template-columns:auto 1fr auto 1fr;gap:3px 8px;padding:7px 12px;color:var(--rsp-muted);font-size:10.5px;border-top:1px solid var(--rsp-border2);}',
    '.rsp-stats b{color:var(--rsp-fg);font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
    '.rsp-log{margin:0;padding:6px 12px 10px;list-style:none;font-size:10.5px;color:var(--rsp-logc);',
    'max-height:96px;overflow:hidden;border-top:1px solid var(--rsp-border2);',
    'font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;}',
    '.rsp-url{flex:1;min-width:120px;background:var(--rsp-inputbg);color:var(--rsp-fg);border:1px solid var(--rsp-btnborder);border-radius:8px;padding:5px 8px;font-size:11px;}',
    '.rsp-details{padding:0 10px 8px;}',
    '.rsp-details summary{cursor:pointer;color:var(--rsp-muted);font-size:10.5px;outline:none;}',
    '.rsp-details .rsp-ctrls{padding:8px 0 0;}',
    '.rsp-lbl{color:var(--rsp-muted);font-size:10.5px;white-space:nowrap;}',
    '.rsp-btn.rec{color:#ff5c7a;border-color:#5a2a35;}',
    '.rsp-btn.rec:hover{background:#33222b;}',
    '.rsp-btn.rec.on{background:#c62845;border-color:#c62845;color:#fff;font-weight:700;}',
    '.rsp-btn.rec.on:hover{background:#e2334f;}',
    '.rsp-recstat{color:var(--rsp-auto);font-size:10.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:250px;}',
    /* ---- 録画復帰提案(v1.6.0) ---- */
    '.rsp-resume{background:rgba(255,209,102,.08);border:1px dashed rgba(255,209,102,.45);border-radius:8px;padding:4px 8px;margin:0;}',
    '.rsp-resume .rsp-lbl{flex:1;min-width:0;color:#ffd166;font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
    /* ---- 履歴/予約一覧(v1.10.0) ---- */
    '.rsp-histlist,.rsp-schedlist{padding:0 12px 8px;color:var(--rsp-muted);font-size:10.5px;max-height:150px;overflow:auto;word-break:break-all;}',
    '.rsp-histlist b,.rsp-schedlist b{color:var(--rsp-fg);font-weight:600;}',
    '.rsp-histrow{padding:3px 0;border-bottom:1px solid var(--rsp-border2);cursor:pointer;}',
    '.rsp-histrow:last-child{border-bottom:none;}',
    '.rsp-histdetail{white-space:pre-wrap;color:var(--rsp-muted);padding:4px 0 8px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:10px;}',
    /* ---- 動画DLパネル(v1.5.0) ---- */
    '.rsp-vodpanel #rsp-vod-auth{margin-left:auto;color:var(--rsp-auto);font-size:10.5px;white-space:nowrap;}',
    '.rsp-vodmeta{padding:8px 12px 0;color:var(--rsp-fg);font-size:11px;word-break:break-all;}',
    '.rsp-vodbar{margin:8px 12px 0;height:8px;background:var(--rsp-inputbg);border:1px solid var(--rsp-border);border-radius:5px;overflow:hidden;}',
    '.rsp-vodbarin{height:100%;background:linear-gradient(90deg,#c62845,#ff5c7a);width:0%;transition:width .4s;}',
    '.rsp-vodstat{padding:4px 12px 0;color:var(--rsp-muted);font-size:10.5px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;}',
    '.rsp-vodpanel .rsp-ctrls{padding:8px 12px 4px;}',
    '.rsp-vodpanel .rsp-btn.acc{color:#fff;background:#c62845;border-color:#c62845;font-weight:700;}',
    '.rsp-vodpanel .rsp-btn.acc:hover{background:#e2334f;}',
    '.rsp-vodpanel .rsp-btn:disabled{opacity:.45;cursor:not-allowed;}',
    '.rsp-vodpanel .rsp-log{border-top:1px solid var(--rsp-border2);margin-top:6px;}',
    /* ---- ライブ探索(v1.12.0) ---- */
    '.rsp-disc-fab{position:fixed;left:14px;bottom:14px;z-index:2147483000;width:40px;height:40px;',
    'border-radius:50%;background:#c62845;color:#fff;border:1px solid #ff5c7a;font-size:18px;line-height:1;',
    'cursor:pointer;box-shadow:0 2px 10px rgba(0,0,0,.45);}',
    '.rsp-disc-fab:hover{background:#e2334f;}',
    '.rsp-disc{position:fixed;left:14px;bottom:62px;z-index:2147483001;width:344px;max-width:calc(100vw - 28px);',
    'background:var(--rsp-bg);color:var(--rsp-fg);border:1px solid var(--rsp-border);border-radius:12px;',
    'box-shadow:0 6px 24px rgba(0,0,0,.5);font-size:12px;overflow:hidden;}',
    '.rsp-disc{--rsp-bg:#14171c;--rsp-bg2:#1a1f27;--rsp-fg:#e8eaed;--rsp-muted:#b2bac6;--rsp-auto:#b2bac6;--rsp-border:#424b5b;--rsp-border2:#303846;--rsp-btnbg:#242a34;--rsp-btnborder:#586174;--rsp-btnhov:#354052;--rsp-inputbg:#0f1216;--rsp-qbg:#1d2330;--rsp-qfg:#e8eaed;--rsp-qborder:#586174;font-family:system-ui,sans-serif;}',
    '.rsp-disc .rsp-dhead{display:flex;align-items:center;gap:6px;padding:8px 10px;background:var(--rsp-bg2);font-weight:700;font-size:12px;}',
    '.rsp-disc .rsp-dauth{margin-left:2px;color:#7ee787;font-size:9.5px;font-weight:400;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}',
    '.rsp-disc .rsp-dbar{display:flex;gap:6px;padding:8px 10px 0;align-items:center;flex-wrap:wrap;}',
    '.rsp-disc .rsp-dstat{padding:5px 10px 0;color:var(--rsp-muted);font-size:10.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}',
    '.rsp-disc .rsp-dlist{margin:6px 0 0;padding:0 8px;list-style:none;max-height:250px;overflow:auto;}',
    '.rsp-disc .rsp-ditem{display:flex;align-items:center;gap:6px;padding:6px 4px;border-bottom:1px solid var(--rsp-border2);cursor:pointer;}',
    '.rsp-disc .rsp-ditem:last-child{border-bottom:none;}',
    '.rsp-disc .rsp-ditem:hover{background:var(--rsp-btnhov);}',
    '.rsp-disc .rsp-dnick{font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:92px;flex:none;}',
    '.rsp-disc .rsp-dtitle{flex:1;min-width:0;color:var(--rsp-muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}',
    '.rsp-disc .rsp-dad{color:#ff5c7a;border:1px solid #ff5c7a;border-radius:4px;font-size:9px;padding:0 3px;flex:none;}',
    '.rsp-disc .rsp-dview{color:var(--rsp-auto);font-size:10.5px;flex:none;white-space:nowrap;}',
    '.rsp-disc .rsp-dempty{padding:10px 4px;color:var(--rsp-muted);}',
    '.rsp-disc .rsp-dfoot{padding:6px 10px 8px;color:var(--rsp-muted);font-size:9.5px;border-top:1px solid var(--rsp-border2);}',
    '.rsp-disc .rsp-dsrc{display:flex;gap:4px;margin-top:4px;align-items:center;}',
    '.rsp-disc .rsp-dsrc .rsp-url{font-size:10px;min-width:0;}',
    '.rsp-disc .rsp-dtag{color:var(--rsp-auto);font-size:10px;}',
    '#rsp-panel{max-height:calc(100dvh - 24px);overflow:auto;} .rsp-disc{max-height:calc(100dvh - 82px);overflow:auto;}',
    '.rsp-disc .rsp-dbar .rsp-url{flex:1;min-width:120px;}.rsp-bg-list{max-height:180px;overflow:auto;padding:0 10px;list-style:none;}.rsp-bg-list li{padding:5px 0;border-bottom:1px solid var(--rsp-border2);overflow-wrap:anywhere;}',
    '#rsp-panel :focus-visible,.rsp-disc :focus-visible{outline:2px solid #7db9ff;outline-offset:2px;} @media(prefers-reduced-motion:reduce){.rsp-recdot{animation:none!important;}}'
  ].join('');

  function injectStyle() {
    if (document.getElementById('rsp-style')) return;
    const s = document.createElement('style');
    s.id = 'rsp-style';
    s.textContent = CSS;
    document.head.appendChild(s);
  }

  function el(tag, attrs) {
    const kids = Array.prototype.slice.call(arguments, 2);
    const n = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        const v = attrs[k];
        if (v == null) return;
        if (k === 'style') n.style.cssText = v;
        else if (k === 'class') n.className = v;
        else if (k.slice(0, 2) === 'on') n.addEventListener(k.slice(2), v);
        else if (k === 'text') n.textContent = v;
        else n.setAttribute(k, v);
      });
    }
    kids.forEach(function (kid) {
      if (kid == null) return;
      n.appendChild(typeof kid === 'string' ? document.createTextNode(kid) : kid);
    });
    return n;
  }

  function coverText(s, info) {
    switch (s) {
      case 'CONNECTING': return '接続中…';
      case 'CHECKING': return '配信状態を確認中…';
      case 'RETRY': return '再接続中(' + (info && info.attempt ? info.attempt : 0) + '回目)・約' +
        Math.round((info && info.waitMs ? info.waitMs : 0) / 1000) + '秒後\n' +
        (info && info.reason ? info.reason : '');
      case 'OFFLINE': return 'オフライン — 自動待機中\n(15秒間隔で配信開始を確認)';
      case 'TOKEN': return 'アクセス制限の可能性(403)\n— 30秒間隔で再確認中';
      default: return '';
    }
  }

  /* ---- v2.39.0: ページ側 配信者名キャッシュ(rsp_creator_meta) — 表示専用・秘密なし ----
     v2.31系統の随時harvestの統合版: 視聴中に既に取得済みの応答(配信一覧・ライブ
     走査)から名前を収穫し、予約一覧などの表示に使う(localStorage・userscriptと
     拡張content scriptの両方で動く)。この関数群自体は通信しない。拡張の登録時
     収集(chrome.storage側)とは別物で、表示は収穫側を優先し欠損時に登録metadata
     へフォールバックする。モジュール本体(RspCreatorMeta)はbuild.pyが直前に
     注入する。 */
  let _rspCreatorMeta = null;
  function rspCreatorMetaLoad() {
    if (_rspCreatorMeta) return _rspCreatorMeta;
    try { _rspCreatorMeta = globalThis.RspCreatorMeta.deserialize(localStorage.getItem('rsp_creator_meta')) || {}; }
    catch (e) { _rspCreatorMeta = {}; }
    return _rspCreatorMeta;
  }
  function rspCreatorMetaRemember(items) {
    try {
      const next = globalThis.RspCreatorMeta.harvest(rspCreatorMetaLoad(), items, Date.now());
      if (next) {
        _rspCreatorMeta = next;
        const json = globalThis.RspCreatorMeta.serialize(next);
        if (json) { try { localStorage.setItem('rsp_creator_meta', json); } catch (e2) {} }
      }
    } catch (e) {}
  }
  function rspCreatorMetaName(oid) {
    try { return globalThis.RspCreatorMeta.lookup(rspCreatorMetaLoad(), oid); } catch (e) { return ''; }
  }

  function persistChk(key, chk, def) {
    try {
      const v = localStorage.getItem(key);
      chk.checked = (v == null) ? def : (v === '1');
      chk.addEventListener('change', function () {
        try { localStorage.setItem(key, chk.checked ? '1' : '0'); } catch (e) {}
      });
    } catch (e) { chk.checked = def; }
  }


  /* ================= v1.12.0: ライブ探索(Discovery) =================
   「配信者を固定せず自分で探す」— 公式フロントと同一の公開APIだけでライブ中の配信を探す。
    ①GET /content/curation?componentOids[]=<creatorList>&liveDataRequest=true&forceFetch=false
      → 公式TOP「VTubers 🧚‍♀️」「Voice Actors 🎤」等の creatorList コンポーネントから
        候補creatorOidの集合を取得(livestreamList=セッションOIDは逆引き不能のため対象外)
    ②各creatorOidを GET /live/play?creatorOid=(公式が匿名視聴用に使う無認証API)で確認
    ③LIVEのものだけ GET /live/stream?creatorOid= で視聴者数を取得
    ④ログイン時は GET /live/streams(自分の会話 — authedJson・401自動回復付き)を優先。
      401(未ログイン/権限なし)なら静かに公開走査へフォールバック(認証回避はしない)
   防封禁設計(録画と同一思想):
    - 全体ペーシング: 要求開始間隔の下限 DISC_REQ_GAP_MS(全体で直列化)
    - 同時実行 DISC_CONC、要求タイムアウト9秒・走査内リトライなし(次回走査で回収)
    - pool/結果のキャッシュ DISC_CACHE_TTL_MS、自動更新は「既知LIVE再確認+輪読スライス」のみ
    - 403=全体60秒退避 / 429=指数バックオフ(上限300秒)+Retry-After最優先(RFC9110準拠) */
  const DISC_SOURCES_DEFAULT = '650beb0e0c98c9e3782b2b87,6478bcd82f73959e73f35ce1';
  const DISC_CACHE_TTL_MS = 120000;
  const DISC_403_COOLDOWN_MS = 60000;
  const DISC_429_BASE_MS = 30000;
  const DISC_429_MAX_MS = 300000;
  const DISC_CONC = 6;
  const DISC_TIMEOUT_MS = 9000;
  const DISC_REQ_GAP_MS = 120;
  const DISC_403_CONSEC = 30; // 連続403この回数でインフラ制限とみなし全体退避(散発403は学習スキップ)
  const DISC_AUTO_MS_DEFAULT = 60000;
  const DISC_SLICE = 40;
  const DISC_OID_RE = /^[0-9a-f]{24}$/i;

  function discSourcesGet() {
    try {
      const v = localStorage.getItem('rsp_disc_sources');
      if (v && v.trim()) {
        const arr = v.split(',').map(function (x) { return x.trim(); }).filter(function (x) { return DISC_OID_RE.test(x); });
        if (arr.length) return arr;
      }
    } catch (e) {}
    return DISC_SOURCES_DEFAULT.split(',');
  }
  function discSourcesSet(csv) {
    try { localStorage.setItem('rsp_disc_sources', String(csv || '')); } catch (e) {}
  }
  /* 未知形状の /live/streams 応答を防御的に解釈(公式の応答形式に依存しない) */
  function discParseAuthedStreams(j) {
    let arr = j;
    for (let depth = 0; depth < 4 && arr && !Array.isArray(arr); depth++) {
      if (typeof arr !== 'object') return null;
      arr = arr.items || arr.streams || arr.list || arr.data || arr.lives || arr.results;
    }
    if (!Array.isArray(arr)) return null;
    const out = [];
    for (let i = 0; i < arr.length; i++) {
      const it = arr[i];
      if (!it || typeof it !== 'object') continue;
      const oid = it.creatorOid || (it.creator && (it.creator.oid || it.creator._id)) || (it.creatorMetadata && (it.creatorMetadata.creatorOid || it.creatorMetadata.oid || it.creatorMetadata._id));
      if (typeof oid !== 'string' || !DISC_OID_RE.test(oid)) continue;
      const cm = it.creatorMetadata || it.creator || {};
      out.push({
        oid: oid.toLowerCase(),
        nick: cm.nickname || it.nickname || '',
        title: it.title || it.liveTitle || '',
        adult: !!(it.isAdultContent),
        viewers: (typeof it.viewerCount === 'number') ? it.viewerCount : null,
        src: 'authed'
      });
    }
    return arr.length && !out.length ? null : out;
  }

  function discParseCreatorPool(j) {
    let items = j;
    for (let depth = 0; depth < 4 && items && !Array.isArray(items); depth++) {
      items = typeof items === 'object' ? (items.curationData || items.data || items.items) : null;
    }
    if (!Array.isArray(items)) return [];
    const pool = new Set();
    for (const component of items) {
      if (!component || component.curationType !== 'creatorList') continue;
      const list = component.componentData && component.componentData.list;
      if (!Array.isArray(list)) continue;
      for (const value of list) {
        const oid = typeof value === 'string' ? value : value && value.creatorOid;
        if (typeof oid === 'string' && DISC_OID_RE.test(oid)) pool.add(oid.toLowerCase());
      }
    }
    return Array.from(pool);
  }

  function openDiscoveryPanel() {
    injectStyle();
    const old = document.getElementById('rsp-disc');
    if (old) { old.remove(); _discCleanup && _discCleanup(); }
    const D = {
      live: new Map(),        // oid -> {oid,nick,title,adult,viewers,src}
      pool: [],               // 候補creatorOid(重複排除)
      poolAt: 0,
      scanning: false,
      closed: false,
      controllers: new Set(),
      cooldownUntil: 0,
      c429: 0,
      nextAt: 0,              // 全体ペーシング用
      lastScanAt: 0,
      lastFullAt: 0,
      rotateIdx: 0,
      authedTriedAt: 0,
      authedUsed: false,
      consec403: 0,   // v1.12.0: 連続403カウンタ(200で復位・12連続で退避)
      skip403: new Set(), // v1.12.0: 403になったcreatorの学習リスト(以後スキップ)
      lastErr: '',
      timer: null
    };
    window.__RSP_DISC = D; // 試験フック(E2Eはこの状態を検査する)
    const T = RSP_I18N[rspLang()] || RSP_I18N.ja;
    const autoChk = el('input', { type: 'checkbox' });
    try { autoChk.checked = localStorage.getItem('rsp_disc_auto') !== '0'; } catch (e) { autoChk.checked = true; }
    autoChk.addEventListener('change', function () {
      try { localStorage.setItem('rsp_disc_auto', autoChk.checked ? '1' : '0'); } catch (e2) {}
    });
    const scanBtn = el('button', { class: 'rsp-btn', text: T.discScan, title: '公式クリエイター一覧(公開)からライブ中の配信を全走査します' });
    const refBtn = el('button', { class: 'rsp-btn', text: T.discRefresh, title: '既知のライブと候補の一部を再確認します(軽量)' });
    const autoLbl = el('label', { class: 'rsp-auto' }, autoChk, T.discAuto);
    const statLine = el('div', { class: 'rsp-dstat', text: T.discReady });
    const listEl = el('ul', { class: 'rsp-dlist', 'aria-label': '配信一覧' });
    const searchInput = el('input', { class: 'rsp-url', type: 'search', placeholder: '配信者・タイトルを検索', 'aria-label': '配信一覧を検索' });
    const sortSelect = el('select', { class: 'rsp-qsel', 'aria-label': '配信一覧の並び順' },
      el('option', { value: 'viewers', text: '視聴者数順' }), el('option', { value: 'name', text: '配信者名順' }));
    searchInput.addEventListener('input', render);
    sortSelect.addEventListener('change', render);
    const srcInput = el('input', { class: 'rsp-url', placeholder: T.discSrc, value: (function () {
      try { const v = localStorage.getItem('rsp_disc_sources'); return v != null ? v : DISC_SOURCES_DEFAULT; } catch (e) { return DISC_SOURCES_DEFAULT; }
    })() });
    const srcApply = el('button', { class: 'rsp-btn', text: T.apply });
    srcApply.addEventListener('click', function () {
      discSourcesSet(srcInput.value);
      D.pool = []; D.poolAt = 0; // ソース変更でpoolを無効化
      setStat(T.discReady);
    });
    const authBadge = el('span', { class: 'rsp-dauth', text: '' });
    const head = el('div', { class: 'rsp-dhead' },
      el('span', { text: '🔭 ライブ探索' }), authBadge,
      el('button', { class: 'rsp-minbtn', text: '✕', title: '閉じる' }));
    head.lastChild.addEventListener('click', function () { closeDisc(); });
    const srcDetails = el('details', { class: 'rsp-dfoot' },
      el('summary', { text: T.discFoot }),
      el('div', { class: 'rsp-dsrc' }, srcInput, srcApply));
    const box = el('div', { id: 'rsp-disc', class: 'rsp-disc' },
      head,
      el('div', { class: 'rsp-dbar' }, scanBtn, refBtn, autoLbl),
      el('div', { class: 'rsp-dbar' }, searchInput, sortSelect), statLine, listEl, srcDetails);
    document.body.appendChild(box);

    function setStat(m) { statLine.textContent = m; }
    function closeDisc() {
      D.closed = true;
      for (const ctl of D.controllers) ctl.abort();
      D.controllers.clear();
      if (_renderTimer) { clearTimeout(_renderTimer); _renderTimer = null; }
      if (D.timer) { clearInterval(D.timer); D.timer = null; }
      try { box.remove(); } catch (e) {}
      if (window.__RSP_DISC === D) window.__RSP_DISC = null;
      _discCleanup = null;
    }
    function openLive(oid) {
      try { window.open('/live?creatorOid=' + encodeURIComponent(oid), '_blank', 'noopener'); } catch (e) {}
    }
    function render() {
      if (D.closed) return;
      listEl.textContent = '';
      const query = String(searchInput.value || '').trim().toLocaleLowerCase();
      const items = Array.from(D.live.values()).filter(it => ((it.nick || '') + ' ' + (it.title || '') + ' ' + it.oid).toLocaleLowerCase().includes(query)).sort(function (a, b) {
        return (sortSelect.value === 'name' ? String(a.nick || '').localeCompare(String(b.nick || '')) : (b.viewers || 0) - (a.viewers || 0)) || a.oid.localeCompare(b.oid);
      });
      if (!items.length) {
        listEl.appendChild(el('li', { class: 'rsp-dempty', text: query ? '検索条件に一致する配信はありません' : (D.scanning ? '配信一覧を取得中…' : (D.lastErr || T.discEmpty)) }));
        return;
      }
      for (let i = 0; i < items.length; i++) {
        const it = items[i];
        const view = (it.viewers != null) ? ('👁 ' + it.viewers) : '👁 -';
        const row = el('li', { class: 'rsp-ditem', tabindex: '0', role: 'link', title: (it.nick || '') + ' — ' + (it.title || '') },
          it.adult ? el('span', { class: 'rsp-dad', text: 'AD' }) : null,
          el('span', { class: 'rsp-dnick', text: it.nick || it.oid.slice(0, 8) }),
          el('span', { class: 'rsp-dtitle', text: it.title || '(タイトルなし)' }),
          el('span', { class: 'rsp-dview', text: view }),
          el('span', { class: 'rsp-dtag', text: '▶' }));
        row.addEventListener('click', function () { openLive(it.oid); });
        row.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); openLive(it.oid); } });
        listEl.appendChild(row);
      }
    }
    let _renderTimer = null;
    function renderSoon() { // 節流描画(800ms) — 走査中の高頻度結果更新を平滑化
      if (D.closed || _renderTimer) return;
      _renderTimer = setTimeout(function () { _renderTimer = null; render(); }, 800);
    }
    function statText() {
      if (D.scanning) return T.discScanning;
      if (Date.now() < D.cooldownUntil) {
        return (T.discCooldown || 'cooling %Ss').replace('%S', Math.ceil((D.cooldownUntil - Date.now()) / 1000)) +
          (D.lastErr ? ' — ' + D.lastErr : '');
      }
      const base = D.live.size + '件ライブ / 候補' + D.pool.length + '人' +
        (D.lastScanAt ? ' / 最終' + new Date(D.lastScanAt).toTimeString().slice(0, 8) : '');
      return base + (D.lastErr ? ' / ' + D.lastErr : '');
    }
    function renderStat() { if (D.closed) return; scanBtn.disabled = refBtn.disabled = D.scanning; box.setAttribute('aria-busy', String(D.scanning)); setStat(statText()); }

    /* 全体ペーシング+403/429退避つきの取得(Discovery内部の全fetchはここを通る)。
       scope='pool'(curation)の403はインフラ制限とみなし即全体退避。
       scope='probe'(個別creatorのlive/play)の403は配信単位の事情の可能性が
       高いため、DISC_403_TOL回/走査までは個人スキップで継続(実環境で
       一部creatorが403でも全体が死なない) */
    async function fetchDisc(url, authJwt, scope) {
      if (D.closed || Date.now() < D.cooldownUntil) return { status: 0, held: true };
      /* スロット先確保: 応答が速いと到着時にnextAtが過去になり無ペース化するため、
         待機の有無にかかわらず必ずスロットを1つ予約してから送信する(全体で
         DISC_REQ_GAP_MS間隔を保証 — 防封禁設計の要) */
      const nowMs = Date.now();
      const wait = D.nextAt - nowMs;
      D.nextAt = Math.max(D.nextAt, nowMs) + DISC_REQ_GAP_MS;
      if (wait > 0) await new Promise(function (r) { setTimeout(r, wait); });
      if (D.closed || Date.now() < D.cooldownUntil) return { status: 0, held: true };
      const ctl = new AbortController();
      D.controllers.add(ctl);
      const to = setTimeout(function () { ctl.abort(); }, DISC_TIMEOUT_MS);
      try {
        const opt = { cache: 'no-store', signal: ctl.signal };
        if (authJwt) opt.headers = { Authorization: authJwt };
        const res = await fetch(url, opt);
        clearTimeout(to);
        if (res.status === 429) {
          const ra = recRetryAfterMs(res.headers.get('retry-after')); // v1.12.0: RA最優先
          const ms = ra || Math.min(DISC_429_BASE_MS * Math.pow(2, ++D.c429 - 1), DISC_429_MAX_MS);
          D.cooldownUntil = Date.now() + ms;
          D.lastErr = '429(レート制限)' + (ra ? '/RA' : '');
          return { status: 429, held: true };
        }
        if (res.status === 403) {
          if (scope !== 'probe') { // curation等インフラ層の403 → 全体退避
            D.cooldownUntil = Date.now() + DISC_403_COOLDOWN_MS;
            D.lastErr = '403(アクセス制限)';
            return { status: 403, held: true };
          }
          return { status: 403, held: false }; // 個別creator → 呼び側で学習/連続判定
        }
        if (res.status === 200) {
          D.c429 = 0;
          let json = null;
          try { json = await res.json(); } catch (e) { /* 非JSON */ }
          return { status: 200, json: json };
        }
        return { status: res.status };
      } catch (e) { D.lastErr = '一覧の通信に失敗しました。時間をおいて更新してください'; return { status: 0 }; }
      finally { clearTimeout(to); D.controllers.delete(ctl); }
    }
    /* 候補pool: 公式creatorListコンポーネント(公開)から取得 */
    async function ensurePool() {
      const registered=new Set();
      try{for(const id of globalThis.RspCreatorRegistry.list(localStorage.getItem('rsp_fav')||''))registered.add(id);}catch(e){}
      try{if(typeof chrome!=='undefined'&&chrome.runtime){const saved=await chrome.runtime.sendMessage({type:'registry.list'});for(const id of saved&&saved.ids||[])if(/^[a-f0-9]{24}$/i.test(id))registered.add(id);}}catch(e){}
      if(D.closed)return false;
      if (D.basePool && Date.now() - D.poolAt < DISC_CACHE_TTL_MS){D.pool=[...new Set([...D.basePool,...registered])];return D.pool.length>0;}
      const srcs = discSourcesGet();
      const set = new Set();
      for (let i = 0; i < srcs.length; i++) {
        const r = await fetchDisc(API_BASE + '/content/curation?componentOids[]=' + srcs[i] +
          '&liveDataRequest=true&forceFetch=false&lang=jp&platformType=rplay');
        if (r.held) return false;
        if (r.status !== 200 || !r.json) continue;
        for (const oid of discParseCreatorPool(r.json)) set.add(oid);
      }
      if(D.closed)return false;
      D.basePool=Array.from(set);
      D.pool = [...new Set([...D.basePool,...registered])];
      D.poolAt = Date.now();
      return D.pool.length > 0;
    }
    /* 自分の会話での一覧API(ログイン時のみ。401=静かに諦めて公開走査) */
    async function tryAuthedStreams() {
      if (D.closed) return null;
      D.authedTriedAt = Date.now();
      try {
        const r = await authedJson(API_BASE + '/live/streams', { timeoutMs: DISC_TIMEOUT_MS });
        if (r.status === 429) {
          D.cooldownUntil = Date.now() + (recRetryAfterMs(r.retryAfter) || Math.min(DISC_429_BASE_MS * Math.pow(2, D.c429++), DISC_429_MAX_MS));
          D.lastErr = '429(一覧APIのレート制限)';
          return null;
        }
        if (!r.ok || !r.json) return null; // 401含む(未ログインは公式と同様に見えないだけ)
        const items = discParseAuthedStreams(r.json);
        if (items !== null) {
          if (D.closed) return null;
          rspCreatorMetaRemember(items); // v2.39.0: 既知配信の名前を表示キャッシュへ収穫(秘密なし)
          D.authedUsed = true;
          authBadge.textContent = T.discAuthed;
          return items;
        }
      } catch (e) { /* 公開走査へ */ }
      return null;
    }
    /* creatorOid 1件の確認(公開・公式の匿名視聴用API) */
    async function probeCreator(oid) {
      if (D.skip403.has(oid)) { D.live.delete(oid); return { status: 403, held: false }; } // 学習済みスキップ
      const r = await fetchDisc(API_BASE + '/live/play?creatorOid=' + encodeURIComponent(oid) +
        '&key=&platformType=rplay&lang=jp', null, 'probe');
      if (r.held) return r;
      if (r.status === 403) {
        /* 実環境では一部creatorのlive/playが恒常403(約4%)。
           散発403はスキップ学習し、連続403(DISC_403_CONSEC回)のときだけ
           インフラ制限とみなして全体退避する(IPブロック等の早期検出) */
        D.skip403.add(oid);
        D.live.delete(oid);
        D.consec403++;
        if (D.consec403 >= DISC_403_CONSEC) {
          D.cooldownUntil = Date.now() + DISC_403_COOLDOWN_MS;
          D.lastErr = '403(アクセス制限・' + D.consec403 + '連続)';
          return { status: 403, held: true };
        }
        return r;
      }
      if (r.status === 200) D.consec403 = 0;
      renderSoon(); // v1.12.0: 走査中も結果を漸次表示(節流描画)
      if (r.status !== 200 || !r.json || r.json.streamState !== 'live') {
        if (r.status === 200 && r.json) D.live.delete(oid); // 通信失敗はオフラインの証拠ではない
        return r;
      }
      const cm = r.json.creatorMetadata || {};
      const item = {
        oid: oid, nick: cm.nickname || '', title: r.json.title || '',
        adult: !!r.json.isAdultContent, viewers: null, src: 'public'
      };
      rspCreatorMetaRemember([item]); // v2.39.0: ライブ走査の結果からも名前を収穫
      const r2 = await fetchDisc(API_BASE + '/live/stream?creatorOid=' + encodeURIComponent(oid),
        null, 'probe');
      renderSoon(); // v1.12.0: 視聴者数確認後も漸次表示
      if (!r2.held && r2.status === 200 && r2.json && typeof r2.json.viewerCount === 'number') {
        item.viewers = r2.json.viewerCount;
      }
      if (!D.closed) D.live.set(oid, item);
      return r;
    }
    /* 同時実行ランナー(403/429で全体中断) */
    async function runPool(list) {
      let idx = 0, aborted = false;
      const workers = [];
      for (let w = 0; w < DISC_CONC; w++) {
        workers.push((async function () {
          while (!aborted && !D.closed) {
            const i = idx++;
            if (i >= list.length) break;
            const r = await probeCreator(list[i]);
            if (r && r.held) { aborted = true; }
          }
        })());
      }
      await Promise.all(workers);
      return !aborted;
    }
    async function scan(full) {
      if (D.closed || D.scanning) return;
      if (Date.now() < D.cooldownUntil) { renderStat(); return; }
      D.scanning = true;
      if (full) D.skip403.clear();
      D.consec403 = 0; // v1.12.0: 連続403は走査単位で復位
      renderStat();
      render(); // 走査前の現状を表示維持
      try {
        D.lastErr = '';
        const authed = await tryAuthedStreams();
        if (D.closed) return;
        if (authed !== null) {
          D.live.clear();
          for (const item of authed) D.live.set(item.oid, item);
        }
        if (full || !D.pool.length) {
          // A valid authenticated list is sufficient; public curation is a fallback.
          if (authed === null) await ensurePool();
          if (D.closed) return;
          if (authed === null && D.pool.length) await runPool(D.pool);
          if (authed === null && !D.pool.length && !D.lastErr) D.lastErr = '一覧を取得できません。ログイン状態・探索ソースを確認してください';
          D.lastFullAt = Date.now();
          D.rotateIdx = 0;
        } else {
          /* 軽量更新: 既知LIVEの再確認+候補の輪読スライス(恒常負荷を最小化) */
          const known = Array.from(D.live.keys());
          const slice = [];
          const n = Math.min(DISC_SLICE, D.pool.length);
          for (let i = 0; i < n; i++) slice.push(D.pool[(D.rotateIdx + i) % D.pool.length]);
          D.rotateIdx = D.pool.length ? ((D.rotateIdx + n) % D.pool.length) : 0;
          if (authed === null) await runPool(Array.from(new Set(known.concat(slice))));
        }
        D.lastScanAt = Date.now();
        // 通信失敗・応答形状のエラーを件数と併記する
      } finally {
        D.scanning = false;
        render();
        renderStat();
      }
    }
    scanBtn.addEventListener('click', function () { scan(true); });
    refBtn.addEventListener('click', function () { scan(false); });
    /* 自動更新(軽量のみ・タブ非表示時は停止・退避中は何もしない) */
    const autoMs = (window.__RSP_TEST && window.__RSP_TEST.discAutoMs) || DISC_AUTO_MS_DEFAULT;
    D.timer = setInterval(function () {
      if (document.hidden || D.scanning || !autoChk.checked) return;
      if (Date.now() < D.cooldownUntil) { renderStat(); return; }
      if (!D.lastScanAt && !D.pool.length && !D.live.size) return;
      scan(false);
    }, autoMs);
    render();
    renderStat();
    scan(true); // パネルを開いたら最初に全走査
    _discCleanup = closeDisc;
    return D;
  }

  let _discCleanup = null;
  /* ライブ/動画ページ以外(TOP・一覧等)で提示する探索ボタン */
  function mountDiscoveryFab() {
    injectStyle();
    if (document.getElementById('rsp-disc-fab')) return;
    const fab = el('button', {
      id: 'rsp-disc-fab', text: '🔭',
      title: 'RPLAY ライブ探索 — 配信者を固定せずライブ中の配信を探します(公開APIのみ)'
    });
    fab.addEventListener('click', function () { openDiscoveryPanel(); });
    document.body.appendChild(fab);
  }
  function dismissDiscoveryFab() {
    try { const f = document.getElementById('rsp-disc-fab'); if (f) f.remove(); } catch (e) {}
  }

  function buildUI() {
    const video = el('video', { playsinline: '', autoplay: '', 'data-rsp': '1' });
    video.muted = true; // autoplayポリシー対策で必ずミュート開始

    const recdot = el('span', { class: 'rsp-recdot', title: '録画インジケーター' });
    const badge = el('span', { class: 'rsp-badge', text: '待機' });
    const minBtn = el('button', { class: 'rsp-minbtn', text: '─', title: '最小化/展開' });
    const closeBtn = el('button', { class: 'rsp-minbtn', text: '✕', title: '閉じる' });
    /* v1.12.0: ライブ探索パネルの開閉(配信者を固定せずライブを探す) */
    const discBtn = el('button', { class: 'rsp-minbtn', text: '🔭', title: 'ライブ探索 — ライブ中の配信を一覧から開けます' });
    discBtn.addEventListener('click', function () { openDiscoveryPanel(); });
    const head = el('div', { class: 'rsp-head' }, recdot, badge,
      el('span', { class: 'rsp-title', text: 'RPLAY Stable Player' }), discBtn, minBtn, closeBtn);

    const cover = el('div', { class: 'rsp-cover' }, el('div', { text: '初期化中…' }));
    const soundPill = el('div', { class: 'rsp-pill', text: '🔇 ミュート中 — クリックで音声ON' });
    const stage = el('div', { class: 'rsp-stage' }, video, cover, soundPill);

    const playBtn = el('button', { class: 'rsp-btn', text: '⏸', title: '再生/一時停止' });
    const muteBtn = el('button', { class: 'rsp-btn', text: '🔇', title: 'ミュート切替' });
    const vol = el('input', { class: 'rsp-vol', type: 'range', min: '0', max: '100', value: '100', title: '音量' });
    const swBtn = el('button', { class: 'rsp-btn', text: 'HLS⇄FLV', title: '経路手動切替' });
    const rcBtn = el('button', { class: 'rsp-btn acc', text: '再接続', title: '手動再接続' });
    const fsBtn = el('button', { class: 'rsp-btn', text: '全画面', title: 'フルスクリーン' });
    const qSel = el('select', { class: 'rsp-qsel', title: '再生画質: 自動(ABR)/最高/各レベル。録画は常に詳細設定に従い最高画質で行われます' });
    qSel.style.display = 'none'; // レベル判明後に表示(HLS接続時)
    const offBtn = el('button', { class: 'rsp-btn', text: '公式停止', title: '公式プレイヤーを停止(帯域節約)' });
    const autoStop = el('input', { type: 'checkbox' });
    autoStop.checked = true;
    const autoLabel = el('label', { class: 'rsp-auto' }, autoStop, 'LIVE後 公式を自動停止');

    /* ---- 録画行 ---- */
    const recBtn = el('button', { class: 'rsp-btn rec', text: '● 録画開始', title: '無劣化録画の開始/停止(再生と独立動作)' });
    const saveBtn = el('button', { class: 'rsp-btn', text: '💾 保存', title: '現在の録画データを保存(録画中ならここで分割して継続)' });
    const followChk = el('input', { type: 'checkbox' });
    const followLabel = el('label', { class: 'rsp-auto', title: '配信が終わっても追跡待機し、同じ配信者の次の配信で自動的に録画を再開します' }, followChk, '追跡');
    const recStat = el('span', { class: 'rsp-recstat', text: '' });
    const autoRec = el('input', { type: 'checkbox' });
    const autoRecLabel = el('label', { class: 'rsp-auto', title: '配信がLIVEになったら自動で録画を開始します' }, autoRec, 'LIVE後に自動録画');
    const recRow = el('div', { class: 'rsp-ctrls' }, recBtn, saveBtn, followLabel, autoRecLabel, recStat);

    const ctrls = el('div', { class: 'rsp-ctrls' },
      playBtn, muteBtn, vol, swBtn, rcBtn, fsBtn, offBtn, qSel, autoLabel);

    const stState = el('b', { text: '-' });
    const stTransport = el('b', { text: '-' });
    const stAttempt = el('b', { text: '0' });
    const stBuf = el('b', { text: '-' });
    const stats = el('div', { class: 'rsp-stats' },
      '状態', stState, '経路', stTransport, '再試行', stAttempt, 'バッファ', stBuf);

    const logList = el('ul', { class: 'rsp-log' });

    /* ---- 詳細設定 ---- */
    const urlInput = el('input', { class: 'rsp-url', placeholder: 'm3u8 URLを手動指定(任意・空で解除)' });
    const urlApply = el('button', { class: 'rsp-btn', text: '適用' });
    const splitInput = el('input', { class: 'rsp-url', type: 'number', min: '0', max: '180', value: '0', title: 'この分数でファイル自動分割(0=時間分割なし。保存先選択時はHLSを連続保存)', style: 'flex:none;width:64px;' });
    const flvChk = el('input', { type: 'checkbox' });
    const flvLabel = el('label', { class: 'rsp-auto', title: 'HLSが受信できない間、FLVストリームで録画を継続します(無劣化FLV保存)' }, flvChk, 'FLV代替');
    const backlogChk = el('input', { type: 'checkbox' });
    const backlogLabel = el('label', { class: 'rsp-auto', title: 'ON: 録画開始時にプレイリストへ残っている過去セグメント(最大約20分)も取得します。OFF: 開始時点からの新規セグメントのみ録画します' }, backlogChk, 'バックログ取得');
    /* v2.5.0(P1): EXTINF検証モード — RFC 8216厳格(未宣言EXTINFを拒否)。既定OFF=legacy(診断計数) */
    const rfcChk = el('input', { type: 'checkbox' });
    const rfcLabel = el('label', { class: 'rsp-auto', title: 'ON: RFC 8216厳格モード — EXTINFの無いセグメントを含むプレイリストを拒否します(安全側で停止)。OFF: 既定の旧互換モード(未宣言を診断計数して継続)' }, rfcChk, 'RFC 8216厳格');
    const infoChk = el('input', { type: 'checkbox' });
    const infoLabel = el('label', { class: 'rsp-auto', title: '録画停止時に、パート一覧・取得統計を含む情報JSONファイル(yt-dlpの.info.json相当)を保存します' }, infoChk, '録画情報JSON');
    const notifyChk = el('input', { type: 'checkbox' });
    const notifyLabel = el('label', { class: 'rsp-auto', title: '追跡待機の開始/録画の再開をデスクトップ通知します(初回ON時に通知権限が必要です)' }, notifyChk, '🔔通知');
    const bestQChk = el('input', { type: 'checkbox' });
    const bestQLabel = el('label', { class: 'rsp-auto', title: 'ON: master playlistから最高画質(解像度→fps→帯域)を自動選択し、より高画質が出現したら録画中でも昇格します。variantが消失したら次の画質へ自動フォールバックします。OFF: プレイリストの先頭variant(サーバー指定順)を使用' }, bestQChk, '⤒ 最高画質');
    /* v1.11.0: 音声トラックの並行録画(既定OFF) */
    const audioChk = el('input', { type: 'checkbox' });
    const audioLabel = el('label', { class: 'rsp-auto', title: 'master playlistに音声レンディション(URI付きEXT-X-MEDIA)があるとき、音声を映像と別のaudio-*.tsへ並行録画します(帯域が約1.2〜1.5倍増えます)。音声m3u8が404の場合は音声のみ停止し映像は継続します' }, audioChk, '⤓ 音声トラックも録画');
    const preferJapaneseAudioChk = el('input', { type: 'checkbox' });
    const preferJapaneseAudioLabel = el('label', { class: 'rsp-auto', title: '別音声を録画する場合、日本語と宣言された外部音声を優先します。見つからない場合は配信側の既定と帯域で選びます。録画開始時に設定してください' }, preferJapaneseAudioChk, '日本語の別音声を優先');
    /* v1.10.0: 統計CSV/リマインド/テーマ/言語/ファイル名テンプレート */
    const csvChk = el('input', { type: 'checkbox' });
    const csvLabel = el('label', { class: 'rsp-auto', title: '録画停止時に統計サマリ(CSV: 欠落率/再接続/基盤切替/画質履歴)を情報JSONと同時に保存します(「録画情報JSON」の指定が無くてもCSV単独で保存します)' }, csvChk, '統計CSV');
    const remindSel = el('select', { class: 'rsp-qsel', title: '予約配信の開始前リマインド通知(10分前/5分前/両方/OFF)。追跡待機中に通知します' });
    [['both', 'リマインド:両方(10/5分前)'], ['10', 'リマインド:10分前'], ['5', 'リマインド:5分前'], ['off', 'リマインド:OFF']].forEach(function (p) {
      const o = document.createElement('option'); o.value = p[0]; o.textContent = p[1]; remindSel.appendChild(o);
    });
    const themeSel = el('select', { class: 'rsp-qsel', title: 'パネルのテーマ(OSに追従/ダーク/ライト)' });
    [['auto', 'テーマ:OS追従'], ['dark', 'テーマ:ダーク'], ['light', 'テーマ:ライト']].forEach(function (p) {
      const o = document.createElement('option'); o.value = p[0]; o.textContent = p[1]; themeSel.appendChild(o);
    });
    const langSel = el('select', { class: 'rsp-qsel', title: 'パネルの表示言語(ログ文面は日本語固定)' });
    [['ja', '言語:日本語'], ['en', 'Lang:English']].forEach(function (p) {
      const o = document.createElement('option'); o.value = p[0]; o.textContent = p[1]; langSel.appendChild(o);
    });
    const nameTpl = el('input', { class: 'rsp-url', placeholder: 'ファイル名テンプレート(空=既定) 例:{creator}_{date}_{quality}_{part}' });
    /* v1.10.0: 録画履歴(IndexedDB) */
    const histBtn = el('button', { class: 'rsp-btn', text: '🕘 録画履歴', title: '過去の録画セッションの履歴(IndexedDB・最大50件)を表示します。行をクリックで詳細を展開' });
    const histClear = el('button', { class: 'rsp-btn', text: '消去', title: '録画履歴をすべて削除します' });
    const histList = el('div', { class: 'rsp-histlist', style: 'display:none;' });
    /* v1.10.0: 予約一覧(お気に入りクリエイター) */
    const favInput = el('input', { class: 'rsp-url', placeholder: 'プロフィールURL／配信者ID（複数は空白・カンマ区切り）' });
    try{favInput.value=localStorage.getItem('rsp_fav')||'';}catch(e){}
    const schedBtn = el('button', { class: 'rsp-btn', text: '📡 予約を確認', title: 'お気に入り+現在ページの配信予約を自分のログイン会話で巡回します(自動巡回は10分間隔・サーバー配慮)' });
    const schedList = el('div', { class: 'rsp-schedlist', style: 'display:none;' });
    const schedDetails = el('details', { class: 'rsp-details' },
      el('summary', { text: '📡 予約一覧(お気に入りクリエイター・ログイン時)' }),
      el('div', { class: 'rsp-ctrls' }, favInput, schedBtn),
      schedList);
    const splitLbl = el('span', { class: 'rsp-lbl', text: '録画分割(分)' });
    const inheritQueryChk = el('input', { type: 'checkbox' });
    const inheritQueryLabel = el('label', { class: 'rsp-auto', title: 'cat-catch方式: M3U8のクエリパラメータ(token/key2等)を相対セグメントURLへ自動継承します' }, inheritQueryChk, 'クエリ継承');
    const joinBtn = el('button', { class: 'rsp-btn', text: '結合リスト保存', title: 'ページ内録画の停止後に使用。BG録画は停止時に自動出力。保存済みパートをPC上の結合ツールで1本へまとめるためのリストです。' });
    const folderBtn = el('button', { class: 'rsp-btn', text: '📁 保存先:未設定', title: '録画の保存先フォルダを指定(Chrome/Edge)。パートをフォルダへ直接書き込み(長時間録画向け)。再度クリックで解除' });
    const detailsSummary = el('summary', { text: '詳細設定(URL上書き/録画オプション)' });
    const details = el('details', { class: 'rsp-details' },
      detailsSummary,
      el('div', { class: 'rsp-ctrls' }, urlInput, urlApply),
      el('div', { class: 'rsp-ctrls' },
        splitLbl, splitInput, flvLabel, backlogLabel, rfcLabel, inheritQueryLabel, infoLabel, csvLabel, notifyLabel, bestQLabel, audioLabel, preferJapaneseAudioLabel, folderBtn, joinBtn),
      el('div', { class: 'rsp-ctrls' }, remindSel, themeSel, langSel),
      el('div', { class: 'rsp-ctrls' }, nameTpl),
      el('div', { class: 'rsp-ctrls' }, histBtn, histClear));

    /* ---- 復帰提案バー(v1.6.0: クラッシュ/再読込からの録画復帰) ---- */
    const continuousBtn=el('button',{class:'rsp-btn',text:'連続保存（時間分割なし）',title:'時間分割を0に設定。メモリ/保存先の容量上限や配信形式変更による分割は残ります。TSは停止後にMP4変換できます。'});
    continuousBtn.addEventListener('click',()=>{splitInput.value='0';try{localStorage.setItem('rsp_split','0');}catch(e){}ui.log('時間分割なし: 容量上限・配信形式変更時は保存を区切ります。TSはMP4変換画面でまとめて変換できます');});
    recRow.appendChild(continuousBtn);
    const resumeLbl = el('span', { class: 'rsp-lbl', text: '' });
    const resumeBtn = el('button', { class: 'rsp-btn acc', text: '⏵ 録画を復帰', title: '前回の録画セッション(クラッシュ/再読み込み前)を引き継いで再開します' });
    const resumeDrop = el('button', { class: 'rsp-btn', text: '破棄', title: '前回セッションの記録を破棄して提案を閉じる' });
    const resumeBar = el('div', { class: 'rsp-ctrls rsp-resume', style: 'display:none;' }, resumeLbl, resumeBtn, resumeDrop);

    const panel = el('div', { id: 'rsp-panel' }, head,
      el('div', { class: 'rsp-body' }, stage, ctrls, recRow, resumeBar, stats, logList, details, schedDetails, histList));

    const logs = [];
    const ui = {
      el: panel, video: video, state: 'IDLE',
      autoStopChecked: function () { return autoStop.checked; },
      autoRecChecked: function () { return autoRec.checked; }, // v2.0 Step2: BG録画の自動開始判定用
      followChecked: function () { return followChk.checked; },
      flvFallbackChecked: function () { return flvChk.checked; },
      backlogChecked: function () { return backlogChk.checked; },
      inheritQueryChecked: function () { return inheritQueryChk.checked; },
      rfcExtinfChecked: function () { return rfcChk.checked; }, // v2.5.0(P1)
      infoJsonChecked: function () { return infoChk.checked; },
      notifyChecked: function () { return notifyChk.checked; },
      bestQualityChecked: function () { return bestQChk.checked; },
      recAudioChecked: function () { return audioChk.checked; }, // v1.11.0
      preferJapaneseAudioChecked: function () { return preferJapaneseAudioChk.checked; },
      nameTplValue: function () { return nameTpl.value || ''; },      // v1.10.0
      csvChecked: function () { return csvChk.checked; },             // v1.10.0
      remindValue: function () { return remindSel.value || 'both'; }, // v1.10.0
      setState: function (s, info) {
        ui.state = s;
        const meta = STATE_META[s] || STATE_META.IDLE;
        badge.textContent = meta.label;
        badge.className = 'rsp-badge ' + meta.cls;
        stState.textContent = meta.label;
        stAttempt.textContent = String(info && info.attempt ? info.attempt : 0);
        const showCover = (s !== 'LIVE');
        cover.style.display = showCover ? 'flex' : 'none';
        if (showCover) {
          cover.textContent = '';
          cover.appendChild(document.createTextNode(coverText(s, info)));
        }
        soundPill.style.display = (video.muted && !showCover) ? 'block' : 'none';
      },
      setTransport: function (label) { stTransport.textContent = label; },
      setStats: function (o) {
        if (typeof o.latency === 'number') stBuf.textContent = o.latency.toFixed(1) + 's';
        if (typeof o.stall === 'number') stBuf.textContent = '停滞' + Math.round(o.stall / 1000) + 's';
      },
      log: function (msg) {
        const t = now2();
        logs.push('[' + t + '] ' + msg);
        if (logs.length > 60) logs.shift();
        logList.textContent = '';
        logs.slice(-6).forEach(function (line) {
          const li = el('li', { text: line });
          logList.appendChild(li);
        });
      }
    };

    /* ---- 録画UIまわり ---- */
    let recorder = null;
    try {
      const sv = localStorage.getItem('rsp_split');
      if (sv != null && sv !== '') splitInput.value = sv;
    } catch (e) {}
    splitInput.addEventListener('change', function () {
      try { localStorage.setItem('rsp_split', splitInput.value); } catch (e) {}
    });
    persistChk('rsp_follow', followChk, true);
    persistChk('rsp_flvfb', flvChk, true);
    persistChk('rsp_backlog', backlogChk, true);
    persistChk('rsp_inherit_query', inheritQueryChk, false);
    persistChk('rsp_rfc_extinf', rfcChk, false); // v2.5.0(P1): RFC 8216厳格モード(既定OFF)
    persistChk('rsp_infojson', infoChk, false);
    persistChk('rsp_autorec', autoRec, false);
    persistChk('rsp_notify', notifyChk, false);
    persistChk('rsp_bestq', bestQChk, true); // v1.9.0: 最高画質で録画(既定ON)
    persistChk('rsp_prefer_ja_audio', preferJapaneseAudioChk, false);
    persistChk('rsp_rec_audio', audioChk, false); // v1.11.0: 音声トラック併録(既定OFF — 帯域増のため明示ON制)
    /* ---- v1.10.0: CSV/リマインド/テーマ/言語/テンプレート ---- */
    persistChk('rsp_csv', csvChk, false);
    try { const _rv = localStorage.getItem('rsp_remind'); if (_rv) remindSel.value = _rv; } catch (e) {}
    remindSel.addEventListener('change', function () {
      try { localStorage.setItem('rsp_remind', remindSel.value); } catch (e) {}
      ui.log('予約リマインド: ' + remindSel.selectedOptions[0].textContent);
    });
    try { const _tv = localStorage.getItem('rsp_theme'); if (_tv) themeSel.value = _tv; } catch (e) {}
    applyTheme(panel);
    themeSel.addEventListener('change', function () {
      try { localStorage.setItem('rsp_theme', themeSel.value); } catch (e) {}
      applyTheme(panel);
      ui.log('テーマ: ' + themeSel.selectedOptions[0].textContent);
    });
    try { const _lv = localStorage.getItem('rsp_lang'); if (_lv) langSel.value = _lv; } catch (e) {}
    langSel.addEventListener('change', function () {
      try { localStorage.setItem('rsp_lang', langSel.value); } catch (e) {}
      applyI18n();
      ui.log('言語: ' + (langSel.value === 'ja' ? '日本語' : 'English'));
    });
    try { nameTpl.value = localStorage.getItem('rsp_name_tpl') || ''; } catch (e) {}
    nameTpl.addEventListener('change', function () {
      try { localStorage.setItem('rsp_name_tpl', nameTpl.value.trim()); } catch (e) {}
      ui.log(nameTpl.value.trim() ? 'ファイル名テンプレートを設定: ' + nameTpl.value.trim() : 'ファイル名テンプレートを既定に戻しました');
    });
    function applyTheme(p) {
      try { p.dataset.theme = rspTheme(); } catch (e) {}
    }
    /* v1.10.0: 静的ラベルの日本語/英語切替(ログ文面・REC統計行は日本語固定) */
    function applyI18n() {
      const d = RSP_I18N[rspLang()] || RSP_I18N.ja;
      saveBtn.textContent = d.save;
      swBtn.textContent = d.pswitch;
      rcBtn.textContent = d.reconnect;
      fsBtn.textContent = d.fs;
      offBtn.textContent = d.off;
      autoLabel.childNodes[1].textContent = d.autoStop;
      autoRecLabel.childNodes[1].textContent = d.autoRec;
      followLabel.childNodes[1].textContent = d.follow;
      flvLabel.childNodes[1].textContent = d.flv;
      backlogLabel.childNodes[1].textContent = d.backlog;
      rfcLabel.childNodes[1].textContent = d.rfcExtinf; // v2.5.0(P1)
      infoLabel.childNodes[1].textContent = d.infoJson;
      csvLabel.childNodes[1].textContent = d.csv;
      notifyLabel.childNodes[1].textContent = d.notify;
      bestQLabel.childNodes[1].textContent = d.bestQ;
      audioLabel.childNodes[1].textContent = d.audioRec; // v1.11.0
      splitLbl.textContent = d.split;
      detailsSummary.textContent = d.details;
      urlApply.textContent = d.apply;
      histBtn.textContent = d.history;
      histClear.textContent = d.histClear;
      schedBtn.textContent = d.schedScan;
      resumeBtn.textContent = d.resume;
      resumeDrop.textContent = d.drop;
      if (!(recorder && recorder.dirHandle)) folderBtn.textContent = d.folder;
      recBtn.textContent = (recorder && recorder.recording) ? d.recStop : d.recStart;
      if (qSel.options.length >= 2) {
        qSel.options[0].textContent = d.playq;
        qSel.options[1].textContent = d.playqBest;
      }
    }
    notifyChk.addEventListener('change', function () {
      if (!notifyChk.checked) return;
      try {
        if (typeof Notification === 'undefined') { ui.log('🔔通知: このブラウザは通知API非対応のためタイトル通知のみ動作します'); return; }
        if (Notification.permission === 'default') {
          const p = Notification.requestPermission(function () {});
          if (p && p.then) p.catch(function () {});
        } else if (Notification.permission !== 'granted') {
          ui.log('🔔通知: ブラウザで通知がブロックされています(サイト設定で許可すると有効化されます)');
        }
      } catch (e) {}
    });

    ui.splitMinutes = function () { return Math.max(0, Number(splitInput.value) || 0); };
    ui.recState = function (on, state, medium) {
      const _d = RSP_I18N[rspLang()] || RSP_I18N.ja; // v1.10.0: ラベル言語
      recBtn.textContent = on ? _d.recStop : _d.recStart;
      recBtn.className = on ? 'rsp-btn rec on' : 'rsp-btn rec';
      recdot.className = on ? ((state === 'STANDBY') ? 'rsp-recdot sb' : 'rsp-recdot on') : 'rsp-recdot';
      recdot.title = on ? ((state === 'STANDBY') ? '録画: 追跡待機中' : '録画中(' + (medium || 'ts').toUpperCase() + ')') : '';
      if (!on) recStat.textContent = '';
    };
    ui.recUpdate = function (s) {
      if (!s.recording) return;
      const p2 = function (n) { return (n < 10 ? '0' : '') + n; };
      const sec = Math.floor(s.elapsedMs / 1000);
      const t = Math.floor(sec / 3600) + ':' + p2(Math.floor((sec % 3600) / 60)) + ':' + p2(sec % 60);
      if (s.state === 'STANDBY') {
        const wsec = Math.floor(s.standbyMs / 1000);
        recStat.textContent = '⏸ 追跡待機 ' + Math.floor(wsec / 60) + ':' + p2(wsec % 60) +
          (s.schedMs ? ' ・ 📡 予約まで' + Math.ceil(s.schedMs / 60000) + '分' : '') +
          ' ・ 次の配信を探知中… ・ 保存' + s.files + '本';
      } else if (s.medium === 'flv') {
        recStat.textContent = '● ' + t + ' ・ ' + s.totalMb.toFixed(1) + 'MB ・ ' + (s.speedMBs || 0).toFixed(1) + 'MB/s ・ FLV代替 ・ 保存' + s.files + '本';
      } else {
        recStat.textContent = '● ' + t + ' ・ ' + s.totalMb.toFixed(1) + 'MB ・ ' + (s.speedMBs || 0).toFixed(1) + 'MB/s ・ ' + s.seg + 'seg' +
          (s.quality ? ' ・ ' + s.quality : '') + (s.audio ? '(' + s.audio + (s.audioRec ? '+audio' : '') + ')' : '') +
          (s.fails || s.gap ? ' ・ 漏れ' + (s.fails + s.gap) : '') +
          ' ・ 保存' + s.files + '本' + (s.resumes ? ' ・ 再開' + s.resumes : '');
      }
    };
    ui.attachRecorder = function (rec) {
      recorder = rec;
      if (rec.dirHandle) folderBtn.textContent = '📁 ' + rec.dirLabel.slice(0, 12);
    };
    /* ---- v1.10.0: 録画履歴の表示(IndexedDB・最大50件・行クリックで詳細展開) ---- */
    ui.renderHistory = async function () {
      const rows = await idbListSessions();
      histList.style.display = '';
      histList.textContent = '';
      if (!rows.length) { histList.appendChild(document.createTextNode('録画履歴はまだありません')); return; }
      rows.slice().reverse().forEach(function (h) {
        const dt = new Date(h.endedAt || Date.now());
        const row = el('div', { class: 'rsp-histrow' });
        row.appendChild(el('b', { text: (dt.getMonth() + 1) + '/' + dt.getDate() + ' ' + dt.toTimeString().slice(0, 5) + ' ' }));
        row.appendChild(document.createTextNode((h.creator || h.creatorOid || '?') + ' — ' +
          ((h.bytes || 0) / 1048576).toFixed(1) + 'MB / ' + (h.segTotal || 0) + 'seg' +
          (h.quality ? ' / ' + h.quality : '') +
          (h.missing ? ' / 欠落' + h.missing : '') +
          (h.resumes ? ' / 再開' + h.resumes : '') +
          (h.sourceSwitches ? ' / 切替' + h.sourceSwitches : '')));
        const detail = el('div', { class: 'rsp-histdetail', style: 'display:none;' });
        detail.textContent = JSON.stringify(h, null, 1);
        row.addEventListener('click', function () {
          detail.style.display = (detail.style.display === 'none') ? '' : 'none';
        });
        histList.appendChild(row);
        histList.appendChild(detail);
      });
    };
    histBtn.addEventListener('click', function () { ui.renderHistory(); });
    histClear.addEventListener('click', function () {
      idbClearSessions().then(function () {
        histList.style.display = 'none';
        histList.textContent = '';
        ui.log('録画履歴を消去しました');
      });
    });
    /* ---- v1.10.0: 予約一覧の巡回(お気に入り+現在ページ・自分のJWTのみ使用) ----
     自動巡回は10分間隔(SCHED_SCAN_MIN_MS)・1件ごとに400msの間隔でサーバーに配慮。 */
    ui.scanSchedules = async function (force) {
      if(ui._schedBusy)return;ui._schedBusy=true;schedBtn.disabled=true;ui._schedController=new AbortController();
      try{
      const now = Date.now();
      const gap = force ? 3000 : SCHED_SCAN_MIN_MS;
      if (now - (ui._lastSchedScanAt || 0) < gap) return;
      ui._lastSchedScanAt = now;
      RspAuth.probe();
      if (!RspAuth.jwt) {
        schedList.style.display = '';
        schedList.textContent = '予約一覧はログイン時に取得できます(自分のJWTのみ使用・未ログインでは停止)';
        return;
      }
      const cur = (current && current.id) || null;
      const ids = [];
      const regMeta = {}; /* v2.43.0: BG登録一覧の名前metadata(表示専用・形式はBG側で検証済) */
      if (cur) ids.push(cur);
      try {for(const id of globalThis.RspCreatorRegistry.list(favInput.value))if(!ids.includes(id))ids.push(id);localStorage.setItem('rsp_fav',globalThis.RspCreatorRegistry.list(favInput.value).join(','));}
      catch(e){schedList.style.display='';schedList.textContent=e.message;return;}
      try{if(typeof chrome!=='undefined'&&chrome.runtime){const saved=await chrome.runtime.sendMessage({type:'registry.list'});for(const id of saved&&saved.ids||[])if(/^[a-f0-9]{24}$/i.test(id)&&!ids.includes(id))ids.push(id);if(saved&&saved.meta&&typeof saved.meta==='object')for(const k of Object.keys(saved.meta)){const m=saved.meta[k];if(/^[a-f0-9]{24}$/i.test(k)&&m&&typeof m==='object'&&typeof m.name==='string')regMeta[k]=m;}}}catch(e){}
      ids.splice(100);
      if (!ids.length) {
        schedList.style.display = '';
        schedList.textContent = 'お気に入りクリエイターOIDを入力すると予約一覧を表示します';
        return;
      }
      schedList.style.display = '';
      schedList.textContent = '予約を確認中…(' + ids.length + 'クリエイター)';
      const rows = [];let errors=0;const reasons={};let currentResolved=false;
      let checked=0;
      for (const oid of ids) {
        if(ui._schedController.signal.aborted||ui.el&&ui.el.isConnected===false)return;
        const r = await fetchSchedulesFor(oid,ui._schedController.signal);
        if(ui._schedController.signal.aborted||ui.el&&ui.el.isConnected===false)return;
        if(oid===cur&&r&&!r.err)currentResolved=true;
        checked++;schedList.textContent='予約確認 '+checked+'/'+ids.length+'人 / 取得失敗'+errors+'件';
        if(!r||r.err){errors++;const code=String(r&&r.err||'error');const label=code==='401'||code==='nologin'?'ログイン':code==='403'?'権限':code==='429'?'混雑':code==='shape'?'応答形式':'通信';reasons[label]=(reasons[label]||0)+1;}
        if (r && r.items) for (const it of r.items) rows.push({ oid: oid, title: it.title, at: it.scheduledAt });
        await new Promise(function (res) { setTimeout(res, 400); }); // 巡回間隔(サーバー配慮)
      }
      if(ui._schedController.signal.aborted||ui.el&&ui.el.isConnected===false)return;
      rows.sort(function (a, b) { return a.at - b.at; });
      if(currentResolved&&recorder){const next=rows.find(row=>row.oid===cur&&row.at>=Date.now());recorder.schedItem=next?{title:next.title,scheduledAt:next.at}:null;}
      const errorText=Object.entries(reasons).map(([k,v])=>k+':'+v+'人').join(' / ');
      ui._lastScheduleErrors=reasons;
      schedList.textContent = '';
      if (!rows.length) {
        schedList.textContent = errors?'更新 '+new Date().toLocaleTimeString()+' / 予約を取得できない配信者が'+errors+'件（'+errorText+'）。予約なしとは未判定':'更新 '+new Date().toLocaleTimeString()+' / '+ids.length+'人を確認、予定されている配信予約はありません';
        return;
      }
      schedList.appendChild(el('p',{text:'更新 '+new Date().toLocaleTimeString()+' / '+ids.length+'人 / 予約'+rows.length+'件 / 取得失敗'+errors+'件 '+errorText+'。予約登録だけでは自動録画しません。'}));
      rows.forEach(function (row) {
        const dt = new Date(row.at);
        const line = el('div', { class: 'rsp-histrow' });
        line.appendChild(el('b', { text: (dt.getMonth() + 1) + '/' + dt.getDate() + ' ' + dt.toTimeString().slice(0, 5) + ' ' }));
        const who = rspCreatorMetaName(row.oid) || ((regMeta[row.oid] && regMeta[row.oid].name) ? regMeta[row.oid].name.slice(0, 100) : '') || row.oid.slice(0, 10) + '…'; // v2.39.0: 収穫キャッシュ優先→登録metadata→ID
        line.appendChild(document.createTextNode('「' + (row.title || '無題') + '」 ' + who +
          (row.oid === cur ? ' (現在ページ)' : '')));
        line.appendChild(el('a',{href:'https://rplay.live/live?creatorOid='+encodeURIComponent(row.oid),target:'_blank',rel:'noopener',text:' 配信を開く'}));
        schedList.appendChild(line);

      });
      }finally{if(ui._schedController)ui._schedController.abort();ui._schedController=null;ui._schedBusy=false;schedBtn.disabled=false;}
    };
    const cancelSched=el('button',{class:'rsp-btn',text:'予約確認を中止'});schedBtn.parentNode.appendChild(cancelSched);cancelSched.addEventListener('click',()=>{if(ui._schedController){ui._schedController.abort();schedList.textContent='予約確認を中止しました。取得済み途中結果は表示していません。';}});
    schedBtn.addEventListener('click', function () { ui.scanSchedules(true); });
    /* v1.9.0: 再生画質セレクタ(hls.jsのレベル一覧から構築) */
    ui.setQualityLevels = function (levels) {
      try {
        const list = Array.prototype.slice.call(levels || []);
        qSel.textContent = '';
        const mk = function (v, t) {
          const o = document.createElement('option');
          o.value = v; o.textContent = t;
          qSel.appendChild(o);
        };
        const _d = RSP_I18N[rspLang()] || RSP_I18N.ja; // v1.10.0
        mk('auto', _d.playq);
        mk('best', _d.playqBest);
        list.forEach(function (lv, i) {
          const fps = lv.attrs && lv.attrs['FRAME-RATE'] ? Math.round(parseFloat(lv.attrs['FRAME-RATE']) || 0) : 0;
          mk(String(i), (lv.height ? lv.height + 'p' : Math.round((lv.bitrate || 0) / 1000) + 'k') + (fps ? String(fps) : ''));
        });
        qSel.style.display = list.length ? '' : 'none';
        let pref = 'auto';
        try { pref = localStorage.getItem('rsp_playq') || 'auto'; } catch (e) {}
        if (pref === 'auto' || pref === 'best' || (Number(pref) >= 0 && Number(pref) < list.length)) qSel.value = pref;
      } catch (e) {}
    };
    /* v1.6.0: 復帰提案の表示 */
    ui.offerResume = function (s) {
      resumeLbl.textContent = '前回の録画: seg' + (s.segTotal || 0) + ' / ' + ((s.bytesTotal || 0) / 1048576).toFixed(1) + 'MB' +
        (s.state === 'STANDBY' ? ' (追跡待機中)' : '') + ' — 復帰しますか?';
      resumeBar.style.display = 'flex';
      resumeBtn.onclick = function () {
        resumeBar.style.display = 'none';
        if (recorder && !recorder.recording) recorder.resumeFromCrash(s);
      };
      resumeDrop.onclick = function () {
        resumeBar.style.display = 'none';
        if (recorder) recorder.clearSession();
        ui.log('前回セッションの復帰提案を破棄しました');
      };
    };
    /* v2.39.0: 自動開始の経路統一(ui.onLiveから)。拡張ブリッジがあればBG自動開始へ
       一本化しページ内録画との二重開始を構造的に排除する(policy判定はBG側)。
       ブリッジ不在(userscript/BG無効)のときはページ内開始を共通policyで判定:
       禁止なら開始しない、設定不明なら30秒後に再確認する(fail-closed+回復)。 */
    let _uiAutoRetryAt = 0, _uiAutoRetryTimer = 0;
    function uiAutoStart() {
      (async function () {
        try {
          const policy = (typeof RECENV.autoPolicy === 'function') ? await RECENV.autoPolicy() : { verdict: 'allowed' };
          if (!recorder || recorder.recording || !autoRec.checked) return;
          if (policy.verdict === 'denied') {
            ui.log('保存済み設定により自動録画は禁止されています(RPLAY内の自動録画がONでも開始しません)');
            return;
          }
          if (policy.verdict !== 'allowed') {
            ui.log('開始設定を確認できないため自動録画を見送ります(30秒後に再確認)');
            _uiAutoRetryAt = Date.now() + 30000;
            if (!_uiAutoRetryTimer) {
              _uiAutoRetryTimer = setInterval(function () {
                try {
                  if (!recorder || recorder.recording || !autoRec.checked) { clearInterval(_uiAutoRetryTimer); _uiAutoRetryTimer = 0; return; }
                  if (Date.now() >= _uiAutoRetryAt) { clearInterval(_uiAutoRetryTimer); _uiAutoRetryTimer = 0; uiAutoStart(); }
                } catch (e) { clearInterval(_uiAutoRetryTimer); _uiAutoRetryTimer = 0; }
              }, 1000);
            }
            return;
          }
          if (!recorder.recording) recorder.start();
        } catch (e) {}
      })();
    }
    ui.onLive = function () {
      if (!recorder) return;
      if (recorder.recording && recorder.state === 'STANDBY') {
        recorder.nudgeResume(); // 追跡待機中に配信が戻ったら即録画再開
        return;
      }
      if (autoRec.checked && !recorder.recording) {
        /* v2.39.0: BG自動開始への一本化(二重録画の構造的排除)。BG側で処理済み/
           禁止latch/再試行待ちもtrue(ページ内開始させない)。BG無効・非対応は
           false → ページ内開始を共通policyで判定。 */
        if (window.__RSP_BG__ && typeof window.__RSP_BG__.autoNow === 'function') {
          try { if (window.__RSP_BG__.autoNow()) return; } catch (e) {}
        }
        uiAutoStart();
      }
    };

    /* ---- 操作まわり ---- */
    let engine = null;
    function setMuted(m) {
      video.muted = m;
      muteBtn.textContent = m ? '🔇' : '🔊';
      soundPill.style.display = (m && ui.state === 'LIVE') ? 'block' : 'none';
      if (!m) video.play().catch(function () {});
    }
    soundPill.addEventListener('click', function () { setMuted(false); });
    muteBtn.addEventListener('click', function () { setMuted(!video.muted); });
    vol.addEventListener('input', function () { video.volume = Number(vol.value) / 100; });
    playBtn.addEventListener('click', function () {
      if (video.paused) video.play().catch(function () {}); else video.pause();
    });
    video.addEventListener('play', function () { playBtn.textContent = '⏸'; });
    video.addEventListener('pause', function () { playBtn.textContent = '▶'; });
    fsBtn.addEventListener('click', function () {
      try {
        if (document.fullscreenElement) document.exitFullscreen();
        else stage.requestFullscreen();
      } catch (e) {}
    });
    offBtn.addEventListener('click', function () {
      const n = stopOfficialPlayers(ui);
      offBtn.textContent = '公式停止済';
      offBtn.disabled = true;
      ui.log('公式プレイヤーを停止(' + n + '件)');
    });
    minBtn.addEventListener('click', function () {
      panel.classList.toggle('rsp-min');
      minBtn.textContent = panel.classList.contains('rsp-min') ? '▢' : '─';
    });
    urlApply.addEventListener('click', function () {
      if (engine) {
        engine.setCustomM3u8(urlInput.value);
        engine.manualReconnect();
      }
    });
    joinBtn.addEventListener('click', function () { if (recorder) recorder.saveJoinJob().catch(() => ui.log('結合リストの保存に失敗しました')); });
    folderBtn.addEventListener('click', function () {
      if (!recorder) return;
      recorder.pickFolder().then(function (label) {
        if (label) {
          folderBtn.textContent = '📁 ' + label.slice(0, 12);
          ui.log('保存先フォルダ: ' + label + ' — パートを直接書き込みます(長時間録画向け)');
        } else {
          folderBtn.textContent = '📁 保存先:未設定';
          ui.log('保存先フォルダを解除 → ダウンロード方式');
        }
      }).catch(function (e) {
        ui.log('フォルダ選択: ' + (e && e.message ? e.message : e));
      });
    });

    ui.bindEngine = function (eng) {
      engine = eng;
      urlInput.value = eng.customM3u8 || '';
    };
    qSel.addEventListener('change', function () {
      try { localStorage.setItem('rsp_playq', qSel.value); } catch (e) {}
      if (engine) engine.setPlaybackQuality(qSel.value);
      ui.log('再生画質: ' + (qSel.value === 'auto' ? '自動(ABR)' : qSel.value === 'best' ? '最高' : (qSel.selectedOptions[0] ? qSel.selectedOptions[0].textContent : qSel.value)));
    });
    swBtn.addEventListener('click', function () { if (engine) engine.manualSwitch(); });
    rcBtn.addEventListener('click', function () { if (engine) engine.manualReconnect(); });
    closeBtn.addEventListener('click', function () { unmount(); });
    recBtn.addEventListener('click', function () {
      /* v2.0 Step2: 拡張ブリッジ(バックグラウンド録画)がこのクリックを処理した
         場合はoffscreen側で開始/停止する(二重録画の構造的排除)。ブリッジ不在・
         無効・非対応環境は従来どおりページ内Recorder。 */
      if (window.__RSP_BG__ && window.__RSP_BG__.routeClick()) return;
      if (recorder) recorder.toggle();
    });
    saveBtn.addEventListener('click', function () {
      /* v2.0 Step2: バックグラウンド録画中の手動分割もoffscreenへ中継 */
      if (window.__RSP_BG__ && window.__RSP_BG__.routeSplit()) return;
      if (!recorder) return;
      if (recorder.partOpen) {
        recorder.closePart();
        recorder.log('手動保存 — 分割して録画継続');
      } else {
        recorder.log('保存する録画データがありません');
      }
    });

    return ui;
  }

  /* ================= マウント & ルート監視 (SPA対応) ================= */
  let current = null;
  let lastPath = rspRouteKey(location.pathname, location.search);
  const PLAY_ID_RE = /\/play\/([0-9a-f]{24})/;
  const C_LIVE_RE = /\/c\/([\w-]+)\/live/;

(function(root){'use strict';
function parse(value){const raw=String(value||'').trim();if(/^[a-f0-9]{24}$/i.test(raw))return raw.toLowerCase();let u;try{u=new URL(raw);}catch(e){throw Error('URLまたは24桁の配信者IDを入力してください');}if(u.protocol!=='https:'||!['rplay.live','www.rplay.live'].includes(u.hostname)||u.port||u.username||u.password)throw Error('https://rplay.live/ のURLだけ登録できます');const m=/^\/(?:profile|channel|creator|live)\/([a-f0-9]{24})\/?$/i.exec(u.pathname),q=u.searchParams.getAll('creatorOid');if(q.length>1||q.length&&!/^[a-f0-9]{24}$/i.test(q[0]))throw Error('配信者IDが不正または重複しています');if(m&&q.length&&m[1].toLowerCase()!==q[0].toLowerCase())throw Error('URL内の配信者IDが一致しません');if(m)return m[1].toLowerCase();if(/^\/(?:profile|channel|creator|live)\/?$/i.test(u.pathname)&&q.length)return q[0].toLowerCase();throw Error('配信者IDを特定できません。動画URLや名前だけのURLではなく、配信者IDを含むURLを使ってください');}
function list(value){const tokens=String(value||'').split(/[\s,]+/).filter(Boolean);if(tokens.length>100)throw Error('一度に100件まで登録できます');return [...new Set(tokens.map(parse))];}
function target(value){try{return {id:parse(value)};}catch(original){let u;try{u=new URL(String(value).trim());}catch(e){throw original;}if(u.protocol!=='https:'||!['rplay.live','www.rplay.live'].includes(u.hostname)||u.port||u.username||u.password)throw original;const m=/^\/c\/([^/]+)(?:\/live)?\/?$/.exec(u.pathname);if(!m||u.searchParams.has('creatorOid'))throw original;let slug;try{slug=decodeURIComponent(m[1]);}catch(e){throw original;}if(!slug||slug.length>100||/[\s/\\\x00-\x1f\x7f]/.test(slug))throw original;return {slug};}}
async function resolveList(value,lookup,options={}){const signal=options.signal,check=()=>{if(signal&&signal.aborted)throw Error('登録を中止しました');};check();const tokens=String(value||'').split(/[\s,]+/).filter(Boolean);if(tokens.length>100)throw Error('一度に100件まで登録できます');const entries=tokens.map(target),aliases=new Set(entries.filter(x=>x.slug).map(x=>x.slug));if(aliases.size>20)throw Error('名前URLの解決は一度に20人までです');const cache=new Map(),ids=[],meta={};let completed=0;for(const entry of entries){check();let id=entry.id;if(!id){if(!cache.has(entry.slug)){const result=await lookup(entry.slug,signal);check();if(!result||typeof result._id!=='string'||!/^([a-f0-9]{24})$/i.test(result._id))throw Error('名前URLを配信者IDへ解決できませんでした。一覧は変更していません');const resolvedId=result._id.toLowerCase();cache.set(entry.slug,resolvedId);const entryMeta=metaEntry(entry.slug,result);if(entryMeta)meta[resolvedId]=entryMeta;}id=cache.get(entry.slug);}if(!ids.includes(id))ids.push(id);completed++;if(options.onProgress)options.onProgress({completed,total:entries.length,resolved:ids.length});}check();if(typeof options.onMeta==='function')options.onMeta(meta);return ids;}
async function lookupCustom(slug,fetchImpl=fetch,signal){
 if(signal&&signal.aborted)throw Error('登録を中止しました');
 const ctl=new AbortController(),abort=()=>ctl.abort();if(signal)signal.addEventListener('abort',abort,{once:true});const timer=setTimeout(()=>ctl.abort(),8000);let reader;
 try{if(signal&&signal.aborted)ctl.abort();const res=await fetchImpl('https://api.rplay.live/account/getuser?customUrl='+encodeURIComponent(slug),{cache:'no-store',credentials:'omit',redirect:'error',signal:ctl.signal});if(res.status!==200)throw Error('配信者確認API HTTP '+res.status);if(Number(res.headers.get('content-length'))>2*1048576)throw Error('配信者確認応答が大きすぎます');if(!res.body||!res.body.getReader)throw Error('応答streamを取得できません');reader=res.body.getReader();let size=0,text='';const decoder=new TextDecoder('utf-8',{fatal:true});while(true){const part=await reader.read();if(part.done)break;size+=part.value.byteLength;if(size>2*1048576)throw Error('配信者確認応答が大きすぎます');text+=decoder.decode(part.value,{stream:true});}text+=decoder.decode();return JSON.parse(text);}finally{ctl.abort();clearTimeout(timer);if(signal)signal.removeEventListener('abort',abort);if(reader){try{const p=reader.cancel();if(p&&p.catch)p.catch(()=>{});}catch(e){}reader.releaseLock();}}
}
function snapshot(value){if(value===undefined)return '[]';if(!Array.isArray(value)||value.length>100||value.some(x=>typeof x!=='string'||!/^[a-f0-9]{24}$/i.test(x)))throw Error('保存済み一覧の形式が不正です。上書きせず確認してください');return JSON.stringify([...new Set(value.map(x=>x.toLowerCase()))]);}
/* ---- v2.42.0: 名前metadata(rsp_creator_meta) ----
   rsp_registered_creators はID配列のまま(契約不变)。名前URL解決時に
   取得した名前/正規URLだけを別keyへ保存する(派生データ・失信許容)。
   直接ID/プロフィールURL登録はAPIへ問い合わせないため meta を作らない。 */
function slugOk(s){return typeof s==='string'&&s.length>0&&s.length<=100&&!/[\s/\\\x00-\x1f\x7f]/.test(s);}
function metaEntry(slug,result){
 if(!slugOk(slug)||!result||typeof result!=='object'||Array.isArray(result))return null;
 let name='';for(const k of ['name','nickname','userName']){const v=result[k];if(typeof v==='string'&&v.trim()){name=v.trim().replace(/\s+/g,' ').slice(0,100);break;}}
 const custom=slugOk(result.customUrl)?result.customUrl:slug;
 const url='https://rplay.live/c/'+encodeURIComponent(custom);
 if(url.length>340)return null;
 return {name:name,url:url};
}
function sanitizeMeta(value){
 const out={};
 if(!value||typeof value!=='object'||Array.isArray(value))return out;
 const keys=Object.keys(value);
 if(!keys.length||keys.length>100)return out;
 for(const k of keys){
  if(!/^[a-f0-9]{24}$/.test(k))continue;
  const e=value[k];
  if(!e||typeof e!=='object'||Array.isArray(e))continue;
  const name=typeof e.name==='string'?e.name.replace(/\s+/g,' ').trim().slice(0,100):'';
  const url=typeof e.url==='string'&&e.url.length<=340&&/^https:\/\/rplay\.live\/c\/[A-Za-z0-9\-_.!~*'()]+$/.test(e.url)?e.url:'';
  const at=Number.isSafeInteger(e.at)&&e.at>0&&e.at<=Date.now()+946684800000?e.at:0;
  if(!name&&!url)continue;
  out[k]={name:name,url:url,at:at};
 }
 return out;
}
async function commit(ids,expected,storage,locks,metaUpdate){const next=JSON.parse(snapshot(ids));if(typeof expected!=='string')throw Error('保存済み一覧を読み込んでから登録してください');if(!locks||typeof locks.request!=='function')throw Error('この環境は排他保存に非対応です。対応ブラウザで再確認してください');const patch=sanitizeMeta(metaUpdate);return locks.request('rsp-creator-registry-save-v1',async()=>{const current=await storage.get(['rsp_registered_creators','rsp_creator_meta']);if(snapshot(current.rsp_registered_creators)!==expected)throw Error('別の画面で登録一覧が更新されました。保存済みに戻してから編集し直してください');const merged=sanitizeMeta(current.rsp_creator_meta);const now=Date.now();for(const k of Object.keys(patch))if(next.includes(k))merged[k]={name:patch[k].name,url:patch[k].url,at:now};for(const k of Object.keys(merged))if(!next.includes(k))delete merged[k];await storage.set({rsp_registered_creators:next,rsp_creator_meta:merged});return snapshot(next);});}
const api={parse,list,target,resolveList,lookupCustom,snapshot,commit,metaEntry,sanitizeMeta};if(typeof module!=='undefined')module.exports=api;root.RspCreatorRegistry=api;
})(globalThis);
(function(root){'use strict';
/* =====================================================================
   RPLAY Stable Player — Creator Metadata Cache (v2.31.0)
   =====================================================================
   登録済み/既知の配信者IDに対する表示名の小さなキャッシュ(秘密なし)。
   情報源は既に取得済みの応答(配信一覧/ライブ走査/BG録画開始時のcreatorName)
   のみで、このモジュール自体は一切通信しない。
   - normalize: 形状検証(IDは24桁hex・名前は制御文字除去/80字以内)と
     上限500件へのtruncate(古い at から落とす)。壊れた入力は捨てる(安全側)。
   - harvest: {oid,nick} の配列から追加/更新。同名は at を更新するだけ。
   - lookup: 名前(無ければ空文字)。
   - serialize/deserialize: localStorage/chrome.storage用の安全な変換。
     64KiB超過は null(保存しない)。
   ===================================================================== */
const OID_RE=/^[a-f0-9]{24}$/,NAME_MAX=80,MAX_ENTRIES=500,SERIALIZE_LIMIT=64*1024;
function sanitizeName(v){let s=String(v==null?'':v).replace(/[\u0000-\u001f\u007f]/g,' ').trim();return s?s.slice(0,NAME_MAX):'';}
function normalize(map,nowMs){const out={};if(!map||typeof map!=='object')return out;
 const rows=[];
 for(const k of Object.keys(map)){const oid=String(k||'').toLowerCase();if(!OID_RE.test(oid))continue;
  const v=map[k];if(!v||typeof v!=='object')continue;const name=sanitizeName(v.name);
  if(!name)continue;let at=Number(v.at);if(!Number.isFinite(at)||at<=0)at=Number(nowMs)||0;
  rows.push({oid,name,at:Math.floor(at)});}
 rows.sort((a,b)=>a.at-b.at);
 while(rows.length>MAX_ENTRIES)rows.shift();
 for(const r of rows)out[r.oid]={name:r.name,at:r.at};
 return out;}
function harvest(map,items,nowMs){const out=normalize(map,nowMs);const now=Number(nowMs)||0;let changed=false;
 const list=Array.isArray(items)?items:[];
 for(const it of list){if(!it||typeof it!=='object')continue;
  const oid=String(it.oid||'').toLowerCase();if(!OID_RE.test(oid))continue;
  const name=sanitizeName(it.nick!=null?it.nick:it.name);if(!name)continue;
  const cur=out[oid];
  if(cur){if(cur.name!==name){cur.name=name;cur.at=now;changed=true;}else if(now>cur.at){cur.at=now;}}
  else{out[oid]={name:name,at:now};changed=true;}}
 return changed?out:null;/* 変更が無ければnull — 呼び側は保存を省略できる */}
function lookup(map,oid){if(!map||typeof map!=='object')return '';const v=map[String(oid||'').toLowerCase()];
 return v&&typeof v==='object'?sanitizeName(v.name):'';}
function serialize(map){try{const json=JSON.stringify(map);if(!json||json.length>SERIALIZE_LIMIT)return null;return json;}catch(e){return null;}}
function deserialize(str){if(typeof str!=='string'||!str)return null;try{const v=JSON.parse(str);
 if(!v||typeof v!=='object'||Array.isArray(v))return null;const out=normalize(v);return Object.keys(out).length?out:null;}catch(e){return null;}}
const api={normalize:normalize,harvest:harvest,lookup:lookup,serialize:serialize,deserialize:deserialize,sanitizeName:sanitizeName,MAX_ENTRIES:MAX_ENTRIES};
if(typeof module!=='undefined')module.exports=api;root.RspCreatorMeta=api;
})(globalThis);

  function rspLiveRouteId(pathname, search) {
    const path=String(pathname||''),match=/^\/live\/([0-9a-f]{24})\/?$/i.exec(path);
    if(!match&&!/^\/live\/?$/i.test(path))return null;
    const values=new URLSearchParams(search||'').getAll('creatorOid');
    if(values.length>1)return null;
    const query=values.length?values[0]:null;
    if(query!==null&&!/^[0-9a-f]{24}$/i.test(query))return null;
    if(match&&query&&match[1].toLowerCase()!==query.toLowerCase())return null;
    return (match?match[1]:query||'').toLowerCase()||null;
  }
  function rspRouteKey(pathname,search){const id=rspLiveRouteId(pathname,search);return id?'live:'+id:'path:'+String(pathname||'');}
  function getStreamId() { return rspLiveRouteId(location.pathname,location.search); }

  function authLogLines(ui) {
    RspAuth.probe();
    ui.log('ログイン状態: ' + RspAuth.statusLabel() +
      (RspAuth.userOid ? ' / userOid: ' + RspAuth.userOid : ' / userOid: 不明'));
    if (RspAuth.jwt) ui.log('限定配信(会員限定)・購入済み動画は自分のログイン会話で再生/録画/DLできます');
    else ui.log('未ログインのため、限定配信・有料動画は扱えません(権限が無い動画は取得しません)');
  }

  function unmount() {
    if (!current) return;
    if(current.ui&&current.ui._schedController)current.ui._schedController.abort();
    try { if (current.recorder && current.recorder.recording) current.recorder.stop(true); } catch (e) {}
    try { if (current.vod) current.vod.cancel(); } catch (e) {}
    try { if (current.engine) current.engine.destroy(); } catch (e) {}
    try { current.ui.el.remove(); } catch (e) {}
    window.__RSP = null;
    current = null;
  }

  /* ---- /play/<id>: 動画DLパネル(公式プレイヤーはそのまま使う) ---- */
  function mountVod(oid) {
    injectStyle();
    dismissDiscoveryFab(); // v1.12.0: 動画ページでは探索FABを撤去
    RspAuth.probe();
    const wrap = el('div', { id: 'rsp-panel', class: 'rsp-vodpanel' },
      el('div', { class: 'rsp-head' },
        el('span', { class: 'rsp-title', text: 'RPLAY 動画DL' }),
        el('span', { class: 'rsp-auth', id: 'rsp-vod-auth', text: RspAuth.statusLabel() })));
    const metaLine = el('div', { class: 'rsp-vodmeta', text: '動画情報を未取得(「DL開始」で取得)' });
    const barWrap = el('div', { class: 'rsp-vodbar' }, el('div', { class: 'rsp-vodbarin', style: 'width:0%' }));
    const statLine = el('div', { class: 'rsp-vodstat', text: '' });
    const logList = el('ul', { class: 'rsp-log' });
    const dlBtn = el('button', { class: 'rsp-btn acc', text: '📥 動画DL開始', title: '視聴権限のある動画を無劣化TSでダウンロード(暗号化HLSは自動復号)' });
    const cancelBtn = el('button', { class: 'rsp-btn', text: '中止', title: 'ダウンロードを中止(取得済み分を保存)' });
    cancelBtn.disabled = true;
    const btnRow = el('div', { class: 'rsp-ctrls' }, dlBtn, cancelBtn);
    wrap.appendChild(el('div', { class: 'rsp-body' }, metaLine, barWrap, statLine, btnRow, logList));
    document.body.appendChild(wrap);

    const ui = {
      el: wrap, metaLine: metaLine, barIn: barWrap.firstChild, statLine: statLine,
      log(m) {
        const li = el('li', { text: now2() + ' ' + m });
        logList.appendChild(li);
        while (logList.childNodes.length > 120) logList.removeChild(logList.firstChild);
        logList.scrollTop = logList.scrollHeight;
      },
      vodMeta(v) {
        metaLine.textContent = (v.title ? '「' + v.title + '」' : '') + (v.creator ? ' / ' + v.creator : '') +
          (v.anyEncrypted ? ' [AES-128暗号化HLS]' : '') + (v.segs.length ? ' — ' + v.segs.length + 'seg' : '');
      },
      vodProgress(v) {
        const all = v.segs.length || 1;
        ui.barIn.style.width = Math.min(100, Math.round(v.segDone / all * 100)) + '%';
        statLine.textContent = v.running
          ? ('seg ' + v.segDone + '/' + v.segs.length + ' / ' + (v.bytesTotal / 1048576).toFixed(1) + 'MB / ' + v.mbps.toFixed(1) + 'MB/s' + (v.fails ? ' / 失敗' + v.fails : ''))
          : ((v.segDone ? '完了 ' + v.segDone + '/' + v.segs.length + 'seg / ' + (v.bytesTotal / 1048576).toFixed(1) + 'MB' : ''));
      }
    };
    const vod = new VodDl(oid, ui);
    dlBtn.addEventListener('click', function () {
      if (vod.running) return;
      dlBtn.disabled = true; cancelBtn.disabled = false;
      ui.barIn.style.width = '0%';
      vod.run().then(function () { dlBtn.disabled = false; cancelBtn.disabled = true; });
    });
    cancelBtn.addEventListener('click', function () { vod.cancel(); });
    const vodTimer = setInterval(function () {
      if (!document.body.contains(wrap)) { clearInterval(vodTimer); return; }
      ui.vodProgress(vod);
    }, 800);
    current = { id: oid, vod: vod, ui: ui };
    window.__RSP = { vod: vod, ui: ui, version: '1.12.0' };
    ui.log('RPLAY Stable Player v1.12.0 — 動画DLパネル / contentOid: ' + oid);
    authLogLines(ui);
  }

  /* ---- /c/<custom>/live: カスタムURLからクリエイターOIDを解決 ---- */
  async function mountCustomLive(short, ui) {
    ui.log('カスタムURL「' + short + '」からクリエイターを解決中…');
    const r = await fetchJsonWithRetry(API_BASE + '/account/getuser?customUrl=' + encodeURIComponent(short), {}, 8000);
    if (r.ok && r.json && r.json._id) {
      ui.log('解決: ' + (r.json.nickname || short) + ' → OID ' + r.json._id);
      mount(r.json._id);
      return true;
    }
    ui.log('クリエイターを解決できませんでした(' + (r.status || 'network') + ')');
    return false;
  }

  function mount(id) {
    injectStyle();
    dismissDiscoveryFab(); // v1.12.0: ライブページでは探索FABを撤去(ヘッダーの🔭を使う)
    const ui = buildUI();
    document.body.appendChild(ui.el);
    if (!HAS_HLS && !HAS_FLV) {
      ui.log('エラー: hls.js / flv.js が両方とも利用できません(MSE非対応の可能性)');
      ui.setState('OFFLINE');
      return;
    }
    const engine = new Engine(id, ui);
    ui.bindEngine(engine);
    /* v2.0 Step1: 録画コアへの依存を明示注入(限定解決/予約/ヒント/基盤ラベル) */
    const recDeps = {
      resolveMemberLive: resolveMemberLive,
      resolveScheduleInfo: resolveScheduleInfo,
      fetchSchedulesFor: fetchSchedulesFor,
      memberFailHint: memberFailHint,
      liveBaseLabel: liveBaseLabel
    };
    const recorder = new Recorder(id, ui, recDeps);
    recorder.getCustomM3u8 = function () { return engine.customM3u8 || ''; };
    recorder.getCreatorName = function () {
      try {
        const m = document.querySelector('meta[property="og:title"]');
        const t = m ? m.getAttribute('content') : '';
        return t && t.trim() ? t.trim() : '';
      } catch (e) { return ''; }
    };
    ui.attachRecorder(recorder);
    current = { id: id, engine: engine, recorder: recorder, ui: ui };
    window.__RSP = {
      engine: engine, recorder: recorder, ui: ui, version: '2.56.0',
      memStats: function () { try { return recorder.memStats(); } catch (e) { return null; } },       // v1.10.0
      historyList: function () { return idbListSessions(); },                                        // v1.10.0
      scanSchedules: function (force) { return ui.scanSchedules(force !== false); },                 // v1.10.0
      authEvidence: function () { try { return RspAuth.authEvidence(); } catch (e) { return undefined; } }, // v2.8.0
      canaryEvidence: function () { return _lastCanary ? rspCanaryEvidence(_lastCanary) : undefined; },     // v2.8.0
      creatorMetaName: function (oid) { return rspCreatorMetaName(oid); },                           // v2.39.0: 収穫キャッシュ参照(表示専用)
      creatorMetaRemember: function (items) { return rspCreatorMetaRemember(items); }                // v2.39.0: 手動収穫(試験・表示用)
    };
    ui.log('RPLAY Stable Player v2.1.0 — 対象ID: ' + id);
    authLogLines(ui);
    ui.log('v1.10.0: 予約リマインド(10/5分前)・音声トラック検出・ファイル名テンプレート・統計CSV・録画履歴(🕘)・予約一覧(📡)・Worker検証・テーマ/言語に対応');
    ui.log('v1.11.0: 音声レンディションの個別録画(詳細設定「⤓ 音声トラックも録画」・既定OFF)に対応 — audio-*.tsとして並行保存します');
    ui.log('v1.12.0: ライブ探索(🔭) — 配信者を固定せずライブ中の配信を公式公開APIだけで探索できます(Retry-After準拠/GAP・BYTERANGE防御)');
    ui.log('v2.1.0: Chrome/Firefox両拡張でバックグラウンド録画(タブを閉じても継続)+OPFSクラッシュ保全に対応 — 長時間不在録画には拡張版を推奨');
    ui.log('経路: 新旧基盤の多段源(BytePlus abr/従来/IVS)+FLVフォールバック' + (HAS_HLS ? '' : ' [hls.js無効]') + (HAS_FLV ? '' : ' [flv.js無効]'));
    ui.log('録画は「追跡」ONで配信終了後も次の配信を自動追跡します(限定配信にも追従)');
    ui.log('開始音声はミュートです(自動再生対策)。🔊で解除');
    /* v1.10.0: 予約一覧の自動巡回(10分間隔・バックグラウンドタブでは待機) */
    setInterval(function () {
      if (document.hidden) return;
      try { ui.scanSchedules(false); } catch (e) {}
    }, SCHED_SCAN_MIN_MS);
    /* v1.7.0 詮索: 配信基盤・権限の事前探査(live/play — 未ログインでも可) */
    (async function () {
      try {
        const info = await resolveLiveInfo(id);
        engine.liveInfo = info; recorder.liveInfo = info;
        if (info && recorder.noteStreamStart) recorder.noteStreamStart(info);
        const lines = liveScentLines(info);
        ui.log('🔎 詮索結果: ' + lines.join(' / '));
        if (info && info.streamState === 'offline') {
          ui.log('追跡録画を開始すると、配信の開始を自動検出して録画します');
        }
        /* v1.8.0: 配信予約の詮索(ログイン時のみ・未ログインは静かにスキップ) */
        try {
          const sch = await resolveScheduleInfo(id);
          if (sch) {
            ui.log('📡 配信予約: 「' + (sch.title || '無題') + '」 ' +
              new Date(sch.scheduledAt).toTimeString().slice(0, 5) + '開始予定 — 追跡録画で自動録画できます');
            if (recorder) recorder.schedItem = sch;
          }
        } catch (e2) { /* 予約なし */ }
      } catch (e) { ui.log('🔎 詮索失敗(一時障害の可能性) — 通常の探查で継続します'); }
    })();
    /* v1.6.0: 前回セッション(クラッシュ/再読込)の復帰提案 */
    try {
      const saved = loadSavedSession(id);
      if (saved) {
        ui.offerResume(saved);
        ui.log('前回の録画セッション(seg' + (saved.segTotal || 0) + ' / ' + ((saved.bytesTotal || 0) / 1048576).toFixed(1) + 'MB)があります — 「⏵ 録画を復帰」で続行できます');
      }
    } catch (e) {}
    engine.enter();
  }

  function routeChange() {
    unmount();
    const pm = location.pathname.match(PLAY_ID_RE);
    if (pm) { mountVod(pm[1]); return; }
    const cm = location.pathname.match(C_LIVE_RE);
    if (cm) {
      injectStyle();
      const wrap = el('div', { id: 'rsp-panel' },
        el('div', { class: 'rsp-head' }, el('span', { class: 'rsp-title', text: 'RPLAY Stable Player' })),
        el('div', { class: 'rsp-body' }, el('ul', { class: 'rsp-log', id: 'rsp-clog' })));
      document.body.appendChild(wrap);
      const ui = {
        el: wrap, log(m) { const l = wrap.querySelector('#rsp-clog'); if (l) { const li = el('li', { text: now2() + ' ' + m }); l.appendChild(li); } }
      };
      mountCustomLive(cm[1], ui);
      current = { id: cm[1], ui: ui };
      return;
    }
    const id = getStreamId();
    if (id) { mount(id); return; }
    /* v1.12.0: ライブ/動画以外のページ(TOP・一覧等)では探索ボタンを提示 */
    mountDiscoveryFab();
  }

  setInterval(function () {
    const routeKey=rspRouteKey(location.pathname,location.search);
    if (routeKey !== lastPath) {
      lastPath = routeKey;
      routeChange();
    }
  }, 1500);

  function boot() {
    if (!document.body) { setTimeout(boot, 300); return; }
    try {
      // v1.8.0: 他タブでのログイン/トークン更新を即取り込み(短命JWT追従)
      window.addEventListener('storage', function (e) {
        if (e && e.key === '_AUTHORIZATION_') RspAuth.probe();
      });
    } catch (e2) { /* localStorage不可の環境 */ }
    routeChange();
  }
  boot();
})();
