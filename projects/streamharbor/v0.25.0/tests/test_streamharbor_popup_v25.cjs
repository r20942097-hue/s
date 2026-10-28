'use strict';
const {test}=require('node:test');
const a=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {system}=require('./helpers_runtime.cjs');
const state=require('../src/popup_state.js');
const R=path.resolve(__dirname,'..');
const base={ok:true,recording:true,capturedAt:Date.now(),partCount:5,exports:{verified:2,requested:0,unknown:0,failed:0}};
const msg=h=>new Promise(resolve=>h.bg.listener({type:'popup.status'}, {id:'rsp',url:'chrome-extension://rsp/popup.html',frameId:0},resolve));
function ui(response){
 const nodes=new Map();for(const id of ['popup-state','popup-target','popup-medium','popup-parts','popup-session-note','popup-verified','popup-pending','popup-failed','popup-audio','popup-updated','popup-refresh','popup-ledger-note'])nodes.set(id,{textContent:'',dataset:{},disabled:false,addEventListener(){}});
 const context={Date,Promise,document:{hidden:false,getElementById:id=>nodes.get(id)},chrome:{runtime:{sendMessage:()=>Promise.resolve(response)}},StreamHarborPopupState:state};
 vm.runInNewContext(fs.readFileSync(R+'/src/popup.js','utf8'),context);
 return new Promise(resolve=>setImmediate(()=>resolve(nodes)));
}
for(const firefox of [false,true]){
 test(`v0.25 ${firefox?'Firefox':'Chrome'} idle source never mislabels previous parts as active session`,async()=>{
  const h=system(firefox,true);await h.start();
  const status=await msg(h);
  a.equal(status.ok,true);a.equal(status.recording,false);a.equal(status.partCount,null);
  a.equal(state.getStatus(status).parts,null);
 });
 test(`v0.25 ${firefox?'Firefox':'Chrome'} active source reports bounded available entries only`,async()=>{
  const h=system(firefox,true);await h.start();
  a.equal((await h.command('rec.start',{oid:'a'.repeat(24)})).ok,true);
  const status=await msg(h);
  a.equal(status.recording,true);a.ok(Number.isSafeInteger(status.partCount));
  a.ok(status.partCount>=0&&status.partCount<=100);
  a.doesNotMatch(JSON.stringify(status),/https?:\/\/|token=|partName/);
 });
}
test('v0.25 status model keeps session count distinct from global journal counts',()=>{
 const s=state.getStatus(base);a.equal(s.parts,5);a.equal(s.partsText,'5');
 a.equal(s.verified,2);a.equal(s.pending,0);a.match(s.partsNote,/保存完了数ではありません/);
 a.match(s.ledgerNote,/全録画共通/);
});
test('v0.25 100 is lower-bound, not an unverified session total',()=>{
 for(const n of [100,101]){
  const s=state.getStatus({...base,partCount:n});a.equal(s.partsText,'100件以上');
  a.match(s.partsNote,/総パート数は100件以上/);
 }
});
test('v0.25 idle does not reuse previous session parts even if included',()=>{
 const s=state.getStatus({...base,recording:false,partCount:90,parts:[{},{}]});
 a.equal(s.parts,null);a.equal(s.partsText,'—');a.match(s.partsNote,/前回のパート/);
 a.equal(s.verified,2);
});
test('v0.25 missing session count is unknown even with valid global counts',()=>{
 const s=state.getStatus({...base,partCount:null});a.equal(s.partsText,'—');
 a.match(s.partsNote,/取得できません/);a.equal(s.verified,2);
});
test('v0.25 UI explicitly separates active-session window from global ledger',async()=>{
 const n=await ui(base);a.equal(n.get('popup-parts').textContent,'5');
 a.match(n.get('popup-session-note').textContent,/保存完了数ではありません/);
 a.equal(n.get('popup-verified').textContent,'2');a.match(n.get('popup-ledger-note').textContent,/全録画共通/);
});
test('v0.25 failed status clears stale session and global notes',async()=>{
 const n=await ui({ok:false});a.equal(n.get('popup-parts').textContent,'—');
 a.match(n.get('popup-session-note').textContent,/未確認/);
 a.match(n.get('popup-ledger-note').textContent,/未確認/);
});
test('v0.25 popup markup has two independently labelled panels, no shared metric container',()=>{
 const html=fs.readFileSync(R+'/src/popup.html','utf8');
 a.match(html,/録画セッション/);a.match(html,/保存台帳（全録画）/);
 a.equal((html.match(/id="popup-parts"/g)||[]).length,1);
 const session=html.indexOf('id="popup-parts"'),ledger=html.indexOf('id="popup-verified"');
 a.ok(session<ledger);a.match(html,/aria-describedby="popup-session-note"/);
});
test('v0.25 generated session and ledger components match Chrome and Firefox',()=>{
 for(const ext of ['rplay-stable-player-extension','rplay-stable-player-extension-firefox'])for(const n of ['background.js','popup.html','popup.css','popup.js','popup_state.js']){
  a.equal(fs.readFileSync(R+'/src/'+n,'utf8'),fs.readFileSync(R+'/'+ext+'/'+n,'utf8'));
 }
});
