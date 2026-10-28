const {test}=require('node:test'),a=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
const base=path.join(__dirname,'..');
const id='a'.repeat(24),other='b'.repeat(24);

/* ---- offscreen側 handleBgSchedScan: ソース切出しで実コードを検証 ---- */
function hostHarness(opts={}){
  const timers=[];let calls=[];
  const c=vm.createContext({
    RspAuth:{jwt:opts.jwt===undefined?'tok':opts.jwt},
    fetchSchedulesFor:async oid=>{calls.push(oid);return opts.fetcher?opts.fetcher(oid):{items:[]};},
    setTimeout:fn=>{timers.push(fn);fn();return timers.length;},clearTimeout:()=>{},
    Date,Promise,console,AbortController});
  const s=fs.readFileSync(path.join(base,'src/offscreen_post.js'),'utf8');
  const start=s.indexOf('  let _bgSchedBusy = false, _bgSchedAt = 0;'),end=s.indexOf('  /* ---- メッセージディスパッチ');
  a.ok(start>0&&end>start,'handler slice markers');
  vm.runInContext(s.slice(start,end)+';globalThis.scan=handleBgSchedScan;',c);
  return {scan:(...p)=>c.scan(...p),timers,callCount:()=>calls.length,calls};
}
test('v2.42.0 bg scan refuses without login session and starts no requests',async()=>{
  const h=hostHarness({jwt:''});
  a.deepEqual(JSON.parse(JSON.stringify(await h.scan({ids:[id]}))),{ok:false,error:'nologin'});
  a.equal(h.callCount(),0);
});
test('v2.42.0 bg scan validates ids, caps volume and requires a list',async()=>{
  const h=hostHarness();
  a.deepEqual(JSON.parse(JSON.stringify(await h.scan({}))),{ok:false,error:'no-ids'});
  a.deepEqual(JSON.parse(JSON.stringify(await h.scan({ids:[]}))),{ok:false,error:'no-ids'});
  const r=await h.scan({ids:['zz',id.toUpperCase(),other]});
  a.equal(r.ok,true);
  a.equal(r.count,2); /* 不正形は濾過・大文字IDは受理(巡回側で正規化比較はfetchが担う) */
  const h2=hostHarness();
  const capped=await h2.scan({ids:Array.from({length:150},(_,i)=>i.toString(16).padStart(24,'0'))}); /* distinct IDs capped at 100 */
  a.equal(capped.ok,true);
  a.equal(capped.count,100);
  a.equal(h2.callCount(),100);
});
test('v2.42.0 bg scan guard order lets a later logged-in retry through (nologin never stamps rate limit)',async()=>{
  /* 1回目nologin → 2回目(jwt復活後)は即成功する(nologinはレート制限を刻印しない) */
  let jwt='';
  const timers=[];const calls=[];
  const c=vm.createContext({RspAuth:{get jwt(){return jwt;}},fetchSchedulesFor:async oid=>{calls.push(oid);return {items:[]};},setTimeout:fn=>{timers.push(fn);return 1;},clearTimeout:()=>{},AbortController,Date,Promise,console,AbortController});
  const s=fs.readFileSync(path.join(base,'src/offscreen_post.js'),'utf8');
  const start=s.indexOf('  let _bgSchedBusy = false, _bgSchedAt = 0;'),end=s.indexOf('  /* ---- メッセージディスパッチ');
  vm.runInContext(s.slice(start,end)+';globalThis.scan=handleBgSchedScan;',c);
  a.deepEqual(JSON.parse(JSON.stringify(await c.scan({ids:[id]}))),{ok:false,error:'nologin'});
  jwt='tok';
  const r=await c.scan({ids:[id]});
  a.equal(r.ok,true);
});
test('v2.42.0 bg scan rate-limits repeats within 60s (10s with force) and reports retry window',async()=>{
  const h=hostHarness();
  const r1=await h.scan({ids:[id]});
  a.equal(r1.ok,true);
  const r2=await h.scan({ids:[id]});
  a.equal(r2.ok,false);a.equal(r2.error,'rate-limited');a.ok(r2.retryInMs>0&&r2.retryInMs<=60000);
  const r3=await h.scan({ids:[id],force:true});
  a.equal(r3.error,'rate-limited');a.ok(r3.retryInMs>0&&r3.retryInMs<=10000);
});
test('v2.42.0 concurrent scans answer busy and serialization recovers afterwards',async()=>{
  let release;const gate=new Promise(r=>release=r);
  const h=hostHarness({fetcher:()=>gate.then(()=>({items:[{title:'配信',scheduledAt:Date.now()+60000}]}))});
  const p=h.scan({ids:[id]});
  await new Promise(setImmediate);
  a.deepEqual(JSON.parse(JSON.stringify(await h.scan({ids:[other]}))),{ok:false,error:'busy'});
  release();
  const r=await p;
  a.equal(r.ok,true);a.equal(r.rows.length,1);a.equal(r.rows[0].title,'配信');
  const after=await h.scan({ids:[other]});
  a.equal(after.error,'rate-limited'); /* busy解除後は通常レート制限へ戻る */
});
test('v2.42.0 scan collects sorted rows, error counts and paces one wait between creators',async()=>{
  const now=Date.now();const calls=[];
  const h=hostHarness({fetcher:oid=>{calls.push(oid);return oid===id?{items:[{title:'後',scheduledAt:now+120000},{title:'先',scheduledAt:now+60000}]}:{err:'403'};}});
  const r=await h.scan({ids:[other,id]});
  a.equal(r.ok,true);a.equal(r.count,2);
  a.deepEqual(calls,[other,id]);
  a.deepEqual(JSON.parse(JSON.stringify(r.rows.map(x=>x.title))),['先','後']);
  a.deepEqual(JSON.parse(JSON.stringify(r.rows.map(x=>x.oid))),[id,id]);
  a.deepEqual(JSON.parse(JSON.stringify(r.errors)),{403:1});
  a.ok(r.checkedAt>=now);
  a.equal(h.timers.length,1); /* 2件では1回だけ400ms待機(最終件の後は待たない) */
});
test('v2.42.0 handler exception clears busy flag so the next scan is not stuck',async()=>{
  const h=hostHarness({fetcher:()=>{throw Error('boom');}});
  await a.rejects(h.scan({ids:[id]}),/boom/);
  const r2=await h.scan({ids:[id]});
  a.equal(r2.error,'rate-limited'); /* busyは解除済み・到達はレート制限のみ */
});

