'use strict';
const {test}=require('node:test');
const a=require('node:assert/strict');
const {webcrypto}=require('node:crypto');
const Manager=require('../src/export_manager.js');
const Host=require('../src/export_host.js');
const KEY_A='a'.repeat(32), KEY_B='b'.repeat(32);
function fixture(){
 let mgr, host, downloads=[], currentId=0, failSet=false;
 const store={}, files=new Map(), events=[];
 const safeCopy=x=>structuredClone(x);
 const api={runtime:{lastError:null},storage:{local:{
  get:(key,cb)=>queueMicrotask(()=>cb(safeCopy(store))),
  set:(o,cb)=>queueMicrotask(()=>{
   if(failSet){api.runtime.lastError={message:'write failed'};cb();api.runtime.lastError=null;}
   else{Object.assign(store,safeCopy(o));cb();}
  })
 }},downloads:{
  download:(o,cb)=>{const id=++currentId;downloads.push({id,filename:'/Downloads/'+o.filename,state:'in_progress',startTime:new Date(1700000000000).toISOString()});cb(id);},
  search:(q,cb)=>queueMicrotask(()=>cb(safeCopy(q.id===undefined?downloads:downloads.filter(d=>d.id===q.id))))
 }};
 const dir={
  getFileHandle:async(name,options)=>{
   if(!files.has(name)){
    if(!options?.create)throw new DOMException('not found','NotFoundError');
    files.set(name,new Blob([]));
   }
   return {getFile:async()=>files.get(name),createWritable:async()=>{
    let blob;return {write:async b=>{blob=b;},close:async()=>files.set(name,blob),abort:async()=>{}};
   }};
  },removeEntry:async name=>{files.delete(name);},
  async *entries(){for(const name of files.keys())yield [name,{kind:'file',getFile:async()=>files.get(name)}];}
 };
 const env={navigator:{storage:{getDirectory:async()=>({getDirectoryHandle:async()=>dir})}},crypto:webcrypto,
  URL:{createObjectURL:()=> 'blob:dev/'+webcrypto.randomUUID(),revokeObjectURL:()=>{}},
  send:async message=>{events.push({...message,url:undefined});return mgr.offer(message);}};
 function restart(){mgr=Manager.create(api,async msg=>host.finish(msg),()=>1700000000000);host=Host.create(env);}
 restart();
 return {store,files,events,downloads,get manager(){return mgr;},get host(){return host;},restart,
  save:()=>host.save(new Blob(['abc']),'RPLAY_video_p1.ts'),
  async complete(id,fileSize=3){const d=downloads.find(x=>x.id===id);d.state='complete';d.fileSize=fileSize;await mgr.changed({id});},
  failWrites:v=>{failSet=v;}};
}

