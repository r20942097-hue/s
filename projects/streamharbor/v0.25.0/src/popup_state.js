/* StreamHarbor v0.25: split live-session window and global export journal. */
(function(root){'use strict';
function whole(value){return Number.isSafeInteger(value)&&value>=0?value:null;}
function getStatus(raw, nowMs=Date.now()){
 if(!raw||typeof raw!=='object'||Array.isArray(raw)||raw.ok!==true)return null;
 // v0.20: responses timestamped by the background must be recent.
 // Legacy fixture payloads omit capturedAt; they remain backwards compatible.
 if(Object.prototype.hasOwnProperty.call(raw,'capturedAt')){
   const at=raw.capturedAt;
   if(!Number.isSafeInteger(at)||at<1577836800000||!Number.isFinite(nowMs)||at>nowMs+3000||nowMs-at>10000)return null;
 }
 let state='unknown';
 if(raw.draining===true)state='draining';
 else if(raw.recording===true)state=raw.state==='STANDBY'?'standby':'recording';
 else if(raw.recording===false)state='idle';
 const labels={draining:'保存処理中',recording:'録画中',standby:'追跡待機中',idle:'録画していません',unknown:'状態不明'};
 const exports=raw.exports&&typeof raw.exports==='object'?raw.exports:{};
 const requested=whole(exports.requested),unknown=whole(exports.unknown);
 // Missing components cannot be counted as zero.
 const pending=requested===null||unknown===null?null:requested+unknown;
 const safePending=pending!==null&&Number.isSafeInteger(pending)?pending:null;
 // Only static labels derived from validation results may enter the UI.
 // An unknown component is never presented as a measured zero.
 const missing=[];
 if(whole(exports.verified)===null)missing.push('サイズ照合済み');
 if(safePending===null){
   if(requested===null||unknown===null){
     const reasons=[];
     if(requested===null)reasons.push('依頼済み件数');
     if(unknown===null)reasons.push('状態不明件数');
     missing.push('確認待ち（'+reasons.join('・')+'が未取得）');
   }else missing.push('確認待ち（合計値が範囲外）');
 }
 if(whole(exports.failed)===null)missing.push('失敗');
 const ledgerNote=(missing.length?'未確認の保存件数: '+missing.join('、'):'保存件数の内訳を取得済み（保存ファイル・映像・音声の整合性は別途検証）')+'。全録画共通の台帳で、現在の録画だけの件数ではありません';
 // The ledger is separate from the recorder snapshot and is not session-scoped.
 const ledgerCapturedAt=Number.isSafeInteger(raw.ledgerCapturedAt)&&raw.ledgerCapturedAt>=1577836800000&&raw.ledgerCapturedAt<=nowMs+3000?raw.ledgerCapturedAt:null;
 // The rec.status parts list is the last <=100 entries, not the total
 // number of recorded/saved parts. Idle payloads can contain older entries.
 const sessionActive=raw.recording===true;
 const observedParts=Object.prototype.hasOwnProperty.call(raw,'partCount')?whole(raw.partCount):Array.isArray(raw.parts)?whole(raw.parts.length):null;
 const partCount=sessionActive?observedParts:null;
 const partsText=partCount===null?'—':partCount>=100?'100件以上':String(partCount);
 const partsNote=partCount===null?(sessionActive?'パート情報は取得できません':'録画停止中。前回のパートは現在の録画として表示しません'):
   (partCount>=100?'直近100件を表示しています。総パート数は100件以上ですが確定できません':'稼働セッションから取得できたパート一覧の件数です')+'。保存完了数ではありません';
 const audio=raw.audioTransition&&typeof raw.audioTransition==='object'?raw.audioTransition:null;
 let audioText='別音声の状態情報はありません';
 if(audio){
   const queue=whole(audio.abandonedQueuedOnSourceChange);
   const active=whole(audio.activeSegmentAtSourceChange);
   const stale=whole(audio.staleSegmentResultsIgnored);
   const lower=audio.abandonedQueuedHistoryComplete!==true;
   const count=(n)=>n===null?'不明':lower?'少なくとも'+n+'件':n+'件';
   audioText='切替時の未処理キュー '+count(queue)+' ／ 処理中 '+count(active)+' ／ 旧音声源の遅延結果 '+count(stale);
   audioText+='（いずれも音声欠落や同期ずれの測定値ではありません）';
 }
 // Deliberately omit signed playlist/source URLs, auth data, and raw creator IDs.
 const target=raw.urlSession===true?'URL録画':typeof raw.creatorName==='string'&&raw.creatorName.trim()?raw.creatorName.trim().slice(0,90):'録画対象の情報なし';
 return Object.freeze({state,label:labels[state],target,capturedAt:Number.isSafeInteger(raw.capturedAt)?raw.capturedAt:null,ledgerCapturedAt,ledgerScope:'all-recorded-exports',medium:typeof raw.medium==='string'&&/^[a-z0-9-]{1,20}$/i.test(raw.medium)?raw.medium.toUpperCase():'—',parts:partCount,partsText,partsNote,verified:whole(exports.verified),pending:safePending,failed:whole(exports.failed),ledgerNote,audioText});
}
const api={getStatus,whole};if(typeof module!=='undefined'&&module.exports)module.exports=api;root.StreamHarborPopupState=api;
})(globalThis);
