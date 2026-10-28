'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),{webcrypto}=require('node:crypto');
const Manager=require('../rplay-stable-player-extension/export_manager.js'),Host=require('../rplay-stable-player-extension/export_host.js');
function harness(){
 const h={files:new Map(),downloads:[],store:{},revoked:[],calls:0,sets:0,quota:false,failClose:false,failRemove:false,failSet:0,failDownload:false};let manager,host;
 const copy=x=>structuredClone(x);
 const api={runtime:{lastError:null},storage:{local:{get:(k,cb)=>queueMicrotask(()=>cb(copy(h.store))),set:(o,cb)=>{h.sets++;queueMicrotask(()=>{if(h.sets===h.failSet){api.runtime.lastError={message:'fail'};cb();api.runtime.lastError=null;}else{Object.assign(h.store,copy(o));cb();}});}}},downloads:{
  download:(o,cb)=>{h.calls++;if(h.failDownload){api.runtime.lastError={message:'fail'};cb();api.runtime.lastError=null;return;}const item={id:h.calls,state:'in_progress',filename:'/Downloads/'+o.filename,startTime:new Date(1700000000000).toISOString()};h.downloads.push(item);cb(item.id);},
  search:(q,cb)=>queueMicrotask(()=>cb(copy(q.id===undefined?h.downloads:h.downloads.filter(i=>i.id===q.id))))
 }};
 const dir={getFileHandle:async(name,opt)=>{if(!h.files.has(name)&&!opt?.create)throw new DOMException('missing','NotFoundError');if(!h.files.has(name))h.files.set(name,new Blob([]));return {kind:'file',getFile:async()=>h.files.get(name),createWritable:async()=>{if(h.quota)throw Error('quota');let blob;return {write:async b=>{blob=b;},close:async()=>{if(h.failClose)throw Error('close');h.files.set(name,blob);},abort:async()=>{}};}};},removeEntry:async n=>{if(h.failRemove)throw Error('remove');if(!h.files.has(n))throw Error('notfound');h.files.delete(n);},async *entries(){for(const n of h.files.keys())yield[n,{kind:'file',getFile:async()=>h.files.get(n)}];}};
 const env={navigator:{storage:{getDirectory:async()=>({getDirectoryHandle:async()=>dir})}},crypto:webcrypto,URL:{createObjectURL:()=> 'blob:ext/'+webcrypto.randomUUID(),revokeObjectURL:u=>h.revoked.push(u)},send:msg=>manager.offer(msg)};
 function restore(){manager=Manager.create(api,m=>host.finish(m),()=>1700000000000);host=Host.create(env);}
 restore();Object.defineProperties(h,{manager:{get:()=>manager},host:{get:()=>host}});h.restore=restore;h.api=api;
 h.save=()=>host.save(new Blob([Buffer.from('abc')]),'RPLAY_test_p1.ts');
 h.event=async(state,size,id=1)=>{const item=h.downloads.find(x=>x.id===id);item.state=state;if(size!==undefined)item.fileSize=size;await manager.changed({id});};return h;
}
test('start is not completion; host creates blob URL, SW keeps no URL',async()=>{const h=harness();await h.save();assert.equal(h.calls,1);assert.equal(h.files.size,1);assert.equal(h.host.status().retained,1);assert.equal((await h.manager.status()).verified,0);assert(!JSON.stringify(h.store).includes('blob:'));});
test('complete + size match releases exact staged bytes and URL',async()=>{const h=harness();await h.save();await h.event('complete',3);assert.equal(h.files.size,0);assert.equal(h.revoked.length,1);assert.equal((await h.manager.status()).verified,1);assert(h.host.idle());});
test('interruption retains staged bytes',async()=>{const h=harness();await h.save();await h.event('interrupted');assert.equal(h.files.size,1);assert.equal((await h.manager.status()).failed,1);assert.equal(h.revoked.length,1);});
test('size mismatch is a failure and preserves bytes',async()=>{const h=harness();await h.save();await h.event('complete',2);assert.equal(h.files.size,1);assert.equal((await h.manager.status()).failed,1);});
test('size unknown never cleans staging',async()=>{const h=harness();await h.save();await h.event('complete');assert.equal(h.files.size,1);assert.equal((await h.manager.status()).unknown,1);});
test('late size confirmation cleans staging once',async()=>{const h=harness();await h.save();await h.event('complete');await h.event('complete',3);await h.event('complete',3);assert.equal(h.files.size,0);assert.equal((await h.manager.status()).verified,1);});
test('late mismatch corrects unverified complete',async()=>{const h=harness();await h.save();await h.event('complete');await h.event('complete',4);assert.equal(h.files.size,1);assert.equal((await h.manager.status()).failed,1);});
test('journal write failure prevents external download, keeps staged data',async()=>{const h=harness();h.failSet=1;const r=await h.save();assert(r.confirmed);assert.equal(h.calls,0);assert.equal(h.files.size,1);});
test('post-request checkpoint failure reconciles by unique filename without re-download',async()=>{const h=harness();h.failSet=2;await h.save();assert.equal(h.calls,1);h.restore();await h.host.sweep();assert.equal(h.calls,1);await h.event('complete',3);assert.equal(h.files.size,0);});
test('SW restart restores download id and completion',async()=>{const h=harness();await h.save();h.restore();await h.host.sweep();assert.equal(h.calls,1);await h.event('complete',3);assert.equal(h.files.size,0);});
test('duplicate complete does not duplicate confirmed count',async()=>{const h=harness();await h.save();await h.event('complete',3);await h.event('complete',3);assert.equal((await h.manager.status()).verified,1);});
test('unknown download id is ignored',async()=>{const h=harness();await h.save();await h.manager.changed({id:999});assert.equal(h.files.size,1);});
test('export request API failure is not successful',async()=>{const h=harness();h.failDownload=true;await h.save();assert.equal((await h.manager.status()).failed,1);assert.equal(h.files.size,1);});
test('explicit retry creates a fresh attempt and ignores old events',async()=>{const h=harness();await h.save();await h.event('interrupted');await h.host.sweep(true);assert.equal(h.calls,2);await h.event('complete',3,1);assert.equal(h.files.size,1);await h.event('complete',3,2);assert.equal(h.files.size,0);});
test('automatic sweep does not retry failed download',async()=>{const h=harness();await h.save();await h.event('interrupted');await h.host.sweep();assert.equal(h.calls,1);});
test('OPFS quota error rejects local success and retains recoverable RAM blob',async()=>{const h=harness();h.quota=true;await assert.rejects(()=>h.save(),/OPFS_STAGE_FAILED/);assert.equal(h.host.status().stageFailed,1);assert.equal(h.calls,0);h.quota=false;await h.host.sweep(true);assert.equal(h.calls,1);await h.event('complete',3);assert.equal(h.files.size,0);});
test('OPFS close error never starts an external download',async()=>{const h=harness();h.failClose=true;await assert.rejects(()=>h.save());assert.equal(h.calls,0);assert.equal(h.host.status().stageFailed,1);});
test('cleanup failure preserves pending marker and retries after recovery',async()=>{const h=harness();await h.save();h.failRemove=true;await assert.rejects(()=>h.event('complete',3));assert.equal(h.files.size,1);h.failRemove=false;await h.manager.reconcile();assert.equal(h.files.size,0);assert.equal((await h.manager.status()).cleanupPending,0);});
test('corrupt journal fails closed',async()=>{const h=harness();h.store.rsp_exports_v211={version:99,records:[]};await h.save();assert.equal(h.calls,0);assert.equal(h.files.size,1);});
test('empty OPFS remnant is retained but never exported as complete',async()=>{const h=harness();h.files.set('RPLAY_unfinished.ts',new Blob([]));await h.host.sweep();assert.equal(h.calls,0);assert.equal(h.host.status().retained,1);});
test('multiple independent parts tolerate reversed completions',async()=>{const h=harness();await h.save();await h.save();await h.event('complete',3,2);assert.equal(h.files.size,1);await h.event('interrupted',undefined,1);assert.equal(h.files.size,1);assert.equal((await h.manager.status()).verified,1);});

