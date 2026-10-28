'use strict';
const {test}=require('node:test');
const a=require('node:assert/strict');
const {system}=require('./helpers_runtime.cjs');
const st=require('../src/popup_state.js');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const R=path.resolve(__dirname,'..');
const base=()=>({ok:true,capturedAt:Date.now(),recording:true,partCount:100,
  partSequence:{kind:'host-ordinal',video:123,audio:12,audioPresent:true},
  exports:{verified:5,requested:1,unknown:0,failed:0}});
const call=h=>new Promise(res=>h.bg.listener({type:'popup.status'},
  {id:'rsp',url:'chrome-extension://rsp/popup.html',frameId:0},res));
function ui(response){
 const nodes=new Map();for(const id of ['popup-state','popup-target','popup-medium','popup-parts','popup-session-note',
 'popup-video-ordinal','popup-audio-ordinal','popup-ordinal-note','popup-verified','popup-pending','popup-failed',
 'popup-audio','popup-updated','popup-refresh','popup-ledger-note'])nodes.set(id,{textContent:'',dataset:{},disabled:false,addEventListener(){}});
 vm.runInNewContext(fs.readFileSync(R+'/src/popup.js','utf8'),{Date,Promise,document:{hidden:false,getElementById:id=>nodes.get(id)},
  chrome:{runtime:{sendMessage:()=>Promise.resolve(response)}},StreamHarborPopupState:st});
 return new Promise(resolve=>setImmediate(()=>resolve(nodes)));
}
for(const firefox of [false,true]){
 const name=firefox?'Firefox':'Chrome';
 test(`v0.26 ${name} host ordinal >100 survives bounded part list`,async()=>{
   const h=system(firefox,true);await h.start();
   a.equal((await h.command('rec.start',{oid:'a'.repeat(24)})).ok,true);
   const rec=h.host.TEST_RECORDER;
   rec.partIndex=123;rec.partOpen=true;
   rec.audio={partIndex:12,partOpen:false};
   rec.partsLog=Array.from({length:100},(_,i)=>({file:'x'+i+'.ts',startedAt:new Date().toISOString()}));
   const msg=await call(h);const model=st.getStatus(msg);
   a.equal(msg.ok,true);a.equal(msg.partSequence.video,124);a.equal(msg.partSequence.audio,12);
   a.equal(model.videoOrdinal,124);a.equal(model.audioOrdinal,12);
   a.equal(model.verified,0);a.doesNotMatch(JSON.stringify(msg),/x99\.ts|partName|sourceUrl|sessionId/);
 });
 test(`v0.26 ${name} idle clears part counters even with old host values`,async()=>{
   const h=system(firefox,true);await h.start();
   const rec=h.host.TEST_RECORDER;
   if(rec){rec.partIndex=999;rec.partOpen=true;}
   const msg=await call(h);
   a.equal(msg.ok,true);a.equal(msg.partSequence,null);
   const model=st.getStatus(msg);a.equal(model.videoOrdinal,null);
 });
 test(`v0.26 ${name} invalid host ordinal remains null`,async()=>{
   const h=system(firefox,true);await h.start();a.equal((await h.command('rec.start',{oid:'b'.repeat(24)})).ok,true);
   h.host.TEST_RECORDER.partIndex=Number.MAX_SAFE_INTEGER;h.host.TEST_RECORDER.partOpen=true;
   const msg=await call(h);a.equal(msg.partSequence.video,null);
   a.equal(st.getStatus(msg).videoOrdinal,null);
 });
}
test('v0.26 100-row boundary does not erase independent host ordinals',()=>{
 const m=st.getStatus(base());a.equal(m.partsText,'100件以上');
 a.equal(m.videoOrdinal,123);a.equal(m.audioOrdinal,12);
 a.match(m.ordinalNote,/保存成功数ではなく/);a.equal(m.pending,1);
});
test('v0.26 incomplete audio counter is unknown; no substitution from 100-row list',()=>{
 const m=st.getStatus({...base(),partSequence:{kind:'host-ordinal',video:123,audio:null,audioPresent:true}});
 a.equal(m.audioOrdinal,null);a.equal(m.videoOrdinal,123);
});
test('v0.26 absent separate audio is marked not applicable, not zero',async()=>{
 const n=await ui({...base(),partSequence:{kind:'host-ordinal',video:7,audio:null,audioPresent:false}});
 a.equal(n.get('popup-audio-ordinal').textContent,'対象外');a.equal(n.get('popup-video-ordinal').textContent,'7');
});
test('v0.26 unknown ordinal source remains unknown, rather than inferred from partCount',()=>{
 const m=st.getStatus({...base(),partSequence:null});a.equal(m.videoOrdinal,null);
 a.equal(m.audioOrdinal,null);a.match(m.ordinalNote,/未取得/);
});
test('v0.26 invalid and overflow ordinals remain missing',()=>{
 for(const video of [-1,NaN,Infinity,'123',Number.MAX_SAFE_INTEGER+1]){
   const m=st.getStatus({...base(),partSequence:{kind:'host-ordinal',video,audio:0,audioPresent:true}});
   a.equal(m.videoOrdinal,null);
 }
});
test('v0.26 idle does not leak prior host ordinals or journal to session panel',()=>{
 const m=st.getStatus({...base(),recording:false,partSequence:{kind:'host-ordinal',video:88,audio:99,audioPresent:true}});
 a.equal(m.partsText,'—');a.equal(m.videoOrdinal,null);a.equal(m.audioOrdinal,null);
 a.equal(m.verified,5);
});
test('v0.26 UI renders separate bounded window and host ordinals',async()=>{
 const n=await ui(base());a.equal(n.get('popup-parts').textContent,'100件以上');
 a.equal(n.get('popup-video-ordinal').textContent,'123');a.equal(n.get('popup-audio-ordinal').textContent,'12');
 a.match(n.get('popup-ordinal-note').textContent,/復旧前後/);
 a.equal(n.get('popup-verified').textContent,'5');
});
test('v0.26 failed refresh clears all session and journal information',async()=>{
 const n=await ui({ok:false});a.equal(n.get('popup-video-ordinal').textContent,'—');
 a.equal(n.get('popup-audio-ordinal').textContent,'—');a.match(n.get('popup-ordinal-note').textContent,/未確認/);
});
test('v0.26 popup DOM is accessible and mirrors canonical files in both browsers',()=>{
 const html=fs.readFileSync(R+'/src/popup.html','utf8');
 a.match(html,/id="popup-video-ordinal" aria-describedby="popup-ordinal-note"/);
 a.match(html,/id="popup-audio-ordinal" aria-describedby="popup-ordinal-note"/);
 for(const ext of ['rplay-stable-player-extension','rplay-stable-player-extension-firefox'])
  for(const file of ['popup_state.js','popup.js','popup.html','popup.css','background.js'])
    a.equal(fs.readFileSync(R+'/src/'+file,'utf8'),fs.readFileSync(R+'/'+ext+'/'+file,'utf8'));
});
