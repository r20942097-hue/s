'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {create}=require('../src/export_manager.js');
const A='a'.repeat(32),B='b'.repeat(32),C='c'.repeat(32),D='d'.repeat(32);
const PART=i=>'part'+String(i).padStart(8,'0');
function record(i,status='requested',key=null){return {partId:PART(i),name:'RPLAY_'+i+'_a1.ts',stageName:'RPLAY_'+i+'.ts',size:3,attempt:1,status,downloadId:null,requestedAt:1700000000000,cleanupPending:false,sessionKey:key};}
function harness(initial){
 const store=initial?structuredClone(initial):{},history=[];let failure=false,downloads=0,manager;
 const api={runtime:{lastError:null},storage:{local:{
  get:(key,cb)=>queueMicrotask(()=>cb(structuredClone(store))),
  set:(obj,cb)=>queueMicrotask(()=>{
   if(failure){api.runtime.lastError={message:'fail'};cb();api.runtime.lastError=null;}
   else {Object.assign(store,structuredClone(obj));history.push(structuredClone(obj));cb();}
  })}},downloads:{
  download:(req,cb)=>queueMicrotask(()=>cb(++downloads)),
  search:(q,cb)=>queueMicrotask(()=>cb([]))
 }};
 const restart=()=>{manager=create(api,async()=>({ok:true}),()=>1700000000000);};restart();
 return {store,history,restart,get manager(){return manager;},set failure(v){failure=v;},get downloads(){return downloads;},
  offer:(i,key,retry=false)=>manager.offer({partId:PART(i),name:'RPLAY_'+i+'.ts',size:3,url:'blob:synthetic',sessionKey:key,retry})};
}
const full=(rows,coverage={verifiedEvictions:false})=>({rsp_exports_v211:{version:1,coverage,records:rows}});
test('v0.29 a forged retry cannot migrate a part between audit sessions',async()=>{
 const h=harness();await h.offer(1,A);const snapshot=structuredClone(h.store);
 await assert.rejects(()=>h.offer(1,B,true),/SESSION_ATTRIBUTION_CONFLICT/);
 assert.deepEqual(h.store,snapshot);assert.equal(h.downloads,1);
});
test('v0.29 recovered null attribution cannot be upgraded on the same part id',async()=>{
 const h=harness();await h.offer(1,null);
 await assert.rejects(()=>h.offer(1,A,true),/SESSION_ATTRIBUTION_CONFLICT/);
 assert.equal(h.store.rsp_exports_v211.records[0].sessionKey,null);
});
test('v0.29 missing retry key inherits the original journal identity',async()=>{
 const r=record(1,'interrupted',A),h=harness(full([r]));
 await h.offer(1,null,true);
 assert.equal(h.store.rsp_exports_v211.records[0].sessionKey,A);
 assert.equal(h.store.rsp_exports_v211.records[0].attempt,2);
});
test('v0.29 verified evictions are counted per attributed session atomically',async()=>{
 const rows=Array.from({length:512},(_,i)=>record(i,i<2?'verified':'requested',i===0?A:i===1?B:C));
 const h=harness(full(rows));await h.offer(900,C);
 const coverage=h.store.rsp_exports_v211.coverage;
 assert.equal(coverage.verifiedEvictions,true);
 assert.deepEqual(coverage.evictedSessionCounts,{[A]:1,[B]:1});
 assert.equal(coverage.evictedSessionOverflow,false);
 assert.equal(h.store.rsp_exports_v211.records.length,511);
 for(const key of [A,B]){
  const info=await h.manager.sessionStatus(key);
  assert.equal(info.evictedVerifiedObserved,1);
  assert.equal(info.verifiedObservedLowerBound,1);
  assert.equal(info.historicalCoverage,'incomplete');
  assert.equal(info.complete,false);
  assert.equal(info.evictionCoverage,'since-v029-partial');
 }
 assert.equal((await h.manager.sessionStatus(C)).evictedVerifiedObserved,null);
 h.restart();assert.equal((await h.manager.sessionStatus(A)).evictedVerifiedObserved,1);
});
test('v0.29 repeated queries never add retirement events or new download requests',async()=>{
 const rows=Array.from({length:512},(_,i)=>record(i,i===0?'verified':'requested',i===0?A:B));
 const h=harness(full(rows));await h.offer(900,C);
 const snapshot=structuredClone(h.store);const n=h.history.length;
 for(let i=0;i<4;i++){await h.manager.status();await h.manager.sessionStatus(A);}
 assert.deepEqual(h.store,snapshot);assert.equal(h.history.length,n);
 assert.equal(h.downloads,1);
});
test('v0.29 failed atomic storage write never marks evicted verified parts',async()=>{
 const rows=Array.from({length:512},(_,i)=>record(i,i===0?'verified':'requested',i===0?A:B));
 const h=harness(full(rows));const prior=structuredClone(h.store);
 h.failure=true;await assert.rejects(()=>h.offer(900,C),/BROWSER_API_ERROR/);
 assert.equal(h.downloads,0);assert.deepEqual(h.store,prior);
 h.failure=false;h.restart();assert.equal((await h.manager.sessionStatus(A)).evictedVerifiedObserved,null);
});
test('v0.29 a pre-v0.29 journal never fabricates historical eviction totals',async()=>{
 const h=harness(full([record(1,'verified',A)],{verifiedEvictions:true}));
 const r=await h.manager.sessionStatus(A);assert.equal(r.evictedVerifiedObserved,null);
 assert.equal(r.evictionCoverage,'unavailable');assert.equal(r.verifiedObservedLowerBound,null);
});
test('v0.29 evicted-session index has a bounded overflow marker without assigning new keys',async()=>{
 const counts={};for(let i=0;i<128;i++)counts[i.toString(16).padStart(32,'0')]=1;
 const rows=Array.from({length:512},(_,i)=>record(i,i===0?'verified':'requested',i===0?A:B));
 const h=harness(full(rows,{verifiedEvictions:true,evictedSessionCounts:counts,evictedSessionOverflow:false}));
 await h.offer(900,C);
 assert.equal(Object.keys(h.store.rsp_exports_v211.coverage.evictedSessionCounts).length,128);
 assert.equal(h.store.rsp_exports_v211.coverage.evictedSessionOverflow,true);
 const info=await h.manager.sessionStatus(A);assert.equal(info.evictedVerifiedObserved,null);
 assert.equal(info.evictionCoverage,'bounded-partial');
});
test('v0.29 existing group remains incrementable after bounded-index overflow',async()=>{
 const counts={[A]:2};for(let i=1;i<128;i++)counts[i.toString(16).padStart(32,'0')]=1;
 const rows=Array.from({length:512},(_,i)=>record(i,i===0?'verified':'requested',i===0?A:B));
 const h=harness(full(rows,{verifiedEvictions:true,evictedSessionCounts:counts,evictedSessionOverflow:true}));
 await h.offer(900,C);assert.equal((await h.manager.sessionStatus(A)).evictedVerifiedObserved,3);
});
test('v0.29 malicious or malformed persisted eviction metadata fails closed',async()=>{
 const invalid=[
  {verifiedEvictions:true,evictedSessionCounts:{bad:1},evictedSessionOverflow:false},
  {verifiedEvictions:true,evictedSessionCounts:{[A]:0},evictedSessionOverflow:false},
  {verifiedEvictions:true,evictedSessionCounts:{[A]:1},evictedSessionOverflow:'no'},
  {verifiedEvictions:true,evictedSessionCounts:[],evictedSessionOverflow:false}
 ];
 for(const coverage of invalid){const h=harness(full([],coverage));
  await assert.rejects(()=>h.manager.status(),/EXPORT_JOURNAL_INVALID/);
  assert.equal(h.downloads,0);
 }
});
test('v0.29 status projection leaks no raw keys, part ids, file names or blob urls',async()=>{
 const rows=Array.from({length:512},(_,i)=>record(i,i===0?'verified':'requested',i===0?A:B));
 const h=harness(full(rows));await h.offer(900,C);
 const v=JSON.stringify(await h.manager.sessionStatus(A));
 for(const secret of [A,B,PART(0),'RPLAY_0','blob:'])assert.equal(v.includes(secret),false);
});
test('v0.29 verified record eviction never implies playable media or complete session history',async()=>{
 const rows=Array.from({length:512},(_,i)=>record(i,i===0?'verified':'requested',i===0?A:B));
 const h=harness(full(rows));await h.offer(900,C);
 const v=await h.manager.sessionStatus(A);
 assert.equal(v.observedOnly,true);assert.equal(v.complete,false);assert.equal(v.source,'retained-export-journal');
 assert.equal('decoded' in v,false);assert.equal('playable' in v,false);
});

test('v0.29 popup badge identifies current candidate and does not request an audit key',()=>{
 const fs=require('node:fs'),path=require('node:path');
 const R=path.join(__dirname,'..');
 const html=fs.readFileSync(path.join(R,'src','popup.html'),'utf8');
 const popup=fs.readFileSync(path.join(R,'src','popup.js'),'utf8');
 assert.match(html,/v0\.29 開発版/);
 assert.equal(popup.includes('sessionKey'),false);
});
