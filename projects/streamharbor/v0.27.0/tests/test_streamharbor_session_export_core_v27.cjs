'use strict';
const {test}=require('node:test'),a=require('node:assert/strict');
const core=require('../src/session_export_ledger.js');
const key='a'.repeat(32),p='p'+'a'.repeat(32);
const run=(s,stage,attempt=1)=>core.record(s,{partId:p,attempt,stage});
test('v0.27 session stage model is explicitly observed-only and never claims completion',()=>{
 const s=core.empty(key),m=core.summary(s);
 a.equal(m.scope,'observed-session-events');a.equal(m.complete,false);a.equal(m.retained,0);
 a.equal(m.verified,0);
});
test('v0.27 repeated recorded events are idempotent across JSON restart',()=>{
 let s=run(core.empty(key),'requested');s=JSON.parse(JSON.stringify(s));s=run(s,'requested');
 s=run(s,'verified');s=run(s,'verified');
 a.equal(core.summary(s).verified,1);a.equal(core.summary(s).retained,1);
});
test('v0.27 delayed previous-attempt outcomes cannot override a retry',()=>{
 let s=run(core.empty(key),'failed',1);s=run(s,'requested',2);
 s=run(s,'verified',1);a.equal(core.summary(s).requested,1);
 s=run(s,'verified',2);a.equal(core.summary(s).verified,1);
});
test('v0.27 opposing terminal reports are fail-closed conflicts not success',()=>{
 let s=run(core.empty(key),'verified');s=run(s,'failed');
 a.equal(core.summary(s).conflict,1);a.equal(core.summary(s).verified,0);
 s=run(s,'verified');a.equal(core.summary(s).conflict,1);
});
test('v0.27 a new attempt clears previous conflict without double counting',()=>{
 let s=run(run(core.empty(key),'failed'),'verified');
 s=run(s,'staged',2);a.equal(core.summary(s).staged,1);
 a.equal(core.summary(s).conflict,0);a.equal(core.summary(s).retained,1);
});
test('v0.27 invalid IDs, sessions, and non-integral attempts are rejected',()=>{
 a.throws(()=>core.empty('https://example.com/token?secret=1'),/SESSION_LEDGER_INVALID/);
 a.throws(()=>core.record(core.empty(key),{partId:'../secret',stage:'verified',attempt:1}),/SESSION_LEDGER_INVALID/);
 a.throws(()=>core.record(core.empty(key),{partId:p,stage:'verified',attempt:1.1}),/SESSION_LEDGER_INVALID/);
 a.throws(()=>core.parse({version:1,scope:'observed-session-events',key,entries:[{partId:p,stage:'verified',attempt:1},{partId:p,stage:'failed',attempt:1}]}),/SESSION_LEDGER_INVALID/);
});
test('v0.27 no mutable caller entry can change a recorded stage',()=>{
 const e={partId:p,stage:'staged',attempt:1};const s=core.record(core.empty(key),e);
 e.stage='verified';a.equal(core.summary(s).staged,1);
 a.equal(Object.isFrozen(s.entries),true);
});
