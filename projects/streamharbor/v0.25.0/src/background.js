if (typeof importScripts === 'function') importScripts('export_manager.js', 'creator_registry.js', 'media_catalog.js');
/* =====================================================================
   RPLAY Stable Player — Background Router & Event Page Host v2.3.1
   =====================================================================
   役割(設計書§4.2 / §4.4):
   - Chrome / Edge (MV3 Service Worker):
     chrome.offscreen APIで offscreen.html を生成・管理し、UIタブと
     offscreen document 間のメッセージを中継する(SW自身は状態を持たない)。
   - Firefox (MV3 Event Page — Step3 完成形):
     同一背景ウィンドウ(_generated_background_page.html)内の offscreen.js
     (window.__RSP_BG_HOST__)へインプロセスでディスパッチし、録画中は
     chrome.alarms キープアライブで Event Page のスリープを抑止する。
   - 共通機能:
     - rec.start/stop/status/token.update: UIタブ ⇄ 録画ホストの中継
     - rec.event/perm.request: 録画ホスト → 全rplay.liveタブへ配信
     - rec.notify: 録画ホスト → chrome.notifications(OS通知)
     - salvage: OPFS(rsp_rec/)へ確定書き込みされたパート/情報JSONを
       downloads APIでユーザーのダウンロード(RPLAY/配下)へ書き出し
   ===================================================================== */
const mediaCatalog=typeof RspMediaCatalog==='undefined'?null:RspMediaCatalog.create();
if(mediaCatalog&&chrome.webRequest&&chrome.webRequest.onHeadersReceived){
 if(chrome.webRequest.onBeforeSendHeaders){try{chrome.webRequest.onBeforeSendHeaders.addListener(d=>mediaCatalog.captureRequest(d),{urls:['https://*/*']},['requestHeaders','extraHeaders']);}catch(e){chrome.webRequest.onBeforeSendHeaders.addListener(d=>mediaCatalog.captureRequest(d),{urls:['https://*/*']},['requestHeaders']);}}
 if(chrome.webRequest.onErrorOccurred)chrome.webRequest.onErrorOccurred.addListener(d=>mediaCatalog.forgetRequest(d),{urls:['https://*/*']});
 chrome.webRequest.onHeadersReceived.addListener(d=>mediaCatalog.add(d),{urls:['https://*/*']},['responseHeaders']);
 if(chrome.tabs.onRemoved)chrome.tabs.onRemoved.addListener(id=>mediaCatalog.clear(id));
 if(chrome.tabs.onUpdated)chrome.tabs.onUpdated.addListener((id,change)=>{if(change.status==='loading')mediaCatalog.clear(id);});
}
const OFF_URL = 'offscreen.html';
const TAB_URLS = ['https://rplay.live/*', 'https://www.rplay.live/*'];
const KEEPALIVE_ALARM = 'rsp-bg-keepalive';

function hasOffscreenApi() {
  return typeof chrome !== 'undefined' && !!(chrome.offscreen && chrome.offscreen.createDocument);
}
function hasInprocHost() {
  return !hasOffscreenApi() && typeof window !== 'undefined' && !!(window.__RSP_BG_HOST__ && typeof window.__RSP_BG_HOST__.dispatch === 'function');
}

async function hasOffscreen() {
  if (!hasOffscreenApi()) return false;
  try {
    if (chrome.runtime.getContexts) {
      const ctxs = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
      return ctxs.length > 0;
    }
    return false;
  } catch (e) { return false; }
}
let creatingOffscreen = null;
async function ensureOffscreen() {
  if (!hasOffscreenApi()) return false;
  if (await hasOffscreen()) return true;
  if (!creatingOffscreen) creatingOffscreen = chrome.offscreen.createDocument({
    url: OFF_URL, reasons: ['BLOBS', 'LOCAL_STORAGE', 'WORKERS'],
    justification: '録画データと保存用Blob URLをタブ外で管理する'
  }).then(() => true, () => false).finally(() => { creatingOffscreen = null; });
  return await creatingOffscreen;
}

function setKeepalive(active) {
  try {
    if (!chrome.alarms) return;
    if (active) chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 0.4 });
    else chrome.alarms.clear(KEEPALIVE_ALARM);
  } catch (e) {}
}
try {
  if (chrome.alarms && chrome.alarms.onAlarm) {
    chrome.alarms.onAlarm.addListener((a) => {
      if (!a || a.name !== KEEPALIVE_ALARM) return;
      if (hasInprocHost() && !window.__RSP_BG_HOST__.isRecording()) {
        setKeepalive(false);
      }
    });
  }
} catch (e) {}

async function toOffscreen(msg) {
  /* Firefox Step3: 同一Event Page内の録画ホストへ直接ディスパッチ */
  if (hasInprocHost()) {
    return await new Promise((resolve) => {
      try {
        window.__RSP_BG_HOST__.dispatch(msg, (r) => resolve(r || { ok: false, error: 'no-reply' }));
      } catch (e) {
        resolve({ ok: false, error: String((e && e.message) || e) });
      }
    });
  }
  /* Chrome Step2: offscreen document を確保してメッセージ送信 */
  if (!(await ensureOffscreen())) return { ok: false, error: 'offscreen-unavailable' };
  for (let i = 0; i < 3; i++) {
    try {
      const r = await chrome.runtime.sendMessage({ ...msg, target: 'rsp-host' });
      if (r) return r;
    } catch (e) {
      const m = String((e && e.message) || e);
      if (m.indexOf('Receiving end does not exist') >= 0) {
        await new Promise((r) => setTimeout(r, 250));
        continue;
      }
      return { ok: false, error: m };
    }
  }
  return { ok: false, error: 'no-reply' };
}

async function toTabs(msg) {
  try {
    const tabs = await chrome.tabs.query({ url: TAB_URLS });
    for (const t of tabs) {
      try {
        const p = chrome.tabs.sendMessage(t.id, msg);
        if (p && p.catch) p.catch(function () {});
      } catch (e) {}
    }
  } catch (e) {}
}

