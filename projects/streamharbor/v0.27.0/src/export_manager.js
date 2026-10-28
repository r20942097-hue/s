/* RPLAY export journal v1. URLs and media bytes are never persisted here. */
(function(root){
'use strict';
function create(api, sendHost, now=Date.now) {
 const KEY='rsp_exports_v211'; let serial=Promise.resolve(); let ready=false, records=[],evictedVerified=null;
 const tx=fn=>{const p=serial.then(fn);serial=p.catch(()=>{});return p;};
 const safe=n=>typeof n==='string'&&n.length<=180&&!/[\\/\x00-\x1f]/.test(n)&&/\.(ts|flv|mp4|json|csv)$/i.test(n);
 function call(obj,method,arg){return new Promise((resolve,reject)=>{try{obj[method](arg,r=>{const e=api.runtime.lastError;if(e)reject(Error('BROWSER_API_ERROR'));else resolve(r);});}catch(e){reject(Error('BROWSER_API_ERROR'));}});}
 async function load(){if(ready)return;const state=await call(api.storage.local,'get',KEY);const s=state&&state[KEY];
  if(s!==undefined&&(!s||s.version!==1||!Array.isArray(s.records)))throw Error('EXPORT_JOURNAL_INVALID');
  records=s?s.records:[];
  // Older v1 journals never tracked evictions: history completeness is unknown.
  // New empty journals can initially attest that no verified rows were evicted.
  if(!s)evictedVerified=false;
  else if(!Object.prototype.hasOwnProperty.call(s,'coverage'))evictedVerified=null;
  else {
    const c=s.coverage;
    if(!c||typeof c!=='object'||Array.isArray(c)||!Object.prototype.hasOwnProperty.call(c,'verifiedEvictions')||
      (c.verifiedEvictions!==true&&c.verifiedEvictions!==false&&c.verifiedEvictions!==null))throw Error('EXPORT_JOURNAL_INVALID');
    evictedVerified=c.verifiedEvictions;
  }
  if(records.length>512||records.some(r=>!r||!/^[a-zA-Z0-9_-]{8,100}$/.test(r.partId)||!safe(r.name)||!safe(r.stageName)||!Number.isSafeInteger(r.size)||r.size<0||!['requested','unverified','complete_unknown','verified','interrupted','size_mismatch','request_failed'].includes(r.status)||!Number.isSafeInteger(r.attempt)||r.attempt<1||!Number.isSafeInteger(r.requestedAt)||!(r.downloadId===null||(Number.isSafeInteger(r.downloadId)&&r.downloadId>=0))))throw Error('EXPORT_JOURNAL_INVALID');
  if(new Set(records.map(r=>r.partId)).size!==records.length)throw Error('EXPORT_JOURNAL_INVALID');
  ready=true;
 }
 async function persist(next,nextCoverage=evictedVerified){
  // Commit the coverage marker and records in one browser storage transaction.
  // Never mark an unknown older history as complete just because a new write succeeded.
  await call(api.storage.local,'set',{[KEY]:{version:1,records:next,coverage:{verifiedEvictions:nextCoverage}}});
  records=next;evictedVerified=nextCoverage;
 }
 function summary(){const count=s=>records.filter(r=>r.status===s).length;return {requested:count('requested'),verified:count('verified'),unknown:count('unverified')+count('complete_unknown'),failed:count('interrupted')+count('size_mismatch')+count('request_failed'),cleanupPending:records.filter(r=>r.cleanupPending).length,retained:records.length,capacity:512,verifiedEvictions:evictedVerified,items:records.slice(-100).reverse().map(r=>({name:r.name,size:r.size,status:r.status,requestedAt:r.requestedAt}))};}
 async function finish(r){
  const response=await sendHost({type:'export.finish',partId:r.partId,name:r.stageName,status:r.status,remove:r.status==='verified'});
  if(r.status==='verified'&&response&&response.ok){const next=records.map(x=>x.partId===r.partId?{...x,cleanupPending:false}:x);await persist(next);}
 }
 async function apply(item){const index=records.findIndex(r=>r.downloadId===item.id);if(index<0)return;
  const old=records[index];if(['interrupted','size_mismatch','request_failed'].includes(old.status))return;
  let status=old.status;const size=Number.isSafeInteger(item.fileSize)&&item.fileSize>=0?item.fileSize:null;
  if(item.state==='complete')status=size===null?'complete_unknown':size===old.size?'verified':'size_mismatch';
  else if(item.state==='interrupted'&&old.status!=='verified')status='interrupted';
  if(status===old.status&&!old.cleanupPending)return;
  const next=records.map((r,i)=>i===index?{...r,status,cleanupPending:status==='verified'}:r);
  await persist(next);await finish(records[index]);
 }
 async function reconcileOne(r){
  let items;
  if(r.downloadId!==null)items=await call(api.downloads,'search',{id:r.downloadId});
  else {
   items=await call(api.downloads,'search',{startedAfter:new Date(r.requestedAt-2000).toISOString(),limit:1000});
   items=items.filter(i=>typeof i.filename==='string'&&i.filename.replace(/\\/g,'/').split('/').pop()===r.name&&Date.parse(i.startTime)>=r.requestedAt-2000);
  }
  if(items.length!==1){if(r.downloadId===null&&r.status==='requested')await persist(records.map(x=>x.partId===r.partId?{...x,status:'unverified'}:x));return;}
  const item=items[0];if(r.downloadId===null)await persist(records.map(x=>x.partId===r.partId?{...x,downloadId:item.id}:x));
  await apply(item);
 }
 return {
  offer:msg=>tx(async()=>{
   await load();if(!msg||!/^[a-zA-Z0-9_-]{8,100}$/.test(msg.partId)||!safe(msg.name)||!Number.isSafeInteger(msg.size)||msg.size<0||typeof msg.url!=='string'||!msg.url.startsWith('blob:'))throw Error('BAD_EXPORT');
   const existing=records.find(r=>r.partId===msg.partId);
   if(existing&&!(msg.retry===true&&['interrupted','size_mismatch','request_failed'].includes(existing.status))){await reconcileOne(existing);return {ok:true,status:records.find(r=>r.partId===msg.partId).status};}
   const attempt=existing?existing.attempt+1:1;
   const name=msg.name.replace(/(\.[^.]+)$/,'_a'+attempt+'$1');
   if(!safe(name))throw Error('BAD_NAME');
   let next=records.filter(r=>r.partId!==msg.partId);
   // Never evict unverified/failed data to make space. Only settled cleaned records.
   let nextCoverage=evictedVerified;
   if(next.length>=512){
     const eligible=next.filter(r=>r.status==='verified'&&!r.cleanupPending);
     if(eligible.length){next=next.filter(r=>!(r.status==='verified'&&!r.cleanupPending));nextCoverage=true;}
   }
   if(next.length>=512)throw Error('EXPORT_JOURNAL_FULL');
   const record={partId:msg.partId,name,stageName:msg.name,size:msg.size,attempt,status:'requested',downloadId:null,requestedAt:now(),cleanupPending:false};
   await persist(next.concat(record),nextCoverage);
   let id;
   try{id=await call(api.downloads,'download',{url:msg.url,filename:'RPLAY/'+name,conflictAction:'uniquify'});}catch(e){await persist(records.map(r=>r.partId===msg.partId?{...r,status:'request_failed'}:r));await finish(records.find(r=>r.partId===msg.partId));return {ok:false,error:'REQUEST_FAILED'};}
   if(!Number.isSafeInteger(id)||id<0)throw Error('INVALID_DOWNLOAD_ID');
   // If this checkpoint fails, the pre-request record and unique name permit reconciliation.
   await persist(records.map(r=>r.partId===msg.partId?{...r,downloadId:id}:r));
   await reconcileOne(records.find(r=>r.partId===msg.partId));return {ok:true,status:records.find(r=>r.partId===msg.partId).status};
  }),
  changed:delta=>tx(async()=>{await load();if(!records.some(r=>r.downloadId===delta.id))return;const items=await call(api.downloads,'search',{id:delta.id});if(items.length===1)await apply(items[0]);}),
  reconcile:()=>tx(async()=>{await load();for(const r of [...records])if(['requested','unverified','complete_unknown'].includes(r.status)||r.cleanupPending)await reconcileOne(r);return summary();}),
  status:()=>tx(async()=>{await load();return summary();}),
  pending:()=>tx(async()=>{await load();return records.some(r=>r.status!=='verified'||r.cleanupPending);})
 };
}
const value={create};if(typeof module!=='undefined')module.exports=value;root.RspExportManager=value;
})(typeof globalThis==='undefined'?this:globalThis);
