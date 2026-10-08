import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createGateway} from './helpers.mjs';
import {sendWebhook,webhookURL,alertDefaults} from '../src/alerts.js';
async function fixture(){
 const dataDir=mkdtempSync(join(tmpdir(),'relay-alerts-'));let now=Date.now(),app,fail=false;const sent=[];
 const options={dataDir,adminToken:'test-admin-'.repeat(5),autoStart:false,now:()=>now,alertSender:async event=>{sent.push(event);if(fail)throw Error('secret internal error');}};
 async function start(){app=await createGateway(options);}await start();
 return {get app(){return app;},sent,fail(v){fail=v;},advance(ms){now+=ms;},async restart(){await app.close();await start();},
 async settings(p={}){return app.alerts.save({settings:{...alertDefaults,enabled:true,rejections:1,...p},url:'https://alerts.example.test/private-secret-path',signingSecret:'signing-secret'});},
 async reject(){try{app.abuse.reject('request_source');}catch{}await app.abuse.flushRejections();},
 async close(){await app.close();rmSync(dataDir,{recursive:true,force:true});}};
}
test('alerts default off, redact encrypted settings, deduplicate across restart and report recovery',async()=>{
 const f=await fixture();try{
  await f.reject();await f.app.alerts.tick();assert.equal(f.sent.length,0);
  const state=await f.settings();assert.equal(state.configured,true);assert.ok(!JSON.stringify(state).includes('private-secret-path'));assert.ok(!JSON.stringify(state).includes('signing-secret'));
  const stored=await f.app.db.prepare('SELECT secret FROM alert_settings').get();assert.ok(!stored.secret.includes('private-secret-path'));
  await f.app.alerts.tick();assert.equal(f.sent.length,1);assert.equal(f.sent[0].payload.state,'firing');
  await f.app.alerts.tick();await f.restart();await f.app.alerts.tick();assert.equal(f.sent.length,1);
  f.advance(360001);await f.app.alerts.tick();assert.equal(f.sent.length,2);assert.equal(f.sent[1].payload.state,'resolved');
  assert.ok(!JSON.stringify(f.sent[0].payload).includes('secret'));
 }finally{await f.close();}
});
test('webhook retries reuse event IDs, persist attempts, cap attempts and configuration cancels old jobs',async()=>{
 const f=await fixture();try{
  await f.settings();await f.reject();f.fail(true);await f.app.alerts.tick();assert.equal(f.sent.length,1);const id=f.sent[0].id;
  await f.restart();await f.app.alerts.tick();assert.equal(f.sent.length,1);
  for(let attempt=1;attempt<6;attempt++){f.advance(60000*2**(attempt-1));await f.app.alerts.tick();}
  const row=await f.app.db.prepare('SELECT * FROM alert_notifications WHERE id=?').get(id);assert.equal(row.state,'failed');assert.equal(row.attempts,6);
  assert.equal(f.sent.filter(e=>e.id===id).length,6);assert.equal(row.error,'Webhook delivery failed');
  await f.settings({enabled:false});assert.equal((await f.app.db.prepare("SELECT count(*) n FROM alert_notifications WHERE state='pending'").get()).n,0);
  const count=f.sent.length;f.advance(86400000);await f.app.alerts.tick();assert.equal(f.sent.length,count);
 }finally{await f.close();}
});
test('webhook refuses unsafe schemes and private, loopback, mapped and mixed DNS answers',async()=>{
 assert.throws(()=>webhookURL('http://example.com'),e=>e.status===400);assert.throws(()=>webhookURL('https://user:secret@example.com'),e=>e.status===400);
 for(const addresses of [['127.0.0.1'],['10.0.0.1'],['::ffff:127.0.0.1'],['169.254.169.254'],['8.8.8.8','192.168.1.1']]){
  await assert.rejects(sendWebhook({url:'https://example.com',payload:{},id:'id'},async()=>addresses.map(address=>({address}))),/public addresses/);
 }
});