let closeTimer = null;
function scheduleOffscreenClose() {
  if (!hasOffscreenApi()) return;
  if (closeTimer) clearTimeout(closeTimer);
  closeTimer = setTimeout(async () => {
    closeTimer = null;
    if (!(await hasOffscreen())) return;
    try {
      const st = await toOffscreen({type:'rec.status'});
      if (!st || st.recording || st.draining || !st.exportHost || st.exportHost.busy || st.exportHost.retained
        || (st.mp4Handoff && (st.mp4Handoff.busy || st.mp4Handoff.queued)) || await exportManager.pending()) return; /* v2.48.0(統合): MP4自動引渡し中はoffscreenを保持 */
      await chrome.offscreen.closeDocument();
    } catch (e) {}
  }, 120000);
}

const exportManager = RspExportManager.create(chrome, msg => toOffscreen(msg));
async function recoverExports(retry = false) {
  try { await toOffscreen({type:'export.sweep',retry}); await exportManager.reconcile();
    /* v2.48.0(統合): 起動時の取り残しTSパートをMP4自動引渡しへ(既定OFF・offscreen側で設定/録画状態を再ガード) */
    try { await toOffscreen({type:'mp4-handoff.sweep'}); } catch (e2) {} }
  catch(e) { toTabs({type:'rec.event',kind:'export-error',code:'EXPORT_RECOVERY_FAILED'}); }
}
chrome.downloads.onChanged.addListener(delta => {
  exportManager.changed(delta).then(() => scheduleOffscreenClose()).catch(() => toTabs({type:'rec.event',kind:'export-error',code:'EXPORT_JOURNAL_FAILED'}));
});
function offerExport(msg, reply) {
  exportManager.offer(msg).then(reply, () => reply({ok:false,error:'EXPORT_JOURNAL_FAILED'}));
  return true;
}

function handleHostMessage(msg, reply) {
  if (!msg || typeof msg !== 'object') return false;
  switch (msg.type) {
    case 'rec.event':
      if (msg.kind === 'state') {
        try {
          if (msg.on) {
            setKeepalive(true);
            if (chrome.action && chrome.action.setBadgeText) {
              chrome.action.setBadgeText({ text: msg.state === 'STANDBY' ? '⏸' : 'REC' });
            }
          } else {
            setKeepalive(false);
            if (chrome.action && chrome.action.setBadgeText) {
              chrome.action.setBadgeText({ text: '' });
            }
          }
        } catch (e) {}
      }
      toTabs(msg);
      return false;
    case 'rec.notify':
      try {
        chrome.notifications.create({
          type: 'basic', iconUrl: 'icons/icon128.png',
          title: String(msg.title || 'RPLAY Stable Player'),
          message: String(msg.body || '')
        });
      } catch (e) {}
      return false;
    case 'export.offer':
      if (reply) return offerExport(msg, reply);
      return false;
    case 'perm.request':
      toTabs(msg);
      return false;
    case 'rec.stopped':
      setKeepalive(false);
      try { if (chrome.action && chrome.action.setBadgeText) chrome.action.setBadgeText({ text: '' }); } catch (e) {}
      toTabs(msg);
      scheduleOffscreenClose();
      maybeOpenConverter(); /* v2.39.0: 設定ON時のみ変換画面を開く(手動停止・自然終了の全経路) */
      return false;
    default:
      return false;
  }
}

/* Firefox Step3: 同一ウィンドウ内の offscreen.js からのイベントを直接受領 */
if (typeof window !== 'undefined') {
  window.__RSP_SW_SINK__ = handleHostMessage;
}

function dashboardDefaults(){return storageGetBounded('rsp_dashboard_defaults').then(function(v){
  if(chrome.runtime.lastError||!v||typeof v!=='object')throw Error('START_SETTINGS_UNAVAILABLE');
  const d=v.rsp_dashboard_defaults;
  if(d!==undefined&&(!d||typeof d!=='object'||Array.isArray(d)||
    ['autoStartAllowed','enabled','follow','recAudio','preferJapaneseAudio','inheritQuery','mp4Handover','mp4AutoHandoff'].some(k=>d[k]!==undefined&&typeof d[k]!=='boolean')||
    (d.splitMin!==undefined&&(typeof d.splitMin!=='number'||!Number.isFinite(d.splitMin)||d.splitMin<0||d.splitMin>1440))))throw Error('START_SETTINGS_UNAVAILABLE');
  return v;
},function(){throw Error('START_SETTINGS_UNAVAILABLE');});}
/* ---- v2.38.0: 設定読込の無応答timeout ----
   chrome.storage.local.getが応答しない(拡張プロセス不調等)でも開始経路を
   永久に待機させない。既定3秒でSTORAGE_READ_TIMEOUT→呼び出し側は
   START_SETTINGS_UNAVAILABLEと同じfail-closed扱い。遅到着した応答は
   既に決着したPromiseへは何もせず、timer解除も漏らさない。 */
