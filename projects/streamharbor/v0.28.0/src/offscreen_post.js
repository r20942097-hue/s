  /* ===== user.js同期コアここまで ===== */

  /* =====================================================================
     offscreenホスト側: UIシム + メッセージプロトコル(表5) + 試験ブリッジ
     ===================================================================== */

  /* UIシム: コアが参照するUIアクセサを設定値(rec.startで受領)で実装し、
     表示更新は rec.event としてUIタブへ送る(節流: stats 1秒1回・log末尾120行) */
  let _lastStatsAt = 0;
  function makeUiShim(binding) {
    const emit=obj=>MSG.send({...obj,sessionId:binding.sessionId,epoch:binding.epoch,oid:binding.oid});
    return {
      el: null,
      log: function (m) {
        const line = '[' + new Date().toTimeString().slice(0, 8) + '] ' + String(m).replace(/https?:\/\/\S+/g,'[URL]');
        LOGTAIL.push(line);
        if (LOGTAIL.length > 120) LOGTAIL.shift();
        emit({ type: 'rec.event', kind: 'log', line: line });
      },
      recState: function (on, state, medium) {
        if(state==='DRAINING' && CONTROL_GATE.binding()===binding)CONTROL_GATE.draining(binding);
        emit({ type: 'rec.event', kind: 'state', on: !!on, state: state, medium: medium });
        if (!on && state === 'IDLE') {emit({ type: 'rec.stopped' });CONTROL_GATE.end(binding);}
      },
      recUpdate: function (s) {
        const now = Date.now();
        if (now - _lastStatsAt < 900) return;
        _lastStatsAt = now;
        emit({ type: 'rec.event', kind: 'stats', stats: s });
      },
      followChecked: function () { return SET.follow; },
      flvFallbackChecked: function () { return SET.flv; },
      backlogChecked: function () { return SET.backlog; },
      infoJsonChecked: function () { return SET.infoJson; },
      notifyChecked: function () { return SET.notify; },
      bestQualityChecked: function () { return SET.bestQ; },
      recAudioChecked: function () { return SET.recAudio; },
      preferJapaneseAudioChecked: function () { return SET.preferJapaneseAudio; },
      nameTplValue: function () { return SET.nameTpl; },
      csvChecked: function () { return SET.csv; },
      remindValue: function () { return SET.remind; },
      inheritQueryChecked: function () { return SET.inheritQuery === true; },
      splitMinutes: function () { return SET.splitMin; },
      autoStopChecked: function () { return false; },
      autoRecChecked: function () { return false; }
    };
  }

  /* ---- v2.48.0(統合): BG停止後MP4自動引渡し(既定OFF・非破壊) ----
     録画停止・異常終了後にrsp_recへ残ったTSパートをMP4へ自動変換し
     保存台帳(export journal)へ引き渡す。元TSは削除・変更しない。
     変換は録画が無い場合のみ単発で実行し、URL等は記録しない。
     変換ライブラリ(sha256/mp4_codec_core/mp4_convert_core/mux/mp4_browser_io)
     はoffscreen.html・Firefox BGページで事前読み込み済みの前提。 */
  const HOST_BOOT_AT = Date.now();
  const MP4_HANDOFF = (typeof RspMp4Handoff === 'object' && RspMp4Handoff) ? RspMp4Handoff.create({
    now: function () { return Date.now(); },
    crypto: typeof crypto !== 'undefined' ? crypto : undefined,
    bootAt: HOST_BOOT_AT,
    settings: function () { return { enabled: SET.mp4AutoHandoff === true }; },
    isRecording: function () { return !!(STATE.recorder && STATE.recorder.recording); },
    listParts: async function () {
      const root = await navigator.storage.getDirectory();
      let dir;
      try { dir = await root.getDirectoryHandle('rsp_rec'); } catch (e) { return []; }
      const out = [];
      for await (const [name, h] of dir.entries()) {
        if (h.kind !== 'file' || !/\.ts$/i.test(name)) continue;
        try { const f = await h.getFile(); out.push({ name: name, size: f.size, lastModified: f.lastModified }); } catch (e2) {}
        if (out.length >= 5000) break;
      }
      return out;
    },
    openInputs: async function (names) {
      const root = await navigator.storage.getDirectory();
      const dir = await root.getDirectoryHandle('rsp_rec');
      const inputs = []; let missing = 0; const seen = new Set();
      for (const name of (Array.isArray(names) ? names : [])) {
        if (seen.has(name)) continue; seen.add(name);
        let fh;
        try { fh = await dir.getFileHandle(name); } catch (e) { missing++; continue; }
        let file;
        try { file = await fh.getFile(); } catch (e2) { missing++; continue; }
        if (!file || file.size < 1) { missing++; continue; }
        const entry = { name: name, size: file.size,
          getFile: async function () { return file; },
          isSameEntry: async function (other) { return other === entry; } };
        inputs.push(entry);
      }
      return { inputs: inputs, missing: missing };
    },
    createDestination: async function (p) {
      if (!RspMp4BrowserIO || typeof RspMp4BrowserIO.createStage !== 'function') throw Error('DESTINATION_UNAVAILABLE');
      const stage = await RspMp4BrowserIO.createStage({ id: crypto.randomUUID().replace(/-/g, ''), inputBytes: (p && p.inputBytes) || 0 });
      return { destination: stage.destination, finalize: stage.finalize, destroy: stage.destroy,
        file: function () { return stage.destination.getFile(); } };
    },
    convert: async function (p) {
      if (typeof RspMp4Convert !== 'object' || !RspMp4Convert || typeof RspMp4Convert.convertStreamed !== 'function') throw Error('CONVERTER_UNAVAILABLE');
      return RspMp4Convert.convertStreamed({ inputs: p.inputs, destination: p.destination,
        muxjs: globalThis.muxjs, hashing: RspSha256, signal: p.signal, onProgress: p.onProgress });
    },
    handoff: function (file, name) { return EXPORT_HOST.save(file, name); },
    excludeNames: function () { try { return EXPORT_HOST.inFlightNames(); } catch (e) { return []; } },
    notify: function (title, body) { if (SET.notify) MSG.send({ type: 'rec.notify', title: String(title).slice(0, 120), body: String(body).slice(0, 200) }); },
    emit: function (e) {
      const out = { type: 'rec.event', kind: 'mp4-handoff', phase: String(e && e.phase || '').slice(0, 32) };
      if (e && e.errorCode) out.errorCode = String(e.errorCode).slice(0, 64);
      if (e && e.reason) out.reason = String(e.reason).slice(0, 64);
      if (e && e.outputName) out.outputName = String(e.outputName).slice(0, 120);
      MSG.send(out);
    }
  }) : null;

  /* ---- v2.50.0/v2.51.0: ディスクバックド取得パイプライン(segment_store Stage 3/4 結線) ----
     合意設定(既定OFF)がONのときだけBGが agree:true を付けて転送する。ホスト側は
     二重ゲートとして payload.agree を再検証し、録画・保存処理中は拒否する。
     ストアと取得エンジンは遅延シングルトン(未使用ならOPFSにも触れない)。
     v2.51.0 修正: v2.50.0ではパイプラインに candidates 依存を渡していなかったため
     実機では全 run が CANDIDATES_UNAVAILABLE で失敗していた(単体試験は依存を
     明示渡ししていたため検出できなかった)。BG側で mediaCatalog から候補を解決し
     {items:[{id,url}]} として内部メッセージで渡す構成に修正した。URL は
     BG→offscreen の in-memory 転送のみに現れ、ログ・証跡・保存へは出ない。
     セグメント保存idは sha256(URL) の決定的ハッシュ — URL自体は保存・出力しない。 */
  let SEG_STORE = null, SEG_ACQUIRE = null, SEG_ASSEMBLER = null, SEG_LAST_RUN = null;
  function segBusy() { return !!stopPromise || !!(STATE.recorder && (STATE.recorder.recording || STATE.recorder.isDraining)); }
  /* All host seg.* routes cooperate on the same origin-scoped lock. Refuse
     without Web Locks; a local-only fallback would give a false safety claim. */
  async function segExclusive(operation) {
    let locks;
    try { locks = typeof navigator !== 'undefined' && navigator.locks; } catch (e) { locks = null; }
    if (!locks || typeof locks.request !== 'function') return { ok: false, error: 'SEGMENT_LOCK_UNAVAILABLE' };
    try {
      return await locks.request('rplay-segment-pipeline-v1', { mode: 'exclusive', ifAvailable: true }, async function (lock) {
        if (!lock) return { ok: false, error: 'SEGMENT_BUSY' };
        try { return await operation(); } catch (e) { return { ok: false, error: 'SEGMENT_OPERATION_FAILED' }; }
      });
    } catch (e) { return { ok: false, error: 'SEGMENT_LOCK_FAILED' }; }
  }
  function segSha256Hex(s) {
    return crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(s))).then(function (b) {
      let out = ''; const a = new Uint8Array(b);
      for (let i = 0; i < a.length; i++) out += ('0' + a[i].toString(16)).slice(-2);
      return out;
    });
  }
  function segDigest(u8) {
    return crypto.subtle.digest('SHA-256', u8).then(function (b) {
      let s = ''; const a = new Uint8Array(b);
      for (let i = 0; i < a.length; i++) s += ('0' + a[i].toString(16)).slice(-2);
      return s;
    });
  }
  function segStore() {
    if (SEG_STORE) return SEG_STORE;
    if (!RspSegmentStore) throw Error('SEGMENT_MODULES_UNAVAILABLE');
    SEG_STORE = RspSegmentStore.create({
      storage: navigator.storage,
      namespace: 'pipeline',
      maxBytes: 256 * 1048576, maxCount: 1024,
      digest: segDigest
    });
    return SEG_STORE;
  }
  function segAcquire(agree) {
    if (SEG_ACQUIRE) return SEG_ACQUIRE;
    if (!RspSegmentAcquire) throw Error('SEGMENT_MODULES_UNAVAILABLE');
    SEG_ACQUIRE = RspSegmentAcquire.create({ store: segStore(), agree: agree === true });
    return SEG_ACQUIRE;
  }
  /* v2.51.0: BGが解決した items から呼び出しごとの candidates アダプタを構築する */
  function segCandidates(items) {
    const map = new Map(items.map(function (it) { return [it.id, { url: it.url }]; }));
    return { get: function (id) { return Promise.resolve(map.get(id) || null); } };
  }
  function segPipeline(items, agree) {
    if (!RspSegmentPipeline) throw Error('SEGMENT_MODULES_UNAVAILABLE');
    return RspSegmentPipeline.create({ store: segStore(), acquire: segAcquire(agree === true), candidates: segCandidates(items), agree: agree === true, sha256Hex: segSha256Hex });
  }
  function segAssembler(agree) {
    if (SEG_ASSEMBLER) return SEG_ASSEMBLER;
    if (!RspSegmentAssemble) throw Error('SEGMENT_MODULES_UNAVAILABLE');
    SEG_ASSEMBLER = RspSegmentAssemble.create({ store: segStore(), storage: navigator.storage, Sha256: (typeof RspSha256 !== 'undefined' && RspSha256 && RspSha256.Sha256) ? RspSha256.Sha256 : null, sha256Hex: segSha256Hex, agree: agree === true });
    return SEG_ASSEMBLER;
  }
  /* v2.51.0: 候補id→URL解決済み items の検証(BGとの内部契約・最大64件) */
  function segValidItems(p) {
    const raw = Array.isArray(p && p.items) ? p.items : [];
    const items = [];
    for (const it of raw) {
      if (!it || typeof it.id !== 'string' || it.id.length < 1 || it.id.length > 256 || typeof it.url !== 'string') continue;
      let ok = false;
      try { const u = new URL(it.url); ok = u.protocol === 'http:' || u.protocol === 'https:'; } catch (e) {}
      if (ok) items.push({ id: it.id, url: it.url });
      if (items.length >= 64) break;
    }
    return items;
  }
  async function handleSegAcquire(p) {
    p = p || {};
    if (p.agree !== true) return { ok: false, error: 'PIPELINE_NOT_AGREED' };
    if (segBusy()) return { ok: false, error: 'RECORDING_BUSY' };
    const items = segValidItems(p);
    if (!items.length) return { ok: false, error: 'no-ids' };
    try {
      const pipe = segPipeline(items, true);
      const r = await pipe.run({ ids: items.map(function (x) { return x.id; }) });
      SEG_LAST_RUN = r && r.ok ? { requested: r.requested, accepted: r.accepted, fromStore: r.fromStore, failed: r.failed, canceled: r.canceled, skipped: r.skipped, bytesAccepted: r.bytesAccepted, at: r.at } : SEG_LAST_RUN;
      return r;
    } catch (e) { return { ok: false, error: String((e && e.code) || (e && e.message) || 'error') }; }
  }
  async function handleSegStats() {
    const out = { ok: true };
    if (!SEG_STORE) { out.idle = true; return out; }
    try {
      out.idle = false;
      out.engine = SEG_ACQUIRE ? SEG_ACQUIRE.stats() : { attempted: 0, accepted: 0, fromStore: 0, failed: 0, canceled: 0, bytesAccepted: 0, queued: 0, inFlight: 0 };
      out.store = await SEG_STORE.stats();
      out.lastRun = SEG_LAST_RUN;
      if (SEG_ASSEMBLER) { try { out.artifacts = (await SEG_ASSEMBLER.listArtifacts()).slice(0, 8); } catch (e) { out.artifacts = null; } }
    } catch (e) { return { ok: false, error: String((e && e.code) || 'error') }; }
    return out;
  }
  async function handleSegClear(p) {
    p = p || {};
    if (p.agree !== true) return { ok: false, error: 'PIPELINE_NOT_AGREED' };
    let removed = 0, removedArtifacts = 0;
    try {
      const store = segStore();
      const entries = await store.clearInventory();
      const asm = segAssembler(true);
      let arts;
      try { arts = await asm.clearInventory(); }
      catch (err) { return { ok: false, error: 'CLEAR_INCOMPLETE', stage: 'artifact-inventory', removed, removedArtifacts, partial: false }; }
      for (const e of entries) {
        try { const result = await store.delete(e.id); if (!result || result.ok !== true) throw Error('SEGMENT_DELETE_FAILED'); if (result.removed) removed++; }
        catch (err) { return { ok: false, error: 'CLEAR_INCOMPLETE', stage: 'segment', removed, removedArtifacts, partial: !!(err && err.partial) }; }
      }
      for (const art of arts) {
        try { const result = await asm.deleteArtifact(art.id); if (!result || result.ok !== true) throw Error('ARTIFACT_DELETE_FAILED'); if (result.removed) removedArtifacts++; }
        catch (err) { return { ok: false, error: 'CLEAR_INCOMPLETE', stage: 'artifact', removed, removedArtifacts, partial: !!(err && err.partial) }; }
      }
      SEG_LAST_RUN = null;
      return { ok: true, removed, removedArtifacts, scope: 'structural-inventory' };
    } catch (e) { return { ok: false, error: 'CLEAR_INCOMPLETE', stage: 'segment-inventory', removed, removedArtifacts, partial: false }; }
  }
  /* ---- v2.51.0: Stage 4 組立(明示指示のみ・成果物は rsp_asm/assemble へ・非破壊) ---- */
  async function handleSegAssemble(p) {
    p = p || {};
    if (p.agree !== true) return { ok: false, error: 'PIPELINE_NOT_AGREED' };
    if (segBusy()) return { ok: false, error: 'RECORDING_BUSY' };
    const items = segValidItems(p);
    if (!items.length) return { ok: false, error: 'no-ids' };
    try {
      const asm = segAssembler(true);
      /* 候補URLから決定的セグメントidを指示順に導出(パイプラインと同一規約) */
      const segmentIds = [];
      for (const it of items) segmentIds.push(await segSha256Hex(it.url));
      const ev = await asm.assemble({ segmentIds: segmentIds, allowGaps: p.allowGaps === true });
      return { ok: true, artifactId: ev.id, segments: ev.segments, bytes: ev.bytes, sha256: ev.sha256, formatHint: ev.formatHint, missing: ev.missing, gaps: ev.gaps, nonDestructive: true, verifiedDecode: false };
    } catch (e) {
      const out = { ok: false, error: String((e && e.code) || (e && e.message) || 'error') };
      if (e && Array.isArray(e.missing)) out.missing = e.missing;
      return out;
    }
  }
  async function handleSegArtifacts(p) {
    p = p || {};
    if (p.agree !== true) return { ok: false, error: 'PIPELINE_NOT_AGREED' };
    try {
      const asm = segAssembler(true);
      return { ok: true, artifacts: await asm.listArtifacts() };
    } catch (e) { return { ok: false, error: String((e && e.code) || 'error') }; }
  }
  /* v2.51.0: 組立成果物の保存(ExportHost経由の .bin + ゼロシークレット台帳 .json)。
     変数・ログにURLは出さない。成果物はOPFSに残る(非破壊・再保存可能)。 */
  async function handleSegExport(p) {
    p = p || {};
    if (p.agree !== true) return { ok: false, error: 'PIPELINE_NOT_AGREED' };
    if (typeof p.artifactId !== 'string' || !/^[a-f0-9]{8,64}$/i.test(p.artifactId)) return { ok: false, error: 'BAD_ARTIFACT_ID' };
    let base = typeof p.name === 'string' && p.name ? p.name.replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').replace(/^[. ]+|[. ]+$/g, '').slice(0, 120) : 'rplay_assembled';
    if (!base) base = 'rplay_assembled';
    if (!EXPORT_HOST) return { ok: false, error: 'EXPORT_UNAVAILABLE' };
    try {
      const asm = segAssembler(true);
      const art = await asm.readArtifact(p.artifactId);
      const ext = art.meta.formatHint === 'fmp4' ? 'mp4' : art.meta.formatHint === 'ts' ? 'ts' : 'bin';
      const r1 = await EXPORT_HOST.save(art.file, base + '.' + ext);
      const ledger = new Blob([JSON.stringify({ schema: art.meta.schema, id: art.meta.id, segments: art.meta.segments, bytes: art.meta.bytes, sha256: art.meta.sha256, missing: art.meta.missing || [], gaps: art.meta.gaps || [], formatHint: art.meta.formatHint, at: art.meta.at, nonDestructive: true, verifiedDecode: false, networkRequests: 0 }, null, 2)], { type: 'application/json' });
      const r2 = await EXPORT_HOST.save(ledger, base + '.assemble.json');
      return { ok: true, staged: 2, partIds: [r1 && r1.partId, r2 && r2.partId].filter(Boolean), bytes: art.meta.bytes, sha256: art.meta.sha256, formatHint: art.meta.formatHint, note: '組立バイト列とゼロシークレット台帳JSONを保存要求しました。変換・デコード検証は別工程です。' };
    } catch (e) { return { ok: false, error: String((e && e.code) || (e && e.message) || 'error') }; }
  }

  /* v2.52.0: 組立成果物の構造検証(seg.verify) — 明示指示のみ・読み取り専用・非破壊。
     RspFmp4Audit で box 連鎖・moof/mdat 対・トラック一貫性・TS sync を検証する。
     成果物は最大256MiBを一時的にRAMへ読むため、録画・保存処理中は RECORding_BUSY
     で拒否する(録画優先・RAM紀律)。構造検証はデコード検証ではない。 */
  async function handleSegVerify(p) {
    p = p || {};
    if (p.agree !== true) return { ok: false, error: 'PIPELINE_NOT_AGREED' };
    if (segBusy()) return { ok: false, error: 'RECORDING_BUSY' };
    if (typeof p.artifactId !== 'string' || !/^[a-f0-9]{8,64}$/i.test(p.artifactId)) return { ok: false, error: 'BAD_ARTIFACT_ID' };
    if (typeof RspFmp4Audit === 'undefined' || !RspFmp4Audit) return { ok: false, error: 'AUDIT_MODULE_UNAVAILABLE' };
    try {
      const asm = segAssembler(true);
      const art = await asm.readArtifact(p.artifactId);
      const buf = new Uint8Array(await art.file.arrayBuffer());
      const structure = RspFmp4Audit.audit(buf);
      return { ok: true, artifactId: art.meta.id, bytes: art.meta.bytes, sha256: art.meta.sha256,
        segments: art.meta.segments, formatHint: art.meta.formatHint || 'unknown',
        structure: structure, nonDestructive: true, verifiedDecode: false,
        note: '構造検証のみ。box連鎖・トラック構成・TS syncの整合であり、デコード成功・再生可能性・継続時間の証明ではありません。' };
    } catch (e) { return { ok: false, error: String((e && e.code) || (e && e.message) || 'error') }; }
  }

  /* ---- rec.start: UIタブから録画開始(保存先handleはIndexedDB共有済みの前提) ---- */
  /* 相対URLの絶対化: ページでは暗黙にページ起点で解決されるが、offscreen文書は
     chrome-extension://起点になるため、UIタブのURL(pageUrl)基準で明示的に解決する */
  function offAbsUrl(u) {
    if (!u || /^[a-z]+:\/\//i.test(u) || u.indexOf('//') === 0) return u || '';
    try { return new URL(u, STATE.pageUrl || 'https://rplay.live/').href; } catch (e) { return u; }
  }
  /* v2.40.0: URL録画の表示用ラベル(origin+pathのみ — 署名/tokenクエリを出さない) */
  function rspUrlSourceLabel(u) {
    try { const x = new URL(u); return String(x.origin + x.pathname).slice(0, 500); } catch (e) { return ''; }
  }
  /* v2.40.0: URL録画セッションの合成ID — sha256(正規化URL)先頭24桁(16-40桁hex
     のゲート書式に一致)。同一URLで安定し、実在RPLAY配信者IDとの衝突は
     無視できる確率。衝突時はBG側がbusyとして排他するため暴走しない。 */
  function rspUrlOid(u) {
    return crypto.subtle.digest('SHA-256', new TextEncoder().encode(u)).then(function (b) {
      let s = ''; const a = new Uint8Array(b);
      for (let i = 0; i < 12; i++) s += ('0' + a[i].toString(16)).slice(-2);
      return s;
    });
  }
  /* ---- v2.40.0: url.start — 任意HLS URL録画(dashboard経由・RPLAYに非依存) ----
     https:// のHLSプレイリストURLを共通コアで録画する。追跡(follow)とFLV代替は
     強制OFF(配信終了で停止する・RPLAY CDNのFLV URLは無関係のため)。合成oidは
     URLから決定的に導出し、同一URLの再開始でクラッシュ復帰(rec.startと同じ
     resume経路)が働く。 */
  async function handleUrlStart(p, owner) {
    p = p || {};
    const raw = String(p.url || '');
    if (!raw || raw.length > 2048) return { ok: false, error: 'bad-url' };
    let u;
    try { u = new URL(raw); } catch (e) { return { ok: false, error: 'bad-url' }; }
    if (u.protocol !== 'https:') return { ok: false, error: 'https-only' };
    const label = String(p.label || '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
    let oid;
    try { oid = await rspUrlOid(u.href); } catch (e) { return { ok: false, error: 'oid-unavailable' }; }
    const who = label || u.hostname;
    const r = await handleStart({
      oid: oid,
      customM3u8: u.href,
      pageUrl: u.href,
      creatorName: who,
      titleBase: label || ('URL録画 ' + u.hostname),
      settings: Object.assign({}, p.settings || {}, { follow: false, flv: false }),
      urlMode: true,
      automatic: false
    }, owner);
    if (r && r.ok) return Object.assign({}, r, { oid: oid, urlSession: true });
    return r;
  }
  async function handleStart(p, owner) {
    p = p || {};
    if (stopPromise || STATE.recorder && STATE.recorder.isDraining) return {ok:false,error:'draining'};
    const oid = typeof p.oid==='string'?p.oid.toLowerCase():'';
    if (!oid) return { ok: false, error: 'no-oid' };
    if (STATE.recorder && STATE.recorder.recording) {
      return { ok: false, error: 'busy', oid: STATE.recorder.id };
    }
    const admission=CONTROL_GATE.begin(owner,oid);
    if(!admission.ok)return admission;
    if(admission.existing)return {ok:true,existing:true,...CONTROL_GATE.status(owner,oid)};
    const binding=admission.binding;
    // Independent random audit key: do NOT persist or derive the control gate's
    // authorizing sessionId. A new recovery epoch gets a new attribution key.
    try { EXPORT_HOST.setSessionKey(crypto.randomUUID().replace(/-/g,'')); }
    catch(e){CONTROL_GATE.end(binding);return {ok:false,error:'session-attribution-unavailable'};}
    try {
    STATE.pageUrl = p.pageUrl || ('https://rplay.live/live/' + oid);
    /* v2.40.0: URL録画セッションの状態(rec.startでは常にfalseへ戻す) */
    STATE.urlMode = p.urlMode === true;
    STATE.urlSource = STATE.urlMode ? rspUrlSourceLabel(p.customM3u8 || '') : '';
    AUTH._401Classes = {}; AUTH._key2Resolutions = 0; AUTH._butterSends = 0; AUTH.relayedStats = null;
    STATE.authStats = undefined; STATE.canaryEvidence = undefined;
    applySettings(p.settings || {});
    applyAuth(p);
    if (!HAS_EXT && p.testHooks) { try { window.__RSP_TEST = p.testHooks; } catch (e) {} }
    STATE.creatorName = p.creatorName || '';
    STATE.customM3u8 = offAbsUrl(p.customM3u8);
    STATE.customFlv = offAbsUrl(p.customFlv);
    TITLEC.base = p.titleBase || '';
    checkBackupRecovery();
    await restoreHandle();
    { // Each new control session receives a fresh recorder and event identity.
      const deps = {
        resolveMemberLive: resolveMemberLive,
        resolveScheduleInfo: resolveScheduleInfo,
        fetchSchedulesFor: fetchSchedulesFor,
        memberFailHint: memberFailHint,
        liveBaseLabel: liveBaseLabel
      };
      STATE.recorder = new Recorder(oid, makeUiShim(binding), deps);
      STATE.recorder.getCreatorName = function () { return STATE.creatorName; };
      STATE.recorder.getCustomM3u8 = function () { return STATE.customM3u8; };
      STATE.recorder.getFlvUrl = function () { return STATE.customFlv; };
      STATE.recorder.getUrlMode = function () { return STATE.urlMode === true; }; /* v2.40.0 */
      await restoreHandle(); /* インスタンス生成後に再度ハンドルへ反映 */
    }
    /* クラッシュ/破棄前のセッションがあれば自動復帰(設計§4.3: 復旧記録) */
    let saved = null;
    try { saved = loadSavedSession(oid); } catch (e) {}
    if (saved && p.resume !== false) {
      try {
        STATE.recorder.resumeFromCrash(saved);
        CONTROL_GATE.activate(binding);
        return { ok: true, resumed: true, ...CONTROL_GATE.status(owner,oid) };
      } catch (e) { /* 復帰失敗は通常開始へフォールバック */ }
    }
    STATE.recorder.start();
    CONTROL_GATE.activate(binding);
    return { ok: true, ...CONTROL_GATE.status(owner,oid) };
    } catch(e) {
      if(STATE.recorder && STATE.recorder.recording) {try{await STATE.recorder.stop(false);}catch(ignored){}}
      EXPORT_HOST.setSessionKey(null);CONTROL_GATE.end(binding);return {ok:false,error:'recording-start-failed'};
    }
  }

  /* ---- rec.stop: 最終パートを閉じて情報JSON/CSV/履歴を書出し ---- */
  let controlQueue=Promise.resolve();
  function controlTask(fn,reply){const p=controlQueue.then(fn);controlQueue=p.catch(()=>{});p.then(reply,()=>reply({ok:false,error:'control-failed'}));return true;}
  let stopPromise = null;
  let lastParts = [];
  // In-memory evidence for this host lifetime only. Never includes media URLs.
  let lastAudioTransition = null;
  function audioTransitionSummary(rec) {
    const a = rec && rec.audio;
    if (!a) return null;
    const n = a.abandonedQueuedOnSourceChange;
    const reasons = ['404','stall','flv','standby','off','resolve','write_error','unsupported'];
    return {
      running: a.running === true,
      abandonedQueuedOnSourceChange: Number.isSafeInteger(n) && n >= 0 ? n : null,
      abandonedQueuedHistoryComplete: a.abandonedQueuedHistoryComplete === true,
      activeSegmentAtSourceChange: Number.isSafeInteger(a.activeSegmentAtSourceChange) && a.activeSegmentAtSourceChange >= 0 ? a.activeSegmentAtSourceChange : null,
      staleSegmentResultsIgnored: Number.isSafeInteger(a.staleSegmentResultsIgnored) && a.staleSegmentResultsIgnored >= 0 ? a.staleSegmentResultsIgnored : null,
      stopReason: reasons.includes(a.stopReason) ? a.stopReason : ''
    };
  }
  function recordingParts(rec) {
    if (!rec) return lastParts;
    const collect = (r, track) => !r ? [] : (r.partsLog || []).slice(-100).map(p => ({name:String(p.file || '').slice(0,180),size:Number(p.bytes)||0,status:p.saveState || 'pending',at:Date.parse(p.startedAt)||0,track})).concat(r.partOpen ? [{name:String(r.partName || '').slice(0,180),size:Number(r.bytes)||0,status:'recording',at:Date.now(),track}] : []);
    return collect(rec,'video').concat(collect(rec.audio,'audio')).sort((a,b)=>a.at-b.at).slice(-100);
  }
  async function handleStop(p,owner) {
    if(!CONTROL_GATE.authorize(owner,p))return {ok:false,error:'not-session-owner'};
    const binding=CONTROL_GATE.binding();CONTROL_GATE.draining(binding);
    if (stopPromise) return stopPromise;
    stopPromise = stopAndDrain().finally(() => { CONTROL_GATE.end(binding); stopPromise = null; });
    return stopPromise;
  }
  async function stopAndDrain() {
    const rec = STATE.recorder;
    if (!rec) return {ok:true,idle:true};
    if(rec.recording) await rec.stop(false);
    else if(rec._stopTask) await rec._stopTask;
    if (rec.waitForSaves) await rec.waitForSaves();
    if (rec.audio && rec.audio.waitForSaves) await rec.audio.waitForSaves();
    await EXPORT_HOST.drain();
    lastParts = recordingParts(rec);
    lastAudioTransition = audioTransitionSummary(rec);
    /* v2.48.0(統合): BG停止後MP4自動引渡し(既定OFF) — 停止済みTSパートを変換キューへ */
    if (MP4_HANDOFF && SET.mp4AutoHandoff) {
      try {
        const handoffNames = lastParts.filter(function (p) { return /\.ts$/i.test(p.name) && p.status !== 'recording'; }).map(function (p) { return p.name; });
        const audio=rec.audio,videoCount=Math.max((rec.partsLog||[]).length,(rec._joinParts||[]).length),audioCount=audio?Math.max((audio.partsLog||[]).length,(audio._joinParts||[]).length):0;
        let separateAudio=lastParts.some(p=>p.track==='audio')||!!(audio&&audio.uri);
        try { const gid=rec.selVariant&&rec.selVariant.audioGroup; const grp=gid&&parseAudioGroups(rec._masterTxt||'',rec.masterUrl||'')[gid]; if(grp&&grp.uri)separateAudio=true; } catch(e) { separateAudio=true; }
        let preflightBlock=separateAudio?'separate-audio':(rec._joinTruncated||(audio&&audio._joinTruncated)||videoCount+audioCount>lastParts.length?'incomplete-history':lastParts.some(p=>!/\.ts$/i.test(p.name))?'unsupported-part':lastParts.some(p=>p.status==='failed')?'failed-part':'');
        if (handoffNames.length || preflightBlock) MP4_HANDOFF.enqueue({ trigger: 'bg-stop', parts: handoffNames, preflightBlock });
      } catch (e) {}
    }
    STATE.recorder = null; /* 次回開始は新規インスタンス(セッションは正常停止で消去済み) */
    EXPORT_HOST.setSessionKey(null); // Future orphan/MP4 exports are explicitly unattributed.
    if (!rec.failedSaves && !(rec.audio && rec.audio.failedSaves) && !EXPORT_HOST.status().stageFailed) markBackupClean();
    STATE.recoveredParts = [];
    return { ok: true };
  }

  /* ---- rec.status: state/画質/パート/統計/ログ末尾を返す(再オープン時の復元) ---- */
  function handleStatus(p,owner) {
    p = p || {};
    const rec = STATE.recorder;
    const oid = p.oid || (rec ? rec.id : '');
    const out = { recording: !!(rec && rec.recording), oid: rec ? rec.id : '', handleName: STATE.handleName,
      ...CONTROL_GATE.status(owner,oid), authVersion: AUTH.exp || 0, draining: !!stopPromise || !!(rec && rec.isDraining), exportHost: EXPORT_HOST.status() };
    if (rec) {
      out.creatorName=String(STATE.creatorName||'').slice(0,200);out.title=String(TITLEC.base||'').slice(0,200);
      out.state = rec.state;
      out.medium = rec.medium;
      try { out.stats = rec.stats(); } catch (e) {}
      try { out.dirLabel = rec.dirLabel || ''; } catch (e) {}
    }
    out.urlSession = STATE.urlMode === true; /* v2.40.0 */
    out.urlSource = STATE.urlSource || '';
    out.parts = recordingParts(rec);
    /* v0.26: host-local part ordinals are NOT saved-file counts. A log window
       can be truncated to 100 even if the recorder's part index exceeds 100.
       Do not serialize session identifiers or raw part paths to the popup. */
    const ordinal=(r)=>{
      if(!r || !Number.isSafeInteger(r.partIndex) || r.partIndex<0 ||
         (r.partOpen===true && r.partIndex===Number.MAX_SAFE_INTEGER))return null;
      return r.partIndex+(r.partOpen===true?1:0);
    };
    out.partSequence=rec&&rec.recording===true?{
      video:ordinal(rec),audio:rec.audio?ordinal(rec.audio):null,
      audioPresent:!!rec.audio,kind:'host-ordinal'
    }:null;
    out.audioTransition = rec ? audioTransitionSummary(rec) : lastAudioTransition;
    out.mp4Handoff = MP4_HANDOFF ? MP4_HANDOFF.status() : null; /* v2.48.0(統合) */
    out.session = null;
    out.logs = out.canControl ? LOGTAIL.slice(-30).map(line=>String(line).replace(/https?:\/\/\S+/g,'[URL]')) : [];
    return out;
  }

  /* ---- token.update: UIタブが再取得した自分のトークンを受け取る ---- */
  function handleTokenUpdate(p,owner) {
    if(!CONTROL_GATE.authorize(owner,p))return {ok:false,error:'not-session-owner'};
    if(p.jwt && (typeof p.jwt!=='string'||p.jwt.length>16384))return {ok:false,error:'bad-auth'};
    applyAuth(p||{});return {ok:true};
  }

  /* ---- pick.stored: picker.htmlが保存先を IndexedDB へ書き込んだ通知 ---- */
  async function handlePickStored() {
    await restoreHandle();
    if (STATE.handleOk && STATE.recorder) {
      try { STATE.recorder.log('保存先フォルダを反映: ' + STATE.handleName); } catch (e) {}
    }
  }

  /* ---- v2.42.0: schedules.scan — dashboard外部予約閲覧(BG経由のschedules巡回) ----
     登録一覧の予約をこのホストで巡回する(読取専用・録画制御へは干渉しない)。
     トークンはUIタブからrec.start/token.updateで受け渡された自分の会話のみ使用
     (未保持ならnologin — ライブページを開くと受け渡る)。controlQueueへは
     入れない(最悪数分かかる巡回でrec.stop等の制御を遅延させないため)。
     巡回間隔はページ側と同じ400ms・再実行は60秒制限(forceで10秒)。 */
  let _bgSchedBusy = false, _bgSchedAt = 0;
  let _bgSchedJob=null;
  const _bgSchedCanceled=new Map();
  const bgSchedId=id=>typeof id==='string'&&/^[a-f0-9]{32}$/.test(id);
  function bgSchedLease(job){
    if(!job.id)return;
    if(job.timer)clearTimeout(job.timer);
    job.timer=setTimeout(()=>job.ctl.abort(),10000);
  }
  function handleBgSchedControl(p,cancel){
    const id=p&&p.requestId;if(!bgSchedId(id))return {ok:false,error:'bad-request'};
    if(cancel){
      for(const [key,at] of _bgSchedCanceled)if(at<=Date.now())_bgSchedCanceled.delete(key);
      if(_bgSchedCanceled.size>=100)_bgSchedCanceled.delete(_bgSchedCanceled.keys().next().value);
      _bgSchedCanceled.set(id,Date.now()+60000);
    }
    const job=_bgSchedJob;
    if(!job||job.id!==id)return {ok:cancel,error:cancel?'canceled':'not-found'};
    if(cancel)job.ctl.abort();else if(!job.ctl.signal.aborted)bgSchedLease(job);
    return {ok:true,completed:job.completed,total:job.total,canceled:job.ctl.signal.aborted};
  }
  function bgSchedWait(signal){return new Promise(resolve=>{
    let timer;
    const done=()=>{if(timer)clearTimeout(timer);signal.removeEventListener('abort',done);resolve();};
    if(signal.aborted)return resolve();
    signal.addEventListener('abort',done,{once:true});timer=setTimeout(done,400);
  });}
  async function handleBgSchedScan(p) {
    p = p || {};
    if(p.requestId!==undefined&&!bgSchedId(p.requestId))return {ok:false,error:'bad-request'};
    if((_bgSchedCanceled.get(p.requestId)||0)>Date.now())return {ok:false,error:'canceled'};
    if (_bgSchedBusy) return { ok: false, error: 'busy' };
    const ids = Array.isArray(p.ids) ? [...new Set(p.ids.filter(x => typeof x === 'string' && /^[a-f0-9]{24}$/i.test(x)).map(x=>x.toLowerCase()))].slice(0, 100) : [];
    if (!ids.length) return { ok: false, error: 'no-ids' };
    if (!RspAuth.jwt) return { ok: false, error: 'nologin' };
    const now = Date.now(), gap = p.force === true ? 10000 : 60000;
    if (now - _bgSchedAt < gap) return { ok: false, error: 'rate-limited', retryInMs: gap - (now - _bgSchedAt) };
    _bgSchedAt = now; _bgSchedBusy = true;
    const job={id:p.requestId||'',ctl:new AbortController(),completed:0,total:ids.length,timer:null};
    _bgSchedJob=job;bgSchedLease(job);
    const canceled=()=>({ok:false,error:'canceled',completed:job.completed,total:job.total});
    try {
      const rows = [], errors = {};
      for (let i = 0; i < ids.length; i++) {
        if(job.ctl.signal.aborted)return canceled();
        const oid = ids[i];
        const r = await fetchSchedulesFor(oid,job.ctl.signal);
        if(job.ctl.signal.aborted)return canceled();
        job.completed++;
        if (!r || r.err) { const c = String(r && r.err || 'error'); errors[c] = (errors[c] || 0) + 1; }
        else if (r.items) for (const it of r.items) {
          const t = Number(it.scheduledAt);
          if (Number.isFinite(t) && t > 0 && t <= 8640000000000000) {
            rows.push({ oid: oid, title: String(it.title || '').slice(0, 200), scheduledAt: t });
            rows.sort((a,b)=>a.scheduledAt-b.scheduledAt);
            if(rows.length>500)rows.pop();
          }
        }
        if (i < ids.length - 1) await bgSchedWait(job.ctl.signal);
      }
      if(job.ctl.signal.aborted)return canceled();
      rows.sort((a, b) => a.scheduledAt - b.scheduledAt);
      return { ok: true, rows: rows.slice(0, 500), errors: errors, checkedAt: Date.now(), count: ids.length };
    } finally { if(job.timer)clearTimeout(job.timer);if(_bgSchedJob===job)_bgSchedJob=null;_bgSchedBusy = false; }
  }

  /* ---- メッセージディスパッチ(拡張: chrome.runtime / ページ: 試験ブリッジ) ---- */
  function dispatch(msg, reply) {
    if (!msg || typeof msg !== 'object') { if (reply) reply({ ok: false, error: 'bad-msg' }); return false; }
    switch (msg.type) {
      case 'export.finish':
        EXPORT_HOST.finish(msg).then(reply, () => reply({ok:false})); return true;
      case 'export.sweep':
        EXPORT_HOST.sweep(msg.retry === true).then(reply, () => reply({ok:false})); return true;
      case 'rec.start':
        return controlTask(()=>handleStart(msg.payload||{},msg.control),reply);
      case 'url.start':
        return controlTask(()=>handleUrlStart(msg.payload||{},msg.control),reply);
      case 'mp4-handoff.status':
        /* v2.48.0(統合): 自動引渡しの状態照会(証拠は境界付き・URL等は含まない) */
        if (reply) reply(MP4_HANDOFF ? { ok: true, ...MP4_HANDOFF.status() } : { ok: false, error: 'unavailable' });
        return false;
      case 'mp4-handoff.sweep':
        /* v2.48.0(統合): 起動時の取り残しTSパートの自動引渡し(BGのrecoverExportsから呼ばれる。
        設定・録画状態の両ガードはホスト側で行う) */
        (MP4_HANDOFF ? MP4_HANDOFF.sweep() : Promise.resolve({ ok: false, error: 'unavailable' }))
          .then(function (r) { if (reply) reply(r); }, function () { if (reply) reply({ ok: false, error: 'sweep-failed' }); });
        return true;
      case 'rec.stop':
        return controlTask(()=>handleStop(msg.payload||{},msg.control),reply);
      case 'rec.claim':
        return controlTask(()=>CONTROL_GATE.claim(msg.control,msg.payload||{}),reply);
      case 'rec.status':
        if (reply) reply(handleStatus(msg.payload || {},msg.control));
        return false;
      case 'token.update':
        return controlTask(()=>handleTokenUpdate(msg.payload||{},msg.control),reply);
      case 'pick.stored':
        handlePickStored().then(function () { if (reply) reply({ ok: true }); });
        return true;
      case 'schedules.status':
      case 'schedules.cancel':
        if(reply)reply(handleBgSchedControl(msg.payload||{},msg.type==='schedules.cancel'));return false;
      case 'schedules.scan':
        handleBgSchedScan(msg.payload || {}).then(function (r) { if (reply) reply(r); }, function () { if (reply) reply({ ok: false, error: 'scan-failed' }); });
        return true;
      case 'seg.acquire': /* v2.50.0/v2.51.0: ディスクバックド取得(明示指示のみ・二重合意ゲート・録画中は拒否) */
        segExclusive(function () { return handleSegAcquire(msg.payload || {}); }).then(function (r) { if (reply) reply(r); }, function () { if (reply) reply({ ok: false, error: 'seg-failed' }); });
        return true;
      case 'seg.stats': /* v2.50.0: 取得統計(zero-secret) — 遅延生成なので未使用はidle */
        segExclusive(function () { return handleSegStats(); }).then(function (r) { if (reply) reply(r); }, function () { if (reply) reply({ ok: false, error: 'seg-failed' }); });
        return true;
      case 'seg.clear': /* v2.50.0: 取得済みセグメントと組立成果物の明示消去(合意ゲート付き) */
        segExclusive(function () { return handleSegClear(msg.payload || {}); }).then(function (r) { if (reply) reply(r); }, function () { if (reply) reply({ ok: false, error: 'seg-failed' }); });
        return true;
      case 'seg.assemble': /* v2.51.0: Stage 4 組立(明示指示のみ・指示順序・非破壊) */
        segExclusive(function () { return handleSegAssemble(msg.payload || {}); }).then(function (r) { if (reply) reply(r); }, function () { if (reply) reply({ ok: false, error: 'seg-failed' }); });
        return true;
      case 'seg.artifacts': /* v2.51.0: 組立成果物一覧(zero-secret) */
        segExclusive(function () { return handleSegArtifacts(msg.payload || {}); }).then(function (r) { if (reply) reply(r); }, function () { if (reply) reply({ ok: false, error: 'seg-failed' }); });
        return true;
      case 'seg.export': /* v2.51.0: 組立成果物の保存(.bin + 台帳.json・ExportHost経由) */
        segExclusive(function () { return handleSegExport(msg.payload || {}); }).then(function (r) { if (reply) reply(r); }, function () { if (reply) reply({ ok: false, error: 'seg-failed' }); });
        return true;
      case 'seg.verify': /* v2.52.0: 組立成果物の構造検証(明示指示のみ・読み取り専用・非破壊) */
        segExclusive(function () { return handleSegVerify(msg.payload || {}); }).then(function (r) { if (reply) reply(r); }, function () { if (reply) reply({ ok: false, error: 'seg-failed' }); });
        return true;
      case 'test.set':
        try { window.__RSP_TEST = msg.payload || {}; } catch (e) {}
        if (reply) reply({ ok: true });
        return false;
      case 'dbg.worker':
        /* 診断: この文書でWorker/fetchが動くか実証する(E2E/障害切り分け用) */
        (async function () {
          const out = { hasExt: HAS_EXT, blob: null, file: null, interval: null, fetchApi: null, fetchM3u8: null,
            href: null, apiBase: null, ov: null, lsv: null };
          try { out.href = location.href; } catch (e) {}
          try { out.apiBase = API_BASE; } catch (e) { out.apiBase = 'ERR'; }
          try { out.ov = typeof window.__RSP_API_BASE === 'string' ? window.__RSP_API_BASE : String(typeof window.__RSP_API_BASE); } catch (e) { out.ov = 'ERR'; }
          try { out.lsv = localStorage.getItem('rsp_api_base'); } catch (e) { out.lsv = 'ERR'; }
          function tryWorker(url) {
            return new Promise(function (res) {
              let w = null, got = false;
              try {
                w = new Worker(url);
                w.onmessage = function () { got = true; };
                w.postMessage({ cmd: 'start', ms: 80 });
                setTimeout(function () {
                  try { w.terminate(); } catch (e) {}
                  res(got);
                }, 900);
              } catch (e) { res(false); }
            });
          }
          try { out.blob = await tryWorker(URL.createObjectURL(new Blob([REC_TICK_WORKER_SRC], { type: 'application/javascript' }))); } catch (e) { out.blob = 'ERR'; }
          if (HAS_EXT) {
            try { out.file = await tryWorker(chrome.runtime.getURL('rec_worker.js')); } catch (e) { out.file = 'ERR'; }
          }
          out.interval = await new Promise(function (res) { let n = 0; const t = setInterval(function () { n++; if (n >= 3) { clearInterval(t); res(true); } }, 100); });
          /* fetch診断: API/live/play とカスタムm3u8(在れば)への到達性 */
          try {
            const r = await fetch(API_BASE + '/live/play?creatorOid=a1b2c3d4e5f60718293a4b5c6d7e8f90', { cache: 'no-store' });
            out.fetchApi = r.status + ':' + (await r.text()).slice(0, 40);
          } catch (e) { out.fetchApi = 'ERR:' + (e && e.message || e); }
          if (STATE.customM3u8) {
            try {
              const u = new URL(STATE.customM3u8, RECENV.pageUrl()).href;
              const r2 = await fetch(u, { cache: 'no-store' });
              out.fetchM3u8 = u + ' → ' + r2.status;
            } catch (e) { out.fetchM3u8 = 'ERR:' + (e && e.message || e); }
          }
          if (reply) reply(out);
        })();
        return true;
      default:
        if (reply) reply({ ok: false, error: 'unknown-type' });
        return false;
    }
  }

  /* v2.1.0 Step3: Firefox Event Page等のインプロセス背景ホスト向けにディスパッチャを公開 */
  if (typeof window !== 'undefined') {
    window.__RSP_BG_HOST__ = {
      dispatch: dispatch,
      isRecording: function () { return !!(STATE.recorder && STATE.recorder.recording); },
      recoveredParts: function () { return STATE.recoveredParts ? STATE.recoveredParts.slice() : []; },
      authStats: function () { return RSP_RECENV_HOOK.authStats(); },
      canaryEvidence: function () { return RSP_RECENV_HOOK.canaryEvidence(); }
    };
  }
  const IS_OFFSCREEN_DOC = typeof location !== 'undefined' && location.pathname && location.pathname.indexOf('offscreen.html') >= 0;
  if (HAS_EXT && IS_OFFSCREEN_DOC) {
    chrome.runtime.onMessage.addListener(function (msg, sender, reply) {
      if (msg.target !== 'rsp-host' || sender.id !== chrome.runtime.id || sender.tab) return false;
      return dispatch(msg, reply);
    });
  } else if (!HAS_EXT) {
    /* 試験ブリッジ(拡張なしページ読み込み時): E2Eから直接ハンドルを呼ぶ。
       実コア・実RECENV・実メッセージ生成をそのまま検証できる */
    window.__RSP_OFFSCREEN_TEST__ = {
      exportHost: EXPORT_HOST,
      start: function (p) { return handleStart(p,p&&p.testOwner); },
      stop: function () { return handleStop({},null); },
      status: function (oid) { return Promise.resolve(handleStatus({ oid: oid })); },
      tokenUpdate: function (p) { handleTokenUpdate(p); return Promise.resolve({ ok: true }); },
      pickStored: function () { return handlePickStored(); },
      events: EVT_LOG,
      logs: LOGTAIL,
      mp4Handoff: MP4_HANDOFF, /* v2.48.0(統合) */
      segStore: function () { return SEG_STORE; }, /* v2.51.0 */
      segAssembler: function () { return SEG_ASSEMBLER; }, /* v2.51.0 */
      segLastRun: function () { return SEG_LAST_RUN; }, /* v2.51.0 */
      segVerify: function (p) { return handleSegVerify(p || {}); }, /* v2.52.0 */
      set: function (p) { try { window.__RSP_TEST = p || {}; } catch (e) {} },
      opfsList: async function () {
        const root = await navigator.storage.getDirectory();
        const dir = await root.getDirectoryHandle('rsp_rec');
        const out = [];
        for await (const [name, h] of dir.entries()) { if (h.kind === 'file') out.push(name); }
        return out;
      },
      opfsRead: async function (name) {
        const root = await navigator.storage.getDirectory();
        const dir = await root.getDirectoryHandle('rsp_rec');
        const fh = await dir.getFileHandle(name);
        const f = await fh.getFile();
        return await f.arrayBuffer();
      },
      storageGet: function (k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
      auth: function () { return { jwt: AUTH.jwt, userOid: AUTH.userOid, nick: AUTH.nick }; },
      state: function () { return { hasExt: HAS_EXT, pageUrl: STATE.pageUrl, handleOk: STATE.handleOk, handleName: STATE.handleName }; }
    };
    /* ページ内メッセージブリッジ(window.postMessage)にも対応 */
    window.addEventListener('message', function (e) {
      if (e.source !== window || !e.data || !e.data.rspOffscreenReq) return;
      dispatch(e.data.msg, function (r) {
        try { window.postMessage({ rspOffscreenRep: true, rid: e.data.rid, reply: r }, '*'); } catch (e2) {}
      });
    });
  }
})();