/* ---- BG router: dashboard発schedules.scan中継・registry.list meta応答 ---- */
function bgRouter(store,hostReply){
  const h={listener:null,hostMessages:[]};
  const api={runtime:{id:'rsp',lastError:null,getURL:n=>'chrome-extension://rsp/'+n,
      onMessage:{addListener:f=>h.listener=f},onStartup:{addListener:()=>{}},onInstalled:{addListener:()=>{}},
      getContexts:async()=>[{}],
      sendMessage:async m=>{h.hostMessages.push(m);return hostReply?structuredClone(hostReply):{ok:true,rows:[],errors:{},checkedAt:1,count:1};}},
    offscreen:{createDocument:async()=>{},closeDocument:async()=>{}},
    downloads:{onChanged:{addListener:()=>{}},},alarms:{create:()=>{},clear:()=>{},onAlarm:{addListener:()=>{}}},action:{setBadgeText:()=>{}},tabs:{query:async()=>[],sendMessage:async()=>{}}};
  api.storage={local:{get:(k,cb)=>cb(structuredClone(store))}};
  const c=vm.createContext({chrome:api,console,Promise,Date,setTimeout:()=>1,clearTimeout:()=>{},
    RspExportManager:{create:()=>({pending:async()=>false,status:async()=>({}),offer:async()=>({ok:true}),changed:async()=>{},reconcile:async()=>{}})}});
  vm.runInContext(fs.readFileSync(path.join(base,'src/creator_registry.js'),'utf8'),c);
  vm.runInContext(fs.readFileSync(path.join(base,'src/background.js'),'utf8'),c);
  h.message=(msg,sender)=>new Promise(res=>{const keep=h.listener(msg,sender,res);if(keep!==true)res(null);});
  return h;
}
const dashSender={id:'rsp',url:'chrome-extension://rsp/dashboard.html'};
const contentSender={id:'rsp',url:'https://rplay.live/live/'+id,frameId:0,tab:{id:1}};
test('v2.42.0 router relays dashboard schedules.scan to host with validated registry ids',async()=>{
  const h=bgRouter({rsp_registered_creators:[id.toUpperCase(),'junk',other]});
  const r=await h.message({type:'schedules.scan'},dashSender);
  a.equal(r.ok,true);
  a.equal(h.hostMessages.length,1);
  a.deepEqual(JSON.parse(JSON.stringify(h.hostMessages[0])),{type:'schedules.scan',target:'rsp-host',payload:{ids:[id,other],force:false}});
});
test('v2.42.0 router passes force flag and empty registry answers no-ids without host call',async()=>{
  const h=bgRouter({});
  a.deepEqual(JSON.parse(JSON.stringify(await h.message({type:'schedules.scan'},dashSender))),{ok:false,error:'no-ids'});
  a.equal(h.hostMessages.length,0);
  const h2=bgRouter({rsp_registered_creators:[id]});
  await h2.message({type:'schedules.scan',force:true},dashSender);
  a.equal(h2.hostMessages[0].payload.force,true);
});
test('v2.42.0 content pages cannot trigger the external schedule scan',async()=>{
  const h=bgRouter({rsp_registered_creators:[id]});
  const r=await h.message({type:'schedules.scan'},contentSender);
  a.equal(r,null);
  a.equal(h.hostMessages.length,0);
});
test('v2.42.0 registry.list now returns sanitized meta filtered to the id list',async()=>{
  const meta={};meta[id]={name:'太郎',url:'https://rplay.live/c/taro',at:1};meta['c'.repeat(24)]={name:'未登録',url:'https://rplay.live/c/x',at:1};meta[id.toUpperCase()]={name:'大文字key',url:'https://rplay.live/c/x',at:1};
  const h=bgRouter({rsp_registered_creators:[id],rsp_creator_meta:meta});
  const r=await h.message({type:'registry.list'},contentSender);
  a.deepEqual(r.ids,[id]);
  a.deepEqual(JSON.parse(JSON.stringify(r.meta)),{[id]:{name:'太郎',url:'https://rplay.live/c/taro',at:1}});
});
test('v2.42.0 registry.list without meta storage still answers an empty meta object',async()=>{
  const h=bgRouter({rsp_registered_creators:[id]});
  const r=await h.message({type:'registry.list'},contentSender);
  a.deepEqual(JSON.parse(JSON.stringify(r)),{ids:[id],meta:{}});
});