test('cleanup ACK lost across host restart is reconciled idempotently',async()=>{const h=harness();await h.save();const rec=h.store.rsp_exports_v211.records[0];rec.status='verified';rec.cleanupPending=true;h.downloads[0].state='complete';h.downloads[0].fileSize=3;h.files.clear();h.restore();await h.manager.reconcile();assert.equal((await h.manager.status()).cleanupPending,0);});
test('long template names preserve the media extension',async()=>{const h=harness();await h.host.save(new Blob(['abc']),'RPLAY_'+('x'.repeat(150))+'.ts');assert.equal(h.calls,1);assert(h.downloads[0].filename.endsWith('.ts'));});
test('full journal does not evict unverified exports to admit new download',async()=>{const h=harness();h.store.rsp_exports_v211={version:1,records:Array.from({length:512},(_,i)=>({partId:'part'+String(i).padStart(8,'0'),name:'RPLAY_'+i+'_a1.ts',stageName:'RPLAY_'+i+'.ts',size:3,attempt:1,status:'unverified',downloadId:null,requestedAt:1700000000000,cleanupPending:false}))};await h.save();assert.equal(h.calls,0);assert.equal(h.store.rsp_exports_v211.records.length,512);assert.equal(h.store.rsp_exports_v211.records[0].partId,'part00000000');assert.equal(h.files.size,1);});
test('export list exposes bounded metadata with real status transitions and survives router restart',async()=>{const h=harness();await h.save();let st=await h.manager.status();assert.equal(st.items.length,1);assert.equal(st.items[0].status,'requested');assert.deepEqual(Object.keys(st.items[0]).sort(),['name','requestedAt','size','status']);st.items[0].status='verified';assert.equal((await h.manager.status()).items[0].status,'requested');await h.event('interrupted');assert.equal((await h.manager.status()).items[0].status,'interrupted');h.restore();assert.equal((await h.manager.status()).items[0].status,'interrupted');});
test('export list is limited to latest 100 entries while summary covers all journal records',async()=>{const h=harness();h.store.rsp_exports_v211={version:1,records:Array.from({length:512},(_,i)=>({partId:'part'+String(i).padStart(8,'0'),name:'RPLAY_'+i+'_a1.ts',stageName:'RPLAY_'+i+'.ts',size:3,attempt:1,status:'unverified',downloadId:null,requestedAt:1700000000000,cleanupPending:false}))};const s=await h.manager.status();assert.equal(s.unknown,512);assert.equal(s.items.length,100);assert.equal(s.items[0].name,'RPLAY_511_a1.ts');assert.equal(s.items.at(-1).name,'RPLAY_412_a1.ts');});