const RSP_SETTINGS_READ_MS=(typeof globalThis==='object'&&globalThis&&Number.isFinite(globalThis.__RSP_TEST_SETTINGS_READ_MS)&&globalThis.__RSP_TEST_SETTINGS_READ_MS>0)?globalThis.__RSP_TEST_SETTINGS_READ_MS:5000;
function storageGetBounded(keys,ms){
  const bound=ms>0?ms:RSP_SETTINGS_READ_MS;
  return new Promise((resolve,reject)=>{
    if(!chrome.storage||!chrome.storage.local)return reject(Error('STORAGE_UNAVAILABLE'));
    let done=false,timer=0;
    const finish=(ok,val)=>{if(done)return;done=true;if(timer)try{clearTimeout(timer);}catch(e){}if(ok)resolve(val);else reject(val);};
    if(typeof setTimeout==='function'){try{timer=setTimeout(()=>finish(false,Error('STORAGE_READ_TIMEOUT')),bound);}catch(e){timer=0;}}
    try{chrome.storage.local.get(keys,v=>finish(!!(v&&typeof v==='object'),v&&typeof v==='object'?v:Error('STORAGE_BAD_VALUE')));}
    catch(e){finish(false,Error('STORAGE_READ_THROWN'));}
  });
}
/* ---- v2.38.0: 開始理由と実効policy(表示専用・best-effort) ----
   rec.start成功時に自動/手動と外部設定適用の有無を記録しmonitor.statusへ乗せる。
   SW再起動後も同一ブラウザセッション内ならchrome.storage.sessionから復元する
   (無ければ「不明」)。秘密は含まない。 */
let rspLastStart=null;
try{const _sess=chrome.storage&&chrome.storage.session;if(_sess&&typeof _sess.get==='function')_sess.get('rsp_last_start',v=>{try{
  const s=v&&v.rsp_last_start;
  if(s&&typeof s==='object'&&(s.reason==='auto'||s.reason==='manual'))rspLastStart={oid:String(s.oid||'').toLowerCase(),reason:s.reason,at:Number.isFinite(s.at)?s.at:0,appliedExternal:s.appliedExternal===true};
}catch(e){}});}catch(e){}
function rspStartInfoFor(st){
  if(!st||(!st.recording&&!st.draining))return null;
  const oid=String(st.oid||'').toLowerCase();
  if(rspLastStart&&rspLastStart.oid===oid&&rspLastStart.oid)return {reason:rspLastStart.reason,at:rspLastStart.at,appliedExternal:rspLastStart.appliedExternal};
  return {reason:'unknown'};
}
function rspEffectivePolicy(d){
  return {autoStartAllowed:!(d&&d.autoStartAllowed===false),externalApplied:!!(d&&d.enabled===true),
    external:{follow:(d&&typeof d.follow==='boolean')?d.follow:null,recAudio:(d&&typeof d.recAudio==='boolean')?d.recAudio:null,
      preferJapaneseAudio:(d&&typeof d.preferJapaneseAudio==='boolean')?d.preferJapaneseAudio:null,
      inheritQuery:(d&&typeof d.inheritQuery==='boolean')?d.inheritQuery:null,
      mp4AutoHandoff:(d&&typeof d.mp4AutoHandoff==='boolean')?d.mp4AutoHandoff:null,
      splitMin:(d&&Number.isFinite(d.splitMin)&&d.splitMin>=0&&d.splitMin<=1440)?d.splitMin:null}};
}
/* ---- v2.39.0: BG録画開始時の名前収穫(表示専用・秘密なし) ----
   rec.start成功時のpayload.creatorName(og:title由来・v2.31系統の移植)を
   登録済みIDの範囲でのみrsp_creator_metaへ反映する(既存url保持・登録外へは
   書かない・上限100件)。registry commitと同じWeb Locksで排他し、失敗は
   静かに諦める(派生データ・失敗許容)。*/