/* ---- 配線と梱包の回帰ガード ---- */
test('v2.42.0 offscreen dispatch and dashboard wiring reference the new scan path',()=>{
  const post=fs.readFileSync(path.join(base,'src/offscreen_post.js'),'utf8');
  a.ok(post.includes("case 'schedules.scan':"));
  a.ok(post.includes('handleBgSchedScan(msg.payload || {})'));
  const bg=fs.readFileSync(path.join(base,'src/background.js'),'utf8');
  a.ok(bg.includes("fromDashboard && msg.type==='schedules.scan'"));
  a.ok(bg.includes("importScripts('session_export_ledger.js', 'export_manager.js', 'creator_registry.js', 'media_catalog.js')"));
  const dash=fs.readFileSync(path.join(base,'src/dashboard.js'),'utf8');
  a.ok(dash.includes("sendMessage({type:'schedules.scan',requestId})"));
  a.ok(dash.includes('renderMeta'));
  const html=fs.readFileSync(path.join(base,'src/dashboard.html'),'utf8');
  for(const needle of ['id="schedScan"','id="schedResult"','id="schedRows"','id="metaList"'])a.ok(html.includes(needle),needle);
});
test('v2.42.0 Firefox event page loads creator_registry.js before background.js',()=>{
  const m=JSON.parse(fs.readFileSync(path.join(base,'rplay-stable-player-extension-firefox/manifest.json'),'utf8'));
  const bg=m.background.scripts;
  a.ok(bg.includes('creator_registry.js'));
  a.ok(bg.indexOf('creator_registry.js')<bg.indexOf('background.js'));
});

