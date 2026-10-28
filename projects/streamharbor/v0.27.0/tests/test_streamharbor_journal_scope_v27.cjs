'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path');
const {system}=require('./helpers_runtime.cjs');
const state=require('../src/popup_state.js');
const R=path.resolve(__dirname,'..');
const base={ok:true,capturedAt:Date.now(),recording:false,ledgerScope:'retained-export-journal',
  exports:{verified:5,requested:1,unknown:0,failed:1,retained:7,capacity:512,verifiedEvictions:true}};
test('v0.27 visible journal describes retained count and evictions, not lifetime total',()=>{
 const m=state.getStatus(base);assert.equal(m.retained,7);assert.equal(m.verifiedEvictions,true);
 assert.match(m.ledgerNote,/保持中 7件 \/ 最大512件/);
 assert.match(m.ledgerNote,/削除履歴/);assert.match(m.ledgerNote,/全履歴の累計でもありません/);
});
test('v0.27 missing retention never becomes zero or claims complete history',()=>{
 const m=state.getStatus({...base,exports:{verified:0,requested:0,unknown:0,failed:0}});
 assert.equal(m.retained,null);assert.equal(m.verifiedEvictions,null);
 assert.match(m.ledgerNote,/保持中レコード数は未取得/);
 assert.match(m.ledgerNote,/削除有無は未確認/);
});
test('v0.27 invalid capacity and retention fail closed',()=>{
 for(const retained of ['0',-1,1.2,Infinity,Number.MAX_SAFE_INTEGER+1]){
  const m=state.getStatus({...base,exports:{...base.exports,retained}});
  assert.equal(m.retained,null);
 }
 const m=state.getStatus({...base,exports:{...base.exports,capacity:999}});
 assert.equal(m.capacity,null);assert.match(m.ledgerNote,/容量は未確認/);
});
test('v0.27 global scope metadata from Firefox and Chrome never includes a session ID',async()=>{
 for(const firefox of [false,true]){
  const h=system(firefox,true);await h.start();
  const raw=await new Promise(resolve=>h.bg.listener({type:'popup.status'},
   {id:'rsp',url:'chrome-extension://rsp/popup.html',frameId:0},resolve));
  assert.equal(raw.ledgerScope,'retained-export-journal');
  assert.equal(raw.exports.capacity,512);
  assert.equal(raw.exports.retained,0);
  assert.equal(raw.exports.verifiedEvictions,false);
  assert.doesNotMatch(JSON.stringify(raw),/sessionId|partId|downloadId|stageName|oid/);
 }
});
test('v0.27 popup source and generated copies agree about bounded scope',()=>{
 const markup=fs.readFileSync(path.join(R,'src/popup.html'),'utf8');
 assert.match(markup,/保存台帳（保持中の記録）/);assert.match(markup,/最大512件/);
 for(const ext of ['rplay-stable-player-extension','rplay-stable-player-extension-firefox'])
  for(const f of ['export_manager.js','background.js','popup_state.js','popup.html'])
   assert.equal(fs.readFileSync(path.join(R,'src',f),'utf8'),fs.readFileSync(path.join(R,ext,f),'utf8'));
});
