/* StreamHarbor v0.23: read-only quick-view, explicit incomplete-ledger explanation. */
(()=>{'use strict';
const $=id=>document.getElementById(id);
const metrics=['popup-parts','popup-verified','popup-pending','popup-failed'];
const POLL_MS=5000, TIMEOUT_MS=4000;
let busy=false, queued=false, closed=false, generation=0;
let timerId=null;
function metric(id,value){$(id).textContent=value===null?'—':String(value);}
function showUnknown(text){
 $('popup-state').dataset.state='unknown';$('popup-state').textContent=text;
 $('popup-target').textContent='保存状態を確認できません';$('popup-medium').textContent='—';
 for(const id of metrics)metric(id,null);
 $('popup-audio').textContent='診断情報は取得できません。録画管理から再確認してください。';
 const note=$('popup-ledger-note');if(note)note.textContent='保存台帳の状態は未確認です';
}
function render(model){
 $('popup-state').dataset.state=model.state;$('popup-state').textContent=model.label;
 $('popup-target').textContent=model.target;$('popup-medium').textContent=model.medium;
 metric('popup-parts',model.parts);metric('popup-verified',model.verified);
 metric('popup-pending',model.pending);metric('popup-failed',model.failed);
 $('popup-audio').textContent=model.audioText;
 const note=$('popup-ledger-note');if(note)note.textContent=model.ledgerNote||'保存件数の状態は未確認です';
 const snapshotAt=model.capturedAt===null?Date.now():model.capturedAt;
 const countUnavailable=model.verified===null||model.pending===null||model.failed===null;
 $('popup-updated').textContent='録画状態の確認 '+new Date(snapshotAt).toLocaleTimeString('ja-JP',{hour:'2-digit',minute:'2-digit',second:'2-digit'})+(countUnavailable?' ／ 一部または全ての保存件数は未確認':'');
}
function bounded(promise){
 if(typeof setTimeout!=='function')return Promise.resolve(promise);
 return new Promise((resolve,reject)=>{
   const timer=setTimeout(()=>reject(Error('STATUS_TIMEOUT')),TIMEOUT_MS);
   Promise.resolve(promise).then(v=>{clearTimeout(timer);resolve(v);},e=>{clearTimeout(timer);reject(e);});
 });
}
async function refresh(){
 if(closed||document.hidden===true)return;
 if(busy){queued=true;return;}
 const requestGeneration=generation;
 busy=true;$('popup-refresh').disabled=true;$('popup-refresh').textContent='確認中…';
 try{
   if(typeof chrome==='undefined'||!chrome.runtime||typeof chrome.runtime.sendMessage!=='function')throw Error('runtime-unavailable');
   const raw=await bounded(chrome.runtime.sendMessage({type:'popup.status'}));
   if(closed||document.hidden===true||requestGeneration!==generation)return;
   const model=StreamHarborPopupState.getStatus(raw);
   if(!model)throw Error('invalid-status');
   render(model);
 }catch(e){
   if(!closed&&document.hidden!==true&&requestGeneration===generation){showUnknown('状態を取得できません');$('popup-updated').textContent='取得失敗・再試行できます';}
 }finally{
   busy=false;
   if(!closed){$('popup-refresh').disabled=false;$('popup-refresh').textContent='状態を更新';}
   if(queued&&!closed){queued=false;if(document.hidden!==true)void refresh();}
 }
}
$('popup-refresh').addEventListener('click',()=>{void refresh();});
if(typeof document.addEventListener==='function')document.addEventListener('visibilitychange',()=>{
 generation++;
 if(document.hidden===true){
   // An in-flight response cannot become the current state after a hidden interval.
   queued=false;showUnknown('再表示後に確認します');$('popup-updated').textContent='表示再開時に更新';
 }else if(busy){queued=true;}else void refresh();
});
if(typeof window!=='undefined'&&typeof window.addEventListener==='function')window.addEventListener('pagehide',()=>{
 closed=true;generation++;queued=false;if(timerId!==null&&typeof clearInterval==='function')clearInterval(timerId);
});
if(typeof setInterval==='function')timerId=setInterval(()=>{if(document.hidden!==true)void refresh();},POLL_MS);
void refresh();
})();