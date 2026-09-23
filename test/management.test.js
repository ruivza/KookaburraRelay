import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGateway } from "./helpers.mjs";
const admin='test-admin-'.repeat(5);
async function fixture() {
  const dataDir=mkdtempSync(join(tmpdir(),'perch-console-'));
  let time=Date.now(), app, base, result={status:200}, released;
  const sent=[];
  const options={dataDir,adminToken:admin,now:()=>time,autoStart:false,
    providerFactory:()=>({send:async(d,t,p)=>{sent.push({d,t,p});return typeof result==='function'?result():result;},close(){}}),
    fcmFactory:()=>({send:async(d,t,m)=>{sent.push({d,t,m});return result;},close(){}})};
  async function start(){app=(await createGateway(options));await new Promise(r=>app.server.listen(0,'127.0.0.1',r));base='http://127.0.0.1:'+app.server.address().port;}
  await start();
  return {
    get app(){return app;}, get now(){return time;}, sent,
    advance(ms){time+=ms;}, result(v){result=v;},
    async restart(){await app.close();await start();},
    async call(path,body,token=admin,method=body?'POST':'GET'){
    if(path.startsWith('/admin/') && token===admin) token=(await (await fetch(base+'/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token:admin})})).json()).session;
      const res=await fetch(base+path,{method,headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});
      return {status:res.status,body:await res.json()};
    },
    async enroll(id='perch-mail',channel='apns',deviceId='phone',deviceToken){
      const enrollment={appId:id,deviceId,serverId:'server',channel,platform:channel==='apns'?'ios':'android',environment:channel==='apns'?'sandbox':'production',deviceToken:deviceToken ?? (channel==='apns'?'ab'.repeat(32):'AbC_MixedCaseToken:123456789'),nonce:'n'.repeat(40)};
      const pending=await this.call('/v1/registrations',enrollment,'');assert.equal(pending.status,202);
      const last=sent.at(-1),proof=channel==='apns'?last.p.perchRegistration:last.m.proof;
      const grant=await this.call('/v1/registrations/'+proof.id+'/confirm',proof,'');assert.equal(grant.status,200);return {...grant.body,deviceId};
    },
    async configure(id='perch-mail') { return (await app.applications.update(id,{name:'Mail',enabled:true,apns:{privateKey:'fixture',keyId:'ABCDEFGHIJ',teamId:'0123456789',topic:'com.example.'+id,environment:'both'}})); },
    async close(){await app.close();rmSync(dataDir,{recursive:true,force:true});},
  };
}
const scope = (g,requestId='request-00000000001')=>({appId:g.appId,deviceId:g.deviceId,serverId:'server',kind:'sync',requestId});
test('durable async tasks deduplicate, resume waiting tasks, back off, and preserve accepted records',async()=>{
  const f=await fixture();
  try {
    (await f.configure());const g=await f.enroll();
    const first=await f.call('/v1/jobs',scope(g),g.credential);assert.equal(first.status,202);
    const duplicate=await f.call('/v1/jobs',scope(g),g.credential);assert.equal(duplicate.body.id,first.body.id);
    assert.equal((await f.call('/v1/jobs',scope(g,'different-request-0001'),g.credential)).status,429);
    assert.equal((await f.call('/v1/jobs/'+first.body.id,undefined,'invalid')).status,410);
    await f.restart();f.result({status:503,reason:'secret error with token must not leak'});await f.app.queue.flush();
    let job=(await f.app.queue.get(first.body.id));assert.equal(job.state,'retrying');assert.equal(job.attempts,1);assert.equal(job.reason,'ProviderRejected');
    await f.app.queue.flush();assert.equal((await f.app.queue.get(job.id)).attempts,1);
    f.advance(70000);f.result({status:200});await f.app.queue.flush();
    assert.equal((await f.app.queue.get(job.id)).state,'accepted');
    assert.equal((await f.call('/v1/jobs',scope(g),g.credential)).body.id,job.id);
    await f.restart();assert.equal((await f.app.applications.describe('perch-mail')).counts.accepted,1);
    const logs=JSON.stringify((await f.call('/admin/logs')).body);assert.ok(!logs.includes(g.credential));assert.ok(!logs.includes('secret error'));
    assert.equal((await f.call('/admin/jobs?state=accepted&appId=perch-mail')).body.total,1);
  }finally{await f.close();}
});
test('deletion cancels work, removes keys and registrations, persists across restart and audits safely',async()=>{
  const f=await fixture();
  try {
    (await f.configure());const g=await f.enroll();const queued=await f.call('/v1/jobs',scope(g),g.credential);
    assert.equal((await f.call('/admin/apps/perch-mail',undefined,'invalid','DELETE')).status,401);
    assert.equal((await f.call('/admin/apps/perch-mail',undefined,admin,'DELETE')).status,200);
    assert.equal((await f.app.queue.get(queued.body.id)).state,'cancelled');
    assert.equal((await f.app.db.prepare('SELECT count(*) n FROM registrations').get()).n,0);
    assert.equal((await f.app.db.prepare('SELECT count(*) n FROM app_channels').get()).n,0);
    await f.restart();assert.equal((await f.app.applications.list()).length,0);
    const logs=(await f.call('/admin/logs?kind=audit')).body.items;assert.equal(logs[0].action,'application.delete');
  }finally{await f.close();}
});
test('Android enrollment preserves tokens; channel changes revoke grants and queue; other apps remain usable',async()=>{
  const f=await fixture();
  try {
    (await f.configure());const mail=await f.enroll();(await f.app.applications.create({id:'notes',name:'Notes'}));
    const configured=await f.call('/admin/apps/notes/channels/fcm',{serviceAccount:{type:'service_account',project_id:'notes-test',client_email:'worker@notes-test.iam.gserviceaccount.com',private_key:'fixture-FCM-secret'},enabled:true},admin,'PUT');
    assert.equal(configured.status,200);assert.ok(!JSON.stringify(configured.body).includes('fixture-FCM-secret'));
    const g=await f.enroll('notes','fcm');assert.equal(f.sent.at(-1).t,'AbC_MixedCaseToken:123456789');
    const queued=await f.call('/v1/jobs',scope(g),g.credential);
    assert.equal((await f.call('/v1/jobs/'+queued.body.id,undefined,mail.credential)).status,404);
    const disabled=await f.call('/admin/apps/notes/channels/fcm',{enabled:false},admin,'PUT');assert.equal(disabled.status,200);
    assert.equal((await f.app.queue.get(queued.body.id)).state,'cancelled');
    assert.equal((await f.call('/v1/validate',scope(g),g.credential)).status,410);
    assert.equal((await f.call('/v1/validate',scope(mail),mail.credential)).status,200);
  }finally{await f.close();}
});
test('unknown interrupted sends are not replayed; legacy failures have no gateway retry',async()=>{
  const f=await fixture();
  try {
    (await f.configure());const g=await f.enroll();f.result({status:503});
    const legacy=await f.call('/v1/notify',scope(g),g.credential);assert.equal(legacy.status,503);
    f.advance(120000);await f.app.queue.flush();assert.equal(f.sent.length,2);
    const queued=await f.call('/v1/jobs',scope(g),g.credential);
    (await f.app.db.prepare("UPDATE delivery_jobs SET state='sending' WHERE id=?").run(queued.body.id));
    await f.restart();assert.equal((await f.app.queue.get(queued.body.id)).state,'unknown');
    await f.app.queue.flush();assert.equal(f.sent.length,2);
  }finally{await f.close();}
});
test('monitoring persists external outages, protects report scope, validates inputs and paginates',async()=>{
  const f=await fixture();
  try {
    const key=readFileSync(f.app.monitorPath,'utf8').trim();
    assert.equal((await f.call('/admin/apps',undefined,key)).status,401);
    assert.equal((await f.call('/monitor/report',{monitor:'edge',samples:[]},admin)).status,401);
    const samples=[{time:f.now-60000,ok:false,latency:10000},{time:f.now,ok:true,latency:20}];
    assert.equal((await f.call('/monitor/report',{monitor:'edge',samples},key)).status,200);
    await f.call('/monitor/report',{monitor:'edge',samples},key);
    await f.restart();const health=(await f.call('/admin/monitor')).body;
    assert.equal(health.monitors[0].samples,2);assert.equal(health.monitors[0].successes,1);
    assert.equal((await f.call('/monitor/report',{monitor:'edge',samples:[{time:f.now+120000,ok:true,latency:1}]},key)).status,400);
    assert.equal((await f.call('/admin/logs?page=-1')).status,400);
    for(let i=0;i<35;i++)(await f.app.monitor.record({kind:'audit',action:'test'}));
    assert.equal((await f.call('/admin/logs?kind=audit')).body.items.length,30);
    assert.equal((await f.call('/admin/logs?kind=audit&page=2')).body.items.length,5);
  }finally{await f.close();}
});
test('revocation during an in-flight send cannot overwrite cancellation or affect a replacement grant',async()=>{
  const f=await fixture();
  let release;
  try {
    (await f.configure());const g=await f.enroll();const queued=await f.call('/v1/jobs',scope(g),g.credential);
    f.result(()=>new Promise(resolve=>{release=resolve;}));
    const flushing=f.app.queue.flush();
    while(!release) await new Promise(resolve=>setImmediate(resolve));
    assert.equal((await f.app.queue.get(queued.body.id)).state,'sending');
    assert.equal((await f.call('/admin/devices/'+g.registrationId,undefined,admin,'DELETE')).status,200);
    release({status:200});await flushing;
    assert.equal((await f.app.queue.get(queued.body.id)).state,'cancelled');
    assert.equal((await f.call('/v1/validate',scope(g),g.credential)).status,410);
    f.result({status:200});const replacement=await f.enroll();
    assert.equal((await f.call('/v1/validate',scope(replacement),replacement.credential)).status,200);
  }finally{if(release)release({status:200});await f.close();}
});
test('permanent device errors revoke only their registration; expired work is not sent',async()=>{
  const f=await fixture();
  try {
    (await f.configure());const g=await f.enroll();const queued=await f.call('/v1/jobs',scope(g),g.credential);
    f.result({status:410,reason:'Unregistered'});await f.app.queue.flush();
    assert.equal((await f.app.queue.get(queued.body.id)).state,'failed');
    assert.equal((await f.call('/v1/validate',scope(g),g.credential)).status,410);
    f.result({status:200});const next=await f.enroll();const expired=await f.call('/v1/jobs',scope(next),next.credential);
    const count=f.sent.length;f.advance(86400001);await f.app.queue.flush();
    assert.equal((await f.app.queue.get(expired.body.id)).state,'cancelled');assert.equal(f.sent.length,count);
  }finally{await f.close();}
});

test('concurrent PostgreSQL submissions deduplicate and competing configuration writes remain isolated',async()=>{
  const f=await fixture();
  try{
    await f.configure();const g=await f.enroll();
    const results=await Promise.all(Array.from({length:6},()=>f.call('/v1/jobs',scope(g),g.credential)));
    assert.ok(results.every(r=>r.status===202));assert.equal(new Set(results.map(r=>r.body.id)).size,1);
    assert.equal((await f.app.db.prepare('SELECT count(*) n FROM delivery_jobs').get()).n,1);
    await f.app.applications.create({id:'second',name:'Second'});
    await f.app.applications.create({id:'third',name:'Third'});
    const config={privateKey:'fixture',keyId:'ABCDEFGHIJ',teamId:'0123456789',topic:'com.example.shared',environment:'both'};
    const writes=await Promise.allSettled(['second','third'].map(id=>f.app.applications.configureChannel(id,'apns',config)));
    assert.equal(writes.filter(r=>r.status==='fulfilled').length,1);assert.equal(writes.find(r=>r.status==='rejected').reason.status,409);
  }finally{await f.close();}
});

test('five concurrent legacy sends reject excess work before enqueue and permit its later retry', async () => {
  const f = await fixture();
  let release;
  try {
    await f.configure();
    const grants = [];
    for (let i = 0; i < 5; i++) grants.push(await f.enroll('perch-mail', 'apns', 'phone' + i, (i + 10).toString(16).repeat(64)));
    f.result(() => new Promise(resolve => { (release ??= []).push(resolve); }));
    const requests = grants.map(g => f.call('/v1/notify', scope(g), g.credential));
    while (release?.length !== 4) await new Promise(resolve => setTimeout(resolve, 5));
    const rejected = await Promise.race(requests);
    assert.equal(rejected.status, 503);
    assert.equal((await f.app.db.prepare('SELECT count(*) n FROM delivery_jobs').get()).n, 4);
    assert.equal((await f.app.db.prepare("SELECT count(*) n FROM delivery_jobs WHERE state='queued'").get()).n, 0);
    for (const done of release) done({status:200});
    const results = await Promise.all(requests);
    assert.equal(results.filter(r => r.status === 200).length, 4);
    const retry = grants[results.findIndex(r => r.status === 503)];
    f.result({status:200});
    assert.equal((await f.call('/v1/notify', scope(retry), retry.credential)).status, 200);
    assert.equal(f.app.queue.slots.size, 0);
  } finally { for (const done of release || []) done({status:200}); await f.close(); }
});

test('failed legacy admission releases its reservation and shutdown waits for admission', async () => {
  const f = await fixture();
  try {
    await assert.rejects(f.app.queue.legacy({id:'missing'}), error => error.status === 410);
    assert.equal(f.app.queue.slots.size, 0);
    const slot = f.app.queue.reserve();
    let closed = false;
    const closing = f.app.queue.close().then(() => { closed = true; });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(closed, false);
    assert.throws(() => f.app.queue.reserve(), error => error.status === 503);
    slot.release(); await closing;
  } finally { await f.close(); }
});