function rememberCreatorMeta(oid, name) {
  (async function () {
    try {
      if (!chrome.storage || !chrome.storage.local) return;
      if (typeof navigator === 'undefined' || !navigator.locks || typeof navigator.locks.request !== 'function') return;
      const id = String(oid || '').toLowerCase();
      if (!/^[a-f0-9]{24}$/.test(id)) return;
      const n = String(name || '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 100);
      if (!n) return;
      await navigator.locks.request('rsp-creator-registry-save-v1', async () => {
        const v = await new Promise(function (res) { try { chrome.storage.local.get(['rsp_registered_creators', 'rsp_creator_meta'], function (x) { res(x && typeof x === 'object' ? x : {}); }); } catch (e) { res({}); } });
        const ids = Array.isArray(v.rsp_registered_creators) ? v.rsp_registered_creators.filter(function (x) { return typeof x === 'string' && /^[a-f0-9]{24}$/i.test(x); }).map(function (x) { return x.toLowerCase(); }) : [];
        if (!ids.includes(id)) return; /* 登録済み配信者だけ(登録外へ書かない) */
        const raw = (v.rsp_creator_meta && typeof v.rsp_creator_meta === 'object' && !Array.isArray(v.rsp_creator_meta)) ? v.rsp_creator_meta : {};
        const cur = raw[id];
        if (cur && typeof cur === 'object' && cur.name === n) return; /* 不変なら書かない */
        raw[id] = { name: n, url: (cur && typeof cur.url === 'string') ? cur.url : '', at: Date.now() };
        let clean = raw;
        try { if (typeof RspCreatorRegistry !== 'undefined' && RspCreatorRegistry && typeof RspCreatorRegistry.sanitizeMeta === 'function') clean = RspCreatorRegistry.sanitizeMeta(raw); } catch (e) { clean = raw; }
        const keys = Object.keys(clean);
        if (keys.length > 100) { keys.sort(function (a, b) { return ((clean[a] && clean[a].at) || 0) - ((clean[b] && clean[b].at) || 0); }); while (keys.length > 100) delete clean[keys.shift()]; }
        await new Promise(function (res) { try { chrome.storage.local.set({ rsp_creator_meta: clean }, function () { res(); }); } catch (e) { res(); } });
      });
    } catch (e) {}
  })();
}
/* ---- v2.39.0: BG停止後のMP4変換画面の自動引渡し(設定ON時) ----
   rec.stoppedの全経路(手動停止・自然終了)で呼ぶ。offscreenが停止前に
   rsp_last_sessionを非同期で書くため、最大3秒まで新しさを確認しながら
   読む(古い台帳なら開かない)。同一セッションの二重開 prevented by
   chrome.storage.sessionのat刻印。全てbest-effort(失敗は静か)。 */
let _rspHandoverQueue = Promise.resolve();
function maybeOpenConverter() {
  _rspHandoverQueue = _rspHandoverQueue.then(async function () {
    try {
      let d = null;
      try { d = (await dashboardDefaults()).rsp_dashboard_defaults; } catch (e) { return; }
      if (!d || d.mp4Handover !== true) return;
      const stoppedAt = Date.now();
      let m = null;
      for (let i = 0; i < 30; i++) { /* 新しい台帳が現れるまで最大3秒待つ(100ms間隔) */
        await new Promise(function (r) { try { setTimeout(r, 100); } catch (e) { r(); } });
        const cand = await new Promise(function (res) { try { chrome.storage.local.get('rsp_last_session', function (v) { res(v && typeof v === 'object' ? v.rsp_last_session : null); }); } catch (e) { res(null); } });
        if (cand && typeof cand === 'object' && Number.isFinite(cand.at) && cand.at >= stoppedAt - 5000) { m = cand; break; }
      }
      if (!m || typeof m !== 'object' || m.version !== 1 || !Array.isArray(m.parts) || !m.parts.length) return;
      const at = Number(m.at);
      if (!Number.isFinite(at) || at <= 0) return;
      const seen = await new Promise(function (res) { try { if (chrome.storage.session && typeof chrome.storage.session.get === 'function') chrome.storage.session.get('rsp_mp4_handover_at', function (v) { res(v && typeof v === 'object' ? v.rsp_mp4_handover_at : 0); }); else res(0); } catch (e) { res(0); } });
      if (seen === at) return;
      await new Promise(function (res) { try { if (chrome.storage.session && typeof chrome.storage.session.set === 'function') chrome.storage.session.set({ rsp_mp4_handover_at: at }, function () { res(); }); else res(); } catch (e) { res(); } });
      chrome.tabs.create({ url: chrome.runtime.getURL('mp4_convert.html') });
    } catch (e) {}
  });
  return _rspHandoverQueue;
}
/* ---- v2.40.0: 任意HLS URL録画(dashboard経由) — 制御権の所在 ----
   URLセッションの制御権は、BGが生成した固定identity(chrome.storage.sessionへ
   保存・同一ブラウザセッション内でSW再起動しても同一)が持つ。dashboardは
   拡張内ページ(信頼されたUI)のため、どのdashboardインスタンスからでも停止
   できる。RPLAYページのセッションとの排他は単一recorder構造が保証
   (busy)。SW再起動で記憶が失われた場合のみ、urlSessionであることを確認
   のうえclaimで所有権を再取得する(他者のセッションは拒否)。 */
let _urlOwner = null;
function rspUrlOwnerValid(x){return !!(x&&Number.isInteger(x.tabId)&&x.tabId>=0&&typeof x.clientId==='string'&&/^[a-f0-9]{32}$/.test(x.clientId)&&typeof x.documentId==='string'&&x.documentId.length<=200);}
function rspRandomHex32(){
  try {
    const b=new Uint8Array(16);crypto.getRandomValues(b);
    let s='';for(let i=0;i<16;i++)s+=('0'+b[i].toString(16)).slice(-2);
    return s;
  } catch (e) { /* SW本来は必ずcryptoを持つ。試験コンテキスト等の代替 */
    let s='';for(let i=0;i<32;i++)s+='0123456789abcdef'.charAt(Math.floor(Math.random()*16));
    return s;
  }
}
async function urlOwner() {
  if (rspUrlOwnerValid(_urlOwner)) return _urlOwner;
  try {
    const v = await new Promise(function (res) { try { if (!(chrome.storage && chrome.storage.session && typeof chrome.storage.session.get === 'function')) return res(null); chrome.storage.session.get('rsp_url_owner', function (x) { res(x && typeof x === 'object' ? x.rsp_url_owner : null); }); } catch (e) { res(null); } });
    if (rspUrlOwnerValid(v)) { _urlOwner = v; return v; }
  } catch (e) {}
  const owner = { tabId: Math.floor(Math.random() * 1073741823) + 1, clientId: rspRandomHex32(), documentId: 'rsp-url-session-v1' };
  try { await new Promise(function (res) { try { if (chrome.storage && chrome.storage.session && typeof chrome.storage.session.set === 'function') chrome.storage.session.set({ rsp_url_owner: owner }, function () { res(); }); else res(); } catch (e) { res(); } }); } catch (e) {}
  _urlOwner = owner;
  return owner;
}
chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (!msg || typeof msg !== 'object') return false;
  if (msg.target === 'rsp-host') return false;
  const own = sender.id === chrome.runtime.id;
  const fromOff = own && !sender.tab && sender.url === chrome.runtime.getURL('offscreen.html');
  const fromPicker = own && !sender.tab && sender.url === chrome.runtime.getURL('picker.html');
  const fromContent = own && !!(sender.tab && Number.isInteger(sender.tab.id)) && /^https:\/\/(www\.)?rplay\.live\//.test(sender.url || '');

  const fromPopup=own && !sender.tab && sender.url===chrome.runtime.getURL('popup.html') && (!sender.frameId || sender.frameId===0);
  const fromDashboard=own && sender.url===chrome.runtime.getURL('dashboard.html') && (!sender.frameId || sender.frameId===0);
  const fromInspector=own&&typeof sender.url==='string'&&sender.url.split('#')[0]===chrome.runtime.getURL('media_inspect.html')&&(!sender.frameId||sender.frameId===0);
  if((fromDashboard||fromInspector)&&msg.type==='media.candidates.list'){reply({ok:true,items:mediaCatalog?mediaCatalog.list():[]});return false;}
  if(fromDashboard&&msg.type==='media.candidates.clear'){if(mediaCatalog)mediaCatalog.clear();reply({ok:true});return false;}
  if(fromDashboard&&msg.type==='media.candidate.open'){
    if(!mediaCatalog||!mediaCatalog.get(msg.id)){reply({ok:false,error:'CANDIDATE_EXPIRED'});return false;}
    chrome.tabs.create({url:chrome.runtime.getURL('media_inspect.html')+'#'+encodeURIComponent(msg.id)}).then(()=>reply({ok:true}),()=>reply({ok:false}));return true;
  }
  if((fromInspector||fromDashboard)&&msg.type==='media.candidate.get'){const e=mediaCatalog&&mediaCatalog.get(msg.id);reply(e?{ok:true,url:e.url,mediaType:e.mediaType,context:e.context||{},capturedAt:e.at}:{ok:false,error:'CANDIDATE_EXPIRED'});return false;}
  /* v0.21: A slow OPFS host or export journal must not hold the popup indefinitely.
     The result is read-only and timeout failures never become 'idle' or 'saved'.
     Late resolutions are observed by Promise.race but never used in the reply. */
  function popupBounded(read,ms){
    if(typeof setTimeout!=='function')return Promise.resolve().then(read).catch(()=>null);
    let timer;
    const timeout=new Promise(resolve=>{timer=setTimeout(()=>resolve(null),ms);});
    return Promise.race([Promise.resolve().then(read).catch(()=>null),timeout])
      .finally(()=>{if(timer!==undefined)clearTimeout(timer);});
  }
  if(((fromDashboard||fromInspector)&&msg.type==='monitor.status')||(fromPopup&&msg.type==='popup.status')){
    (async()=>{try{
      const owner=await urlOwner();
      const recorderReadStartedAt=Date.now(); // Conservative upper bound on snapshot age.
      const readHost=()=>toOffscreen({type:'rec.status',payload:{},control:owner});
      // The popup's 4s request timeout covers both stages (2.5s host + 1s ledger).
      const st=fromPopup?await popupBounded(readHost,2500):await readHost();
      // Host cannot attest its exact capture time; the read START is a conservative bound.
      const capturedAt=fromPopup?recorderReadStartedAt:Date.now();
      if(fromPopup && (!st || st.ok===false || typeof st.recording!=='boolean')){
        reply({ok:false,error:'STATUS_UNAVAILABLE'});return;
      }
      // A blocked ledger does not mask a valid recorder state. Unknown counts are
      // never represented as zeros or claimed complete.
      let ex=null;
      if(fromPopup)ex=await popupBounded(()=>exportManager.status(),1000);
      else try{ex=await exportManager.status();}catch(e){ex=null;}
      const ledgerCapturedAt=fromPopup&&ex&&typeof ex==='object'?Date.now():null;
      if(fromPopup){
        /* v0.19: private, read-only popup projection. Never forward source URL,
           session IDs, file paths, settings or unbounded export payloads. */
        const count=n=>Number.isSafeInteger(n)&&n>=0?n:null;
        const rawName=typeof st.creatorName==='string'?st.creatorName.trim():'';
        const safeName=/(?:https?:\/\/|\b(?:bearer|token|secret|cookie|authorization|password)\s*[:=])/i.test(rawName)?'':rawName.slice(0,90);
        const a=st.audioTransition&&typeof st.audioTransition==='object'?st.audioTransition:null;
        reply({ok:true,capturedAt,ledgerCapturedAt,ledgerScope:'all-recorded-exports',recording:st.recording===true,draining:st.draining===true,
          state:st.state==='STANDBY'?'STANDBY':st.state==='ACTIVE'?'ACTIVE':st.state==='IDLE'?'IDLE':'UNKNOWN',
          medium:typeof st.medium==='string'&&/^[a-z0-9-]{1,20}$/i.test(st.medium)?st.medium:'',
          creatorName:safeName,urlSession:st.urlSession===true,
          // rec.status returns at most the last 100 entries. While idle it may return
          // the previous session's entries: never present these as 'current'.
          partCount:st.recording===true&&Array.isArray(st.parts)?count(st.parts.length):null,
          exports:{verified:count(ex&&ex.verified),requested:count(ex&&ex.requested),unknown:count(ex&&ex.unknown),failed:count(ex&&ex.failed)},
          audioTransition:a?{abandonedQueuedOnSourceChange:count(a.abandonedQueuedOnSourceChange),abandonedQueuedHistoryComplete:a.abandonedQueuedHistoryComplete===true,activeSegmentAtSourceChange:count(a.activeSegmentAtSourceChange),staleSegmentResultsIgnored:count(a.staleSegmentResultsIgnored)}:null});
        return;
      }
      let policy=null;try{const pref=await dashboardDefaults();policy=rspEffectivePolicy(pref.rsp_dashboard_defaults);}catch(e){policy={unavailable:true};}
      reply({ok:true,recording:!!st.recording,draining:!!st.draining,oid:st.oid||'',state:st.state||'IDLE',medium:st.medium||'',creatorName:st.creatorName||'',title:st.title||'',urlSession:st.urlSession===true,urlSource:st.urlSource||'',parts:(st.parts||[]).slice(-20),audioTransition:st.audioTransition&&typeof st.audioTransition==='object'?{running:st.audioTransition.running===true,abandonedQueuedOnSourceChange:Number.isSafeInteger(st.audioTransition.abandonedQueuedOnSourceChange)&&st.audioTransition.abandonedQueuedOnSourceChange>=0?st.audioTransition.abandonedQueuedOnSourceChange:null,abandonedQueuedHistoryComplete:st.audioTransition.abandonedQueuedHistoryComplete===true,activeSegmentAtSourceChange:Number.isSafeInteger(st.audioTransition.activeSegmentAtSourceChange)&&st.audioTransition.activeSegmentAtSourceChange>=0?st.audioTransition.activeSegmentAtSourceChange:null,staleSegmentResultsIgnored:Number.isSafeInteger(st.audioTransition.staleSegmentResultsIgnored)&&st.audioTransition.staleSegmentResultsIgnored>=0?st.audioTransition.staleSegmentResultsIgnored:null,stopReason:['404','stall','flv','standby','off','resolve','write_error','unsupported'].includes(st.audioTransition.stopReason)?st.audioTransition.stopReason:''}:null,exports:ex,mp4Handoff:st.mp4Handoff?{enabled:st.mp4Handoff.enabled===true,busy:st.mp4Handoff.busy===true,queued:Number(st.mp4Handoff.queued)||0,last:st.mp4Handoff.last?{status:st.mp4Handoff.last.status,reason:st.mp4Handoff.last.reason||'',errorCode:st.mp4Handoff.last.errorCode||''}:null}:null,policy:policy,start:rspStartInfoFor(st)});}catch(e){reply({ok:false,error:'STATUS_UNAVAILABLE'});}})();return true;
  }
  /* v2.38.0: dashboard外部予約閲覧 — 登録一覧を読みBGホストへ巡回を依頼(読取専用)。
     トークンはUIタブから受け渡された自分の会話のみ(offscreenが保持していなければnologin)。 */
  if(fromDashboard && ['schedules.status','schedules.cancel'].includes(msg.type)){
    if(typeof msg.requestId!=='string'||!/^[a-f0-9]{32}$/.test(msg.requestId)){reply({ok:false,error:'bad-request'});return false;}
    toOffscreen({type:msg.type,target:'rsp-host',payload:{requestId:msg.requestId}}).then(r=>reply(r||{ok:false,error:'no-reply'}),()=>reply({ok:false,error:'scan-unavailable'}));return true;
  }
  if(fromDashboard && msg.type==='schedules.scan'){
    (async()=>{
      try{
        const v=await storageGetBounded(['rsp_registered_creators','rsp_creator_meta']);
        const ids=Array.isArray(v.rsp_registered_creators)?v.rsp_registered_creators.filter(x=>typeof x==='string'&&/^[a-f0-9]{24}$/i.test(x)).map(x=>x.toLowerCase()).slice(0,100):[];
        if(!ids.length){reply({ok:false,error:'no-ids'});return;}
        const r=await toOffscreen({type:'schedules.scan',target:'rsp-host',payload:{ids:ids,force:msg.force===true,...(msg.requestId===undefined?{}:{requestId:msg.requestId})}});
        reply(r&&typeof r==='object'?r:{ok:false,error:'no-reply'});
      }catch(e){reply({ok:false,error:'scan-unavailable'});}
    })();
    return true;
  }
  /* v2.50.0/v2.51.0: ディスクバックド取得(segment_store Stage 3/4結線) — dashboard/診断画面からの
     明示指示のみ。保存済み合意設定(diskBackedAcquire・既定OFF)を確認してからoffscreen
     ホストへ転送する。ホスト側も録画状態とagreeの二重ゲートを持つ。
     v2.51.0修正: 候補id→URLの解決をBG側(mediaCatalog)で行い、解決済みitemsを内部
     メッセージで渡す(旧実装はURLを渡していなかったため実機では全候補が
     CANDIDATE_EXPIRED/CANDIDATES_UNAVAILABLEになっていた)。URL は BG→offscreen の
     in-memory 転送のみに現れ、ログ・証跡・統計・保存へは出力しない。結果は
     zero-secretの統計・分類のみ。 */
  function segResolveIds(ids){
    const items=[],expired=[];
    for(const id of ids){
      let url=null;
      try{const c=mediaCatalog?mediaCatalog.get(id):null;if(c&&typeof c.url==='string')url=c.url;}catch(e){}
      let ok=false;
      if(url){try{const u=new URL(url);ok=u.protocol==='http:'||u.protocol==='https:';}catch(e){}}
      if(ok)items.push({id:id,url:url});else expired.push(id);
    }
    return {items,expired};
  }
  async function segAgreement(){
    try{const pref=await dashboardDefaults();const d=pref.rsp_dashboard_defaults;return !!(d&&d.diskBackedAcquire===true);}
    catch(e){return false;}
  }
  if((fromDashboard||fromInspector)&&msg.type==='seg.acquire'){
    (async()=>{
      try{
        if(!(await segAgreement())){reply({ok:false,error:'PIPELINE_NOT_AGREED'});return;}
        const ids=Array.isArray(msg.payload&&msg.payload.ids)?msg.payload.ids.filter(x=>typeof x==='string'&&x.length>=1&&x.length<=256).slice(0,64):[];
        if(!ids.length){reply({ok:false,error:'no-ids'});return;}
        const {items,expired}=segResolveIds(ids);
        if(!items.length){reply({ok:false,error:'no-ids'});return;}
        const r=await toOffscreen({type:'seg.acquire',target:'rsp-host',payload:{items,agree:true}});
        if(r&&r.ok&&expired.length&&Array.isArray(r.results))for(const e of expired)r.results.push({candidateId:e,ok:false,error:'CANDIDATE_EXPIRED'});
        if(r&&r.ok&&expired.length){r.requested+=expired.length;r.skipped=(r.skipped||0)+expired.length;}
        if(r&&r.ok)scheduleOffscreenClose();
        reply(r&&typeof r==='object'?r:{ok:false,error:'no-reply'});
      }catch(e){reply({ok:false,error:'seg-unavailable'});}
    })();
    return true;
  }
  if((fromDashboard||fromInspector)&&(msg.type==='seg.assemble'||msg.type==='seg.artifacts'||msg.type==='seg.export'||msg.type==='seg.verify')){
    (async()=>{
      try{
        if(!(await segAgreement())){reply({ok:false,error:'PIPELINE_NOT_AGREED'});return;}
        let payload={agree:true};
        if(msg.type!=='seg.artifacts'){
          if(msg.type==='seg.export'||msg.type==='seg.verify'){
            const artifactId=String(msg.payload&&msg.payload.artifactId||'').trim();
            if(!/^[a-f0-9]{8,64}$/i.test(artifactId)){reply({ok:false,error:'BAD_ARTIFACT_ID'});return;}
            payload={agree:true,artifactId:artifactId,name:typeof msg.payload.name==='string'?msg.payload.name:''};
            if(msg.type==='seg.verify')delete payload.name;
          }else{
            const ids=Array.isArray(msg.payload&&msg.payload.ids)?msg.payload.ids.filter(x=>typeof x==='string'&&x.length>=1&&x.length<=256).slice(0,64):[];
            if(!ids.length){reply({ok:false,error:'no-ids'});return;}
            const {items}=segResolveIds(ids);
            if(!items.length){reply({ok:false,error:'no-ids'});return;}
            payload={agree:true,items,allowGaps:msg.payload&&msg.payload.allowGaps===true};
          }
        }
        const r=await toOffscreen({type:msg.type,target:'rsp-host',payload});
        if(r&&r.ok)scheduleOffscreenClose();
        reply(r&&typeof r==='object'?r:{ok:false,error:'no-reply'});
      }catch(e){reply({ok:false,error:'seg-unavailable'});}
    })();
    return true;
  }
  if((fromDashboard||fromInspector)&&msg.type==='seg.stats'){
    (async()=>{
      try{
        const r=await toOffscreen({type:'seg.stats',target:'rsp-host',payload:{}});
        if(r&&r.ok)scheduleOffscreenClose();
        reply(r&&typeof r==='object'?r:{ok:false,error:'no-reply'});
      }catch(e){reply({ok:false,error:'seg-unavailable'});}
    })();
    return true;
  }
  if(fromDashboard&&msg.type==='seg.clear'){
    (async()=>{
      try{
        let agree=false;
        try{const pref=await dashboardDefaults();const d=pref.rsp_dashboard_defaults;agree=!!(d&&d.diskBackedAcquire===true);}catch(e){agree=false;}
        if(!agree){reply({ok:false,error:'PIPELINE_NOT_AGREED'});return;}
        const r=await toOffscreen({type:'seg.clear',target:'rsp-host',payload:{agree:true}});
        if(r&&r.ok)scheduleOffscreenClose();
        reply(r&&typeof r==='object'?r:{ok:false,error:'no-reply'});
      }catch(e){reply({ok:false,error:'seg-unavailable'});}
    })();
    return true;
  }
  /* v2.40.0: 任意HLS URL録画 — dashboardからの開始。URL検証と外部設定の適用
     (follow/flvは強制OFF)をしてから、BG固定ownerでoffscreenへurl.start。 */
  if ((fromDashboard || fromInspector) && msg.type === 'url.start') {
    (async () => {
      try {
        const raw = String(msg.payload && msg.payload.url || '');
        if (!raw || raw.length > 2048) return reply({ ok: false, error: 'bad-url' });
        let u; try { u = new URL(raw); } catch (e) { return reply({ ok: false, error: 'bad-url' }); }
        if (u.protocol !== 'https:') return reply({ ok: false, error: 'https-only' });
        if (closeTimer) { clearTimeout(closeTimer); closeTimer = null; }
        const owner = await urlOwner();
        const settings = { recAudio: false, preferJapaneseAudio: false, inheritQuery: false, splitMin: 0, mp4AutoHandoff: false, bestQ: true };
        try {
          const pref = await dashboardDefaults(); const d = pref.rsp_dashboard_defaults;
          if (d && d.enabled === true) {
            if (typeof d.recAudio === 'boolean') settings.recAudio = d.recAudio;
            if (typeof d.preferJapaneseAudio === 'boolean') settings.preferJapaneseAudio = d.preferJapaneseAudio;
            if (typeof d.inheritQuery === 'boolean') settings.inheritQuery = d.inheritQuery;
            if (typeof d.mp4AutoHandoff === 'boolean') settings.mp4AutoHandoff = d.mp4AutoHandoff;
            if (Number.isFinite(d.splitMin) && d.splitMin >= 0 && d.splitMin <= 1440) settings.splitMin = d.splitMin;
          }
        } catch (e) { /* 手動開始のため設定不可でも既定値で開始できる */ }
        const r = await toOffscreen({ type: 'url.start', payload: { url: u.href, label: String(msg.payload.label || '').slice(0, 80), settings: settings }, control: owner });
        if (r && r.ok) {
          setKeepalive(true);
          rspLastStart = { oid: String(r.oid || '').toLowerCase(), reason: 'manual', at: Date.now(), appliedExternal: false };
          try { const _s = chrome.storage && chrome.storage.session; if (_s && typeof _s.set === 'function') _s.set({ rsp_last_start: rspLastStart }, function () {}); } catch (e) {}
        }
        reply(r && typeof r === 'object' ? r : { ok: false, error: 'no-reply' });
      } catch (e) { reply({ ok: false, error: 'url-start-failed' }); }
    })();
    return true;
  }
  /* v2.40.0: 任意HLS URL録画 — dashboardからの停止。URLセッションだけを対象
     にする(RPLAY配信のセッションは当該ページが所有 — ここからは止めない)。
     SW再起動でowner記憶が失われた場合だけclaimで再取得する。 */
  if ((fromDashboard || fromInspector) && msg.type === 'url.stop') {
    (async () => {
      try {
        const owner = await urlOwner();
        const st = await toOffscreen({ type: 'rec.status', payload: {}, control: owner });
        if (!st || typeof st !== 'object') return reply({ ok: false, error: 'no-reply' });
        if (!st.recording && !st.draining) return reply({ ok: false, error: 'not-recording' });
        if (st.urlSession !== true) return reply({ ok: false, error: 'not-url-session' });
        let ctrl = st.control;
        if (!ctrl && st.claim) {
          const c = await toOffscreen({ type: 'rec.claim', payload: { sessionId: st.claim.sessionId, epoch: st.claim.epoch, oid: st.claim.oid }, control: owner });
          if (c && c.ok && c.control) ctrl = c.control;
        }
        if (!ctrl) return reply({ ok: false, error: 'no-control' });
        const r = await toOffscreen({ type: 'rec.stop', payload: { sessionId: ctrl.sessionId, epoch: ctrl.epoch, oid: ctrl.oid }, control: owner });
        reply(r && typeof r === 'object' ? r : { ok: false, error: 'no-reply' });
      } catch (e) { reply({ ok: false, error: 'url-stop-failed' }); }
    })();
    return true;
  }
  if (fromContent) {
    if (sender.frameId !== undefined && sender.frameId !== 0) { reply({ok:false,error:'top-frame-required'}); return false; }
    const identity = {tabId:sender.tab.id,documentId:typeof sender.documentId==='string'?sender.documentId:'',clientId:msg.clientId};
    const controlled = payload => ({...msg,payload:payload||msg.payload||{},control:identity});
    switch (msg.type) {
      case 'registry.list':
        (async()=>{try{
          const v=await storageGetBounded(['rsp_registered_creators','rsp_creator_meta']);
          const ids=Array.isArray(v.rsp_registered_creators)?v.rsp_registered_creators.filter(x=>typeof x==='string'&&/^[a-f0-9]{24}$/i.test(x)).slice(0,100):[];
          let meta={};try{if(typeof RspCreatorRegistry!=='undefined'&&RspCreatorRegistry&&typeof RspCreatorRegistry.sanitizeMeta==='function')meta=RspCreatorRegistry.sanitizeMeta(v.rsp_creator_meta);}catch(e){meta={};}
          const out={};for(const id of ids)if(meta[id])out[id]=meta[id];
          reply({ids:ids,meta:out});
        }catch(e){reply({ids:[],meta:{}});}})();
        return true;
      case 'bg.cap': {
        const isOff = hasOffscreenApi();
        const isInproc = hasInprocHost();
        reply({
          offscreen: isOff || isInproc,
          mode: isOff ? 'offscreen' : (isInproc ? 'firefox-bg' : 'none'),
          fsa: isOff
        });
        return false;
      }
      case 'rec.start':
        (async () => {
          if (closeTimer) { clearTimeout(closeTimer); closeTimer = null; }
          let pref;try{pref=await dashboardDefaults();}catch(e){reply({ok:false,error:'START_SETTINGS_UNAVAILABLE'});return;}const d=pref.rsp_dashboard_defaults;if(msg.payload&&msg.payload.automatic===true&&d&&d.autoStartAllowed===false){reply({ok:false,error:'AUTO_START_DISABLED'});return;}const settings={...(msg.payload&&msg.payload.settings||{})};if(d&&d.enabled===true){for(const k of ['follow','recAudio','preferJapaneseAudio','inheritQuery','mp4AutoHandoff'])if(typeof d[k]==='boolean')settings[k]=d[k];if(Number.isFinite(d.splitMin)&&d.splitMin>=0&&d.splitMin<=1440)settings.splitMin=d.splitMin;}
          const r = await toOffscreen(controlled({...msg.payload,settings,pageUrl:sender.url}));
          if (r && r.ok) {
            setKeepalive(true);
            rspLastStart={oid:String(msg.payload&&msg.payload.oid||'').toLowerCase(),reason:msg.payload&&msg.payload.automatic===true?'auto':'manual',at:Date.now(),appliedExternal:!!(d&&d.enabled===true)};
            try{const _sess=chrome.storage&&chrome.storage.session;if(_sess&&typeof _sess.set==='function')_sess.set({rsp_last_start:rspLastStart},()=>{});}catch(e){}
            /* v2.39.0: 開始時の名前収穫(登録済みだけ・best-effort) */
            if (msg.payload && msg.payload.oid && typeof msg.payload.creatorName === 'string') rememberCreatorMeta(msg.payload.oid, msg.payload.creatorName);
          }
          reply(r);
        })();
        return true;
      case 'rec.stop':
      case 'rec.claim':
      case 'token.update':
        (async () => reply(await toOffscreen(controlled())))();
        return true;
      case 'media.inspect.open':
        chrome.tabs.create({url:chrome.runtime.getURL('media_inspect.html')}).then(()=>reply({ok:true}),()=>reply({ok:false}));
        return true;
      case 'mp4.open':
        chrome.tabs.create({url:chrome.runtime.getURL('mp4_convert.html')}).then(()=>reply({ok:true}),()=>reply({ok:false}));
        return true;
      case 'recovery.open':
        chrome.tabs.create({url:chrome.runtime.getURL('recovery.html')}).then(()=>reply({ok:true}),()=>reply({ok:false}));
        return true;
      case 'export.retry':
        recoverExports(true).then(() => reply({ok:true}), () => reply({ok:false}));
        return true;
      case 'rec.status':
        (async () => {const st = await toOffscreen(controlled()); try { st.exports = await exportManager.status(); } catch(e) { st.exportError = 'JOURNAL_UNAVAILABLE'; } reply(st);})();
        return true;
      case 'pick.open':
        if (!hasOffscreenApi()) {
          reply({ ok: false, error: 'fsa-unsupported-in-firefox' });
          return false;
        }
        try { chrome.tabs.create({ url: chrome.runtime.getURL('picker.html') }); reply({ ok: true }); }
        catch (e) { reply({ ok: false, error: String(e) }); }
        return false;
      default:
        return false;
    }
  }
  if (fromOff) {
    return handleHostMessage(msg, reply);
  }
  if (fromPicker && msg.type === 'pick.stored') {
    (async () => {
      await toOffscreen({ type: 'pick.stored' });
      toTabs(msg);
      reply({ ok: true });
    })();
    return true;
  }
  return false;
});

/* ブラウザ起動/拡張更新時にOPFSの取り残しを回収 */
chrome.runtime.onStartup.addListener(() => { recoverExports(); });
chrome.runtime.onInstalled.addListener(() => { recoverExports(); });
