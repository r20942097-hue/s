/* StreamHarbor v0.27: isolated session-event journal core (NOT wired to recorder).
   No media URLs/names/bytes, no browser permissions or storage side effects.
   Counts are observed export stages, never proven completed media. */
(function(root){'use strict';
const MAX=2048,KEY=/^[a-f0-9]{32}$/,PART=/^[a-zA-Z0-9_-]{8,100}$/;
const RANK={allocated:0,staged:1,requested:2,unknown:3,verified:4,failed:4,conflict:5};
const clean=n=>Number.isSafeInteger(n)&&n>=1&&n<=64;
function invalid(){throw Error('SESSION_LEDGER_INVALID');}
function parse(raw){
 if(!raw||typeof raw!=='object'||Array.isArray(raw)||raw.version!==1||raw.scope!=='observed-session-events'||
    !KEY.test(raw.key)||!Array.isArray(raw.entries)||raw.entries.length>MAX)invalid();
 const seen=new Set(),entries=[];
 for(const e of raw.entries){
  if(!e||typeof e!=='object'||Array.isArray(e)||!PART.test(e.partId)||!clean(e.attempt)||
     !Object.hasOwn(RANK,e.stage)||seen.has(e.partId))invalid();
  seen.add(e.partId);entries.push(Object.freeze({partId:e.partId,attempt:e.attempt,stage:e.stage}));
 }
 return Object.freeze({version:1,scope:'observed-session-events',key:raw.key,entries:Object.freeze(entries)});
}
function empty(key){return parse({version:1,scope:'observed-session-events',key,entries:[]});}
function record(raw,event){
 const old=parse(raw);
 if(!event||typeof event!=='object'||Array.isArray(event)||!PART.test(event.partId)||
    !clean(event.attempt)||!Object.hasOwn(RANK,event.stage)||event.stage==='conflict')invalid();
 const idx=old.entries.findIndex(x=>x.partId===event.partId);
 let entries=old.entries.slice(),next={partId:event.partId,attempt:event.attempt,stage:event.stage};
 if(idx<0){if(entries.length>=MAX)invalid();entries.push(next);}
 else{
  const previous=entries[idx];
  if(event.attempt<previous.attempt)return old; // late callback from earlier attempt
  if(event.attempt===previous.attempt){
   if(previous.stage==='conflict'||previous.stage===event.stage||RANK[event.stage]<RANK[previous.stage])return old;
   if(RANK[event.stage]===4&&RANK[previous.stage]===4){next.stage='conflict';}
  }
  entries[idx]=next;
 }
 return parse({version:1,scope:old.scope,key:old.key,entries});
}
function summary(raw){
 const s=parse(raw),result={scope:s.scope,observedOnly:true,complete:false,
  retained:s.entries.length,allocated:0,staged:0,requested:0,unknown:0,verified:0,failed:0,conflict:0};
 for(const e of s.entries)result[e.stage]++;
 return Object.freeze(result);
}
const api=Object.freeze({empty,parse,record,summary,MAX});
if(typeof module!=='undefined'&&module.exports)module.exports=api;
root.RspSessionExportLedger=api;
})(typeof globalThis==='undefined'?this:globalThis);