/* ---- player予約一覧の名前表示(registry.list応答のmeta) ---- */
function playerHarness(fetcher,regReply){
  const texts=[];
  const ui={el:{isConnected:true}},button={disabled:false},list={style:{},textContent:'',appendChild(){}};
  const c=vm.createContext({ui,schedBtn:button,schedList:list,favInput:{value:'a'.repeat(24)},current:null,recorder:null,Date,AbortController,SCHED_SCAN_MIN_MS:600000,RspAuth:{probe(){},jwt:'test'},globalThis:{RspCreatorRegistry:require(path.join(base,'src/creator_registry.js')),RspCreatorMeta:require(path.join(base,'src/creator_meta.js'))},localStorage:{setItem(){}},fetchSchedulesFor:fetcher,setTimeout:fn=>{fn();},el:()=>({appendChild(){}}),document:{createTextNode:s=>{texts.push(String(s));return s;}},chrome:{runtime:{sendMessage:async()=>regReply}}});
  const s=fs.readFileSync(path.join(base,'src/player.user.js'),'utf8');
  const metaStart=s.indexOf('  /* ---- v2.39.0: ページ側 配信者名キャッシュ'),metaEnd=s.indexOf('  function persistChk(',metaStart);
  const start=s.indexOf('    ui.scanSchedules = async function'),end=s.indexOf('    const cancelSched=',start);
  vm.runInContext(s.slice(metaStart,metaEnd)+s.slice(start,end),c);
  return {ui,texts,list};
}
test('v2.42.0 page schedule rows show registered creator names instead of raw oid prefixes',async()=>{
  const now=Date.now();
  const regReply={ids:[],meta:{[id]:{name:'登録済み太郎',url:'https://rplay.live/c/taro',at:1}}};
  const h=playerHarness(async()=>({items:[{title:'配信',scheduledAt:now+60000}]}),regReply);
  h.ui.el.isConnected=true;
  await h.ui.scanSchedules(true);
  const lineText=h.texts.find(t=>t.includes('登録済み太郎'));
  a.ok(lineText,'name rendered');
  a.ok(lineText.includes('「配信」'));
  a.ok(!lineText.includes(id.slice(0,10)+'…'),'oid prefix hidden when name known');
});
test('v2.42.0 page schedule rows fall back to oid prefix without meta and ignore malformed meta',async()=>{
  const now=Date.now();
  for(const meta of [undefined,{[id]:{url:'https://rplay.live/c/x'}},{[id]:'broken'}]){
    const h=playerHarness(async()=>({items:[{title:'配信',scheduledAt:now+60000}]}),{ids:[],meta});
    h.ui.el.isConnected=true;
    await h.ui.scanSchedules(true);
    const lineText=h.texts.find(t=>t.includes('「配信」'));
    a.ok(lineText.includes(id.slice(0,10)+'…'),'oid prefix fallback for meta='+JSON.stringify(meta));
  }
});

test('duplicate mixed-case IDs fetch once, invalid dates are omitted and earliest 500 survive across creators',async()=>{
 const h=hostHarness({fetcher:async oid=>({items:oid===id?Array.from({length:800},(_,i)=>({title:'later',scheduledAt:10000+i})):[{title:'first',scheduledAt:1},{title:'invalid',scheduledAt:Infinity},{scheduledAt:8640000000000001}]})});
 const r=await h.scan({ids:[id,id.toUpperCase(),other]});a.equal(h.callCount(),2);a.equal(r.rows.length,500);a.equal(r.rows[0].title,'first');a.equal(r.rows.at(-1).scheduledAt,10498);a.ok(r.rows.every(x=>Number.isFinite(x.scheduledAt)));
});

test('dashboard status/cancel routes forward the request token; content and malformed tokens cannot control a scan',async()=>{
 for(const type of ['schedules.status','schedules.cancel']){const h=bgRouter({});const requestId='c'.repeat(32);a.equal((await h.message({type,requestId},dashSender)).ok,true);a.equal(h.hostMessages[0].payload.requestId,requestId);a.equal(h.hostMessages[0].type,type);a.equal(await h.message({type,requestId},contentSender),null);a.equal((await h.message({type,requestId:'x'},dashSender)).error,'bad-request');a.equal(h.hostMessages.length,1);}
});
