/* RPLAY host-owned OPFS staging and Blob URL lifecycle. */
(function(root){
'use strict';
function create(env){
 const entries=new Map(), jobs=new Set();let busy=0,errors=0,activeSessionKey=null;
 const SESSION_KEY=/^[a-f0-9]{32}$/; // In-memory only, never a filename or URL.

 const safe=n=>{const name=String(n||'part.bin').replace(/[\\/:*?"<>|\x00-\x1f]/g,'_');const match=name.match(/(\.[^.]+)$/);const ext=match?match[1]:'.bin';return name.slice(0,name.length-(match?ext.length:0)).slice(0,80)+ext;};
 const id=()=>env.crypto.randomUUID().replace(/-/g,'');
 async function directory(){const root=await env.navigator.storage.getDirectory();return root.getDirectoryHandle('rsp_rec',{create:true});}
 async function offer(entry,retry=false){
  if(!entry.url){const file=entry.blob||await (await (await directory()).getFileHandle(entry.name)).getFile();entry.url=env.URL.createObjectURL(file);}
  try{
   const r=await env.send({type:'export.offer',partId:entry.id,name:entry.name,size:entry.size,url:entry.url,retry,sessionKey:entry.sessionKey});
   if(!r||!r.ok)throw Error('EXPORT_OFFER_FAILED');entry.status=r.status;return r;
  }catch(e){entry.status='unverified';errors++;throw e;}
 }
 function track(p){jobs.add(p);p.then(()=>jobs.delete(p),()=>jobs.delete(p));return p;}
 return {
  // A null key explicitly marks un-attributable recovery/staging artifacts.
  // Changing the active key never changes already-staged entries.
  setSessionKey(key){if(key!==null&&(!SESSION_KEY.test(key)))throw Error('BAD_SESSION_KEY');activeSessionKey=key;},
  save(blob,name){
   const partId='p'+id(),filename=partId+'_'+safe(name);const entry={id:partId,name:filename,size:blob.size,blob,status:'staging',url:null,sessionKey:activeSessionKey};entries.set(partId,entry);
   const job=(async()=>{busy++;let w;
    try{const dir=await directory();const fh=await dir.getFileHandle(filename,{create:true});w=await fh.createWritable();await w.write(blob);await w.close();entry.blob=null;entry.status='staged';
     // Local staged bytes are confirmed; export is independently tracked.
     try{await offer(entry);}catch(e){}return {confirmed:true,stage:'OPFS_STAGED',partId};
    }catch(e){if(w)try{await w.abort();}catch(ignored){}entry.status='stage_failed';errors++;throw Error('OPFS_STAGE_FAILED');}finally{busy--;}
   })();return track(job);
  },
  async finish(msg){const e=entries.get(msg.partId);
   if(!e){
    if(msg.remove===false)return {ok:true};
    if(msg.status!=='verified'||typeof msg.name!=='string'||/[\\/\x00-\x1f]/.test(msg.name))return {ok:false};
    const dir=await directory();
    try{await dir.getFileHandle(msg.name);}catch(err){if(err.name==='NotFoundError')return {ok:true};throw err;}
    await dir.removeEntry(msg.name);return {ok:true};
   }
   if(msg.remove===true){if(msg.status!=='verified')return {ok:false};await (await directory()).removeEntry(e.name);}
   if(e.url){env.URL.revokeObjectURL(e.url);e.url=null;}
   e.status=msg.status;if(msg.remove)entries.delete(e.id);return {ok:true};
  },
  async sweep(retry=false){
   busy++;try{
    const dir=await directory();for await(const [name,h]of dir.entries()){
     if(h.kind!=='file'||!/\.(ts|flv|mp4|json|csv)$/i.test(name))continue;
     let e=[...entries.values()].find(x=>x.name===name);
     if(!e){const file=await h.getFile();const m=name.match(/^(p[a-f0-9]{32})_/);let partId=m?m[1]:'legacy'+Array.from(new Uint8Array(await env.crypto.subtle.digest('SHA-256',new TextEncoder().encode(name)))).map(x=>x.toString(16).padStart(2,'0')).join('');
      e={id:partId,name,size:file.size,blob:null,status:file.size?'staged':'stage_incomplete',url:null,sessionKey:null};entries.set(e.id,e);}
     // Failed in-memory staging is retried below, never export a possibly partial OPFS file.
     if(!['stage_failed','staging'].includes(e.status)&&e.size>0)try{await offer(e,retry);}catch(ignored){}
    }
    for(const e of [...entries.values()].filter(e=>e.status==='stage_failed')){
     if(!retry)continue;let w;try{const fh=await dir.getFileHandle(e.name,{create:true});w=await fh.createWritable();await w.write(e.blob);await w.close();e.blob=null;e.status='staged';await offer(e,true);}catch(err){if(w)try{await w.abort();}catch(ignored){}errors++;}
    }
    return {ok:true,...this.status()};
   }finally{busy--;}
  },
  async drain(){while(jobs.size)await Promise.allSettled([...jobs]);return this.status();},
  status(){return {busy:busy+jobs.size,retained:entries.size,stageFailed:[...entries.values()].filter(e=>e.status==='stage_failed').length,errors};},
  idle(){return busy===0&&jobs.size===0&&entries.size===0;},
  /* v2.48.0(統合): 未確定(staging/stage_failed)パート名 — 破棄候補除外やMP4自動引渡しの
     sweepが書き込み途中のパートを変換対象にしないための共有ビュー(読み取り専用)。 */
  inFlightNames(){return [...entries.values()].filter(e=>e.status==='staging'||e.status==='stage_failed').map(e=>e.name);}
 };
}
const value={create};if(typeof module!=='undefined')module.exports=value;root.RspExportHost=value;
})(typeof globalThis==='undefined'?this:globalThis);