test('v0.28 host stamps fresh OPFS export with active recording key, no media URL persists',async()=>{
 const f=fixture();f.host.setSessionKey(KEY_A);await f.save();
 a.equal(f.store.rsp_exports_v211.records[0].sessionKey,KEY_A);
 a.equal(f.events[0].sessionKey,KEY_A);
 a.equal(JSON.stringify(f.store).includes('blob:'),false);
 const s=await f.manager.sessionStatus(KEY_A);
 a.equal(s.requested,1);a.equal(s.complete,false);a.equal(s.historicalCoverage,'incomplete');
 a.equal('key' in s,false);a.equal('items' in s,false);
});
test('v0.28 two control epochs are isolated in retained journal projection',async()=>{
 const f=fixture();f.host.setSessionKey(KEY_A);await f.save();f.host.setSessionKey(KEY_B);await f.save();
 await f.complete(2);const aa=await f.manager.sessionStatus(KEY_A),bb=await f.manager.sessionStatus(KEY_B);
 a.equal(aa.requested,1);a.equal(aa.verified,0);a.equal(bb.verified,1);a.equal(bb.retained,1);
});
test('v0.28 unknown or legacy export does not acquire a later active key',async()=>{
 const f=fixture();await f.save();f.host.setSessionKey(KEY_A);await f.save();
 a.equal(f.store.rsp_exports_v211.records[0].sessionKey,null);
 a.equal((await f.manager.sessionStatus(KEY_A)).retained,1);
});
test('v0.28 snapshot key cannot change while OPFS staging write awaits',async()=>{
 const f=fixture();f.host.setSessionKey(KEY_A);const pending=f.save();f.host.setSessionKey(KEY_B);
 await pending;a.equal(f.store.rsp_exports_v211.records[0].sessionKey,KEY_A);
});
test('v0.28 same part retry after new host key preserves first attribution',async()=>{
 const f=fixture();f.host.setSessionKey(KEY_A);await f.save();
 // Actual retry preserves the same per-entry key; downloaded-record retry too.
 const entry=f.store.rsp_exports_v211.records[0];f.downloads[0].state='interrupted';await f.manager.changed({id:1});
 f.host.setSessionKey(KEY_B);await f.host.sweep(true);
 a.equal(f.store.rsp_exports_v211.records[0].sessionKey,KEY_A);
 a.equal(f.store.rsp_exports_v211.records[0].attempt,2);
 a.equal((await f.manager.sessionStatus(KEY_B)).retained,0);
 a.equal((await f.manager.sessionStatus(KEY_A)).retained,1);
});
test('v0.28 SW manager restart replays persisted session identity and status',async()=>{
 const f=fixture();f.host.setSessionKey(KEY_A);await f.save();await f.complete(1);
 f.restart();const s=await f.manager.sessionStatus(KEY_A);a.equal(s.verified,1);a.equal(s.complete,false);
});
test('v0.28 recovered OPFS file is never retroactively assigned to active session',async()=>{
 const f=fixture();f.files.set('p'+'f'.repeat(32)+'_RPLAY_video_p1.ts',new Blob(['abc']));
 f.host.setSessionKey(KEY_B);await f.host.sweep();
 a.equal(f.store.rsp_exports_v211.records[0].sessionKey,null);
 a.equal((await f.manager.sessionStatus(KEY_B)).retained,0);
});
test('v0.28 invalid source key fails before OPFS or downloader mutation',async()=>{
 const f=fixture();for(const bad of ['https://x/?token=secret','0'.repeat(31),'Z'.repeat(32),undefined]){
  if(bad===undefined)continue;
  a.throws(()=>f.host.setSessionKey(bad),/BAD_SESSION_KEY/);
 }
 a.equal(f.files.size,0);a.equal(f.downloads.length,0);
 a.equal((await f.manager.sessionStatus(KEY_A)).retained,0);
 await a.rejects(()=>f.manager.sessionStatus('token=test'),/SESSION_AUDIT_UNAVAILABLE/);
});
test('v0.28 forged client session key is rejected before browser download',async()=>{
 const f=fixture();await a.rejects(()=>f.manager.offer({partId:'p'+'c'.repeat(32),name:'video.ts',size:3,url:'blob:test',sessionKey:'token=secret'}),/BAD_EXPORT/);
 a.equal(f.downloads.length,0);a.equal(f.store.rsp_exports_v211,undefined);
});
test('v0.28 malformed persisted attribution fails closed, not assumed legacy',async()=>{
 const f=fixture();f.host.setSessionKey(KEY_A);await f.save();f.store.rsp_exports_v211.records[0].sessionKey='invalid';f.restart();
 await a.rejects(()=>f.manager.status(),/EXPORT_JOURNAL_INVALID/);
});
test('v0.28 failed atomic journal commit never claims attributed export',async()=>{
 const f=fixture();f.host.setSessionKey(KEY_A);f.failWrites(true);await f.save();
 a.equal(f.downloads.length,0);a.equal(f.store.rsp_exports_v211,undefined);
 f.failWrites(false);a.equal((await f.manager.sessionStatus(KEY_A)).retained,0);
});
test('v0.28 repeated completion does not double-count session verified',async()=>{
 const f=fixture();f.host.setSessionKey(KEY_A);await f.save();await f.complete(1);await f.complete(1);
 a.equal((await f.manager.sessionStatus(KEY_A)).verified,1);
});
test('v0.28 bounded journal explicitly leaves historical session coverage incomplete',async()=>{
 const f=fixture();f.host.setSessionKey(KEY_A);await f.save();const s=await f.manager.sessionStatus(KEY_A);
 a.equal(s.observedOnly,true);a.equal(s.complete,false);a.equal(s.historicalCoverage,'incomplete');
 a.equal(s.source,'retained-export-journal');
});
test('v0.28 sessionStatus does not expose URLs, filenames, raw ids, or part identifiers',async()=>{
 const f=fixture();f.host.setSessionKey(KEY_A);await f.save();const s=JSON.stringify(await f.manager.sessionStatus(KEY_A));
 a.equal(s.includes(KEY_A),false);a.equal(s.includes('p'+ 'a'.repeat(32)),false);
 a.equal(s.includes('RPLAY_video'),false);a.equal(s.includes('blob:'),false);
});