test('v0.27 empty new export journal has known zero evictions, bounded metadata',async()=>{
 const h=harness();const s=await h.manager.status();
 assert.equal(s.retained,0);assert.equal(s.capacity,512);assert.equal(s.verifiedEvictions,false);
 await h.save();const x=await h.manager.status();
 assert.equal(x.retained,1);assert.equal(x.verifiedEvictions,false);
 assert.deepEqual(h.store.rsp_exports_v211.coverage,{verifiedEvictions:false});
});
test('v0.27 legacy journal eviction provenance is unknown, even after new offers',async()=>{
 const h=harness();h.store.rsp_exports_v211={version:1,records:[]};
 assert.equal((await h.manager.status()).verifiedEvictions,null);
 await h.save();assert.equal((await h.manager.status()).verifiedEvictions,null);
 assert.deepEqual(h.store.rsp_exports_v211.coverage,{verifiedEvictions:null});
});
test('v0.27 evicted verified journal entries remain never counted as retained successes',async()=>{
 const h=harness();const records=Array.from({length:512},(_,i)=>({
  partId:'part'+String(i).padStart(8,'0'),name:'RPLAY_'+i+'_a1.ts',stageName:'RPLAY_'+i+'.ts',
  size:3,attempt:1,status:i<2?'verified':'unverified',downloadId:null,requestedAt:1700000000000,cleanupPending:false
 }));
 h.store.rsp_exports_v211={version:1,records,coverage:{verifiedEvictions:false}};
 await h.save();const s=await h.manager.status();
 assert.equal(s.retained,511);assert.equal(s.capacity,512);
 assert.equal(s.verified,0);assert.equal(s.unknown,510);assert.equal(s.verifiedEvictions,true);
 assert.equal(h.store.rsp_exports_v211.records.length,511);
});
test('v0.27 verified eviction provenance survives router restart and retry',async()=>{
 const h=harness();h.store.rsp_exports_v211={version:1,records:Array.from({length:512},(_,i)=>({
  partId:'part'+String(i).padStart(8,'0'),name:'RPLAY_'+i+'_a1.ts',stageName:'RPLAY_'+i+'.ts',
  size:3,attempt:1,status:i===0?'verified':'unverified',downloadId:null,requestedAt:1700000000000,cleanupPending:false
 })),coverage:{verifiedEvictions:null}};
 await h.save();assert.equal((await h.manager.status()).verifiedEvictions,true);
 h.restore();assert.equal((await h.manager.status()).verifiedEvictions,true);
});
test('v0.27 malformed provenance fails closed without external download',async()=>{
 for(const invalid of [{verifiedEvictions:0},{verifiedEvictions:'false'},{},[],true]){
  const h=harness();h.store.rsp_exports_v211={version:1,records:[],coverage:invalid};
  await h.save();assert.equal(h.calls,0);assert.equal(h.files.size,1);
 }
});
test('v0.27 failed journal write does not claim eviction or download completion',async()=>{
 const h=harness();h.failSet=1;
 await h.save();assert.equal(h.calls,0);
 assert.equal(h.store.rsp_exports_v211,undefined);
 assert.equal((await h.manager.status()).verifiedEvictions,false);
});
test('v0.27 retained count never includes entries that were intentionally evicted',async()=>{
 const h=harness();h.store.rsp_exports_v211={version:1,coverage:{verifiedEvictions:true},records:[]};
 assert.equal((await h.manager.status()).verifiedEvictions,true);
 await h.save();await h.event('complete',3);
 assert.equal((await h.manager.status()).retained,1);
 assert.equal((await h.manager.status()).verifiedEvictions,true);
});
