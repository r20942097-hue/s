'use strict';
const {test}=require('node:test');
const a=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');
const {system}=require('./helpers_runtime.cjs');
const st=require('../src/popup_state.js');
const R=path.resolve(__dirname,'..');
const base={ok:true,recording:true,capturedAt:Date.now(),exports:{verified:0,requested:0,unknown:0,failed:0}};
const message=h=>new Promise(resolve=>h.bg.listener({type:'popup.status'}, {id:'rsp',url:'chrome-extension://rsp/popup.html',frameId:0},resolve));
function ui(raw){
 const nodes=new Map();
 for(const id of ['popup-state','popup-target','popup-medium','popup-parts','popup-verified','popup-pending','popup-failed','popup-audio','popup-updated','popup-refresh','popup-ledger-note'])nodes.set(id,{textContent:'',dataset:{},disabled:false,addEventListener(){}});
 vm.runInNewContext(fs.readFileSync(path.join(R,'src/popup.js'),'utf8'),{Date,Promise,document:{hidden:false,getElementById:id=>nodes.get(id)},chrome:{runtime:{sendMessage:()=>Promise.resolve(raw)}},StreamHarborPopupState:st});
 return new Promise(resolve=>setImmediate(()=>resolve(nodes)));
}
for(const firefox of [false,true]){
 test(`v0.24 ${firefox?'Firefox':'Chrome'} recorder clock is bounded by request start, not ledger response`,async()=>{
  const h=system(firefox,true);await h.start();h.bg.setTimeout=setTimeout;h.bg.clearTimeout=clearTimeout;
  vm.runInContext('exportManager.status=()=>new Promise(r=>setTimeout(()=>r({verified:1,requested:0,unknown:0,failed:0}),120))',h.bg);
  const before=Date.now(),reply=await message(h),after=Date.now();
  a.equal(reply.ok,true);a.equal(reply.ledgerScope,'all-recorded-exports');
  a.ok(reply.capturedAt>=before-1000&&reply.capturedAt<=after);
  a.ok(reply.ledgerCapturedAt>=reply.capturedAt+90,`observation vs ledger: ${reply.ledgerCapturedAt-reply.capturedAt}`);
  a.equal(reply.exports.verified,1);a.ok(st.getStatus(reply));
 });
 test(`v0.24 ${firefox?'Firefox':'Chrome'} failed ledger preserves state and exposes missing timestamp`,async()=>{
  const h=system(firefox,true);await h.start();
  vm.runInContext('exportManager.status=async()=>{throw Error("blocked")}',h.bg);
  const reply=await message(h);
  a.equal(reply.ok,true);a.equal(reply.recording,false);
  a.equal(reply.ledgerCapturedAt,null);a.equal(st.getStatus(reply).verified,null);
 });
}
test('v0.24 global journal scope stays explicit even with complete zero export counts',()=>{
 const s=st.getStatus(base);a.equal(s.ledgerScope,'all-recorded-exports');
 a.equal(s.pending,0);a.match(s.ledgerNote,/全録画共通/);a.match(s.ledgerNote,/現在の録画だけの件数ではありません/);
});
test('v0.24 partial ledger still retains available counts and a global scope warning',()=>{
 const s=st.getStatus({...base,exports:{verified:3,unknown:0,failed:0}});
 a.equal(s.verified,3);a.equal(s.pending,null);a.match(s.ledgerNote,/依頼済み件数が未取得/);a.match(s.ledgerNote,/全録画共通/);
});
test('v0.24 UI never invents a recording timestamp for a legacy untimestamped payload',async()=>{
 const {capturedAt,...raw}=base;const n=await ui(raw);a.match(n.get('popup-updated').textContent,/録画状態の観測時刻は未取得/);
 a.doesNotMatch(n.get('popup-updated').textContent,/録画状態の確認開始/);
});
test('v0.24 UI shows independent host and ledger observation timestamps',async()=>{
 const capturedAt=Date.now()-2500,ledgerCapturedAt=capturedAt+1200;
 const n=await ui({...base,capturedAt,ledgerCapturedAt});const s=n.get('popup-updated').textContent;
 a.match(s,/録画状態の確認開始/);a.match(s,/台帳取得/);a.doesNotMatch(s,/台帳取得時刻は未取得/);
});
test('v0.24 invalid ledger timestamp is not presented as fresh',()=>{
 for(const ts of [-1,'2026',null,NaN,Date.now()+100000])a.equal(st.getStatus({...base,ledgerCapturedAt:ts}).ledgerCapturedAt,null);
});
test('v0.24 generated popup files match both browsers and label the correct ledger scope',()=>{
 const html=fs.readFileSync(path.join(R,'src/popup.html'),'utf8');a.match(html,/保存台帳（全録画）/);
 for(const ext of ['rplay-stable-player-extension','rplay-stable-player-extension-firefox'])for(const f of ['popup.js','popup_state.js','popup.html','popup.css','background.js']){
   a.equal(fs.readFileSync(path.join(R,'src',f),'utf8'),fs.readFileSync(path.join(R,ext,f),'utf8'));
 }
});
