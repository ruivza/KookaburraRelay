import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createGateway} from './helpers.mjs';
import {accessDefaults} from '../access.js';
async function fixture() {
  const dataDir=mkdtempSync(join(tmpdir(),'relay-access-'));let now=Date.now(),app;const sent=[];
  const options={dataDir,adminToken:'test-admin-'.repeat(5),autoStart:false,now:()=>now,
    appleVerifier:({proof,key})=>{if(proof.attestation!=='test-proof'&&!key)throw Object.assign(Error('bad proof'),{status:403});return {publicKey:'test-only-public-key',counter:key?Number(proof.counter):0};},
    providerFactory:()=>({send:async(device,token,payload)=>{sent.push(payload);return {status:200};},close(){}})};
  async function start(){app=await createGateway(options);await new Promise(r=>app.server.listen(0,'127.0.0.1',r));}
  await start();await app.applications.update('perch-mail',{name:'Mail',enabled:true,apns:{privateKey:'fixture',keyId:'ABCDEFGHIJ',teamId:'0123456789',topic:'com.example.mail',environment:'both'}});
  return {get app(){return app;},advance(ms){now+=ms;},sent,
    input(n=1){return {appId:'perch-mail',deviceId:'phone-'+n,serverId:'server',deviceToken:n.toString(16).padStart(64,'a'),environment:'sandbox',nonce:'n'.repeat(40)};},
    async policy(p){return app.access.savePolicy('perch-mail',{settings:{...accessDefaults,...p}});},
    async call(path,body,credential='',identity=''){const r=await fetch('http://127.0.0.1:'+app.server.address().port+path,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+credential,'Content-Type':'application/json','X-Relay-Server-Credential':identity},body:body?JSON.stringify(body):undefined});return {status:r.status,body:await r.json()};},
    async enroll(body){const r=await this.call('/v1/registrations',body);assert.equal(r.status,202,JSON.stringify(r.body));const proof=sent.find(p=>p.perchRegistration?.id===r.body.registrationId).perchRegistration;return (await this.call('/v1/registrations/'+proof.id+'/confirm',proof)).body;},
    async restart(){await app.close();await start();},async close(){await app.close();rmSync(dataDir,{recursive:true,force:true});}};
}
test('trusted server tickets are scoped, one-use and revocable; delivery needs both credentials',async()=>{
 const f=await fixture();try{
  await f.policy({requireTrustedServers:true});
  assert.equal((await f.call('/v1/registrations',f.input())).status,403);
  await f.app.access.createServer({id:'server',name:'Business',apps:['perch-mail']});
  const {credential}=await f.app.access.updateServer('server',{action:'approve'});
  const input=f.input(),ticket=await f.app.access.ticket(credential,{appId:input.appId,deviceId:input.deviceId,serverId:input.serverId});input.serverTicket=ticket.ticket;
  assert.equal((await f.call('/v1/registrations',{...input,deviceId:'other'})).status,403);
  const g=await f.enroll(input);
  assert.equal((await f.call('/v1/registrations',input)).status,403);
  const scope={appId:input.appId,deviceId:input.deviceId,serverId:input.serverId,kind:'sync',requestId:'request-0000000001'};
  assert.equal((await f.call('/v1/validate',scope,g.credential)).status,403);
  assert.equal((await f.call('/v1/validate',scope,g.credential,credential)).status,200);
  const job=await f.call('/v1/jobs',scope,g.credential,credential);assert.equal(job.status,202);
  const rotated=await f.app.access.updateServer('server',{action:'rotate'});assert.notEqual(rotated.credential,credential);
  await assert.rejects(f.app.access.ticket(credential,{appId:input.appId,deviceId:input.deviceId,serverId:input.serverId}),e=>e.status===403);
  assert.equal((await f.app.queue.get(job.body.id)).state,'cancelled');await f.app.queue.flush();assert.equal(f.sent.length,1);
  await f.app.access.updateServer('server',{action:'block'});
  await f.policy({requireTrustedServers:false});assert.equal((await f.call('/v1/registrations',f.input(2))).status,403);
  assert.ok(!(JSON.stringify(await f.app.access.servers())).includes(credential));
 }finally{await f.close();}
});
test('proof challenge binds the full request, expires, cannot replay and uses monotonic key counters',async()=>{
 const f=await fixture();try{
  await f.policy({iosRequired:true,teamId:'0123456789',bundleId:'com.example.mail'});
  const input=f.input();assert.equal((await f.call('/v1/registrations',input)).status,403);
  const c=await f.app.access.challenge({registration:input},'one');
  const body={...input,integrity:{challengeId:c.id,keyId:'test-key',attestation:'test-proof'}};
  assert.equal((await f.call('/v1/registrations',{...body,nonce:'z'.repeat(40)})).status,403);
  await f.enroll(body);assert.equal((await f.call('/v1/registrations',body)).status,403);
  const next=f.input(2),c2=await f.app.access.challenge({registration:next,keyId:'test-key'},'two');assert.equal(c2.keyKnown,true);
  await f.enroll({...next,integrity:{challengeId:c2.id,keyId:'test-key',counter:1}});
  const third=f.input(3),c3=await f.app.access.challenge({registration:third,keyId:'test-key'},'three');
  assert.equal((await f.call('/v1/registrations',{...third,integrity:{challengeId:c3.id,keyId:'test-key',counter:1}})).status,403);
  const c4=await f.app.access.challenge({registration:third,keyId:'test-key'},'four');f.advance(300001);
  assert.equal((await f.call('/v1/registrations',{...third,integrity:{challengeId:c4.id,keyId:'test-key',counter:2}})).status,403);
  assert.equal(f.sent.length,2);
  await f.restart();assert.equal((await f.app.db.prepare('SELECT counter FROM integrity_keys').get()).counter,1);
  await f.policy({iosRequired:false});assert.equal((await f.app.db.prepare('SELECT count(*) n FROM registrations').get()).n,0);
 }finally{await f.close();}
});
test('concurrent assertions admit at most one transition from the same key counter',async()=>{
 const f=await fixture();try{
  await f.policy({iosRequired:true,teamId:'0123456789',bundleId:'com.example.mail'});
  const first=f.input(),c=await f.app.access.challenge({registration:first},'one');
  await f.app.access.prepareRegistration({...first,integrity:{challengeId:c.id,keyId:'test-key',attestation:'test-proof'}},'one');
  let ready=0,release;const wait=new Promise(r=>{release=r;});
  f.app.access.appleVerifier=async({key})=>{if(++ready===2)release();await wait;return {publicKey:key.public_key,counter:1};};
  const bodies=await Promise.all([2,3].map(async n=>{const b=f.input(n),c=await f.app.access.challenge({registration:b,keyId:'test-key'},String(n));return {...b,integrity:{challengeId:c.id,keyId:'test-key',counter:1}};}));
  const results=await Promise.allSettled(bodies.map((b,n)=>f.app.access.prepareRegistration(b,String(n))));
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
 }finally{await f.close();}
});
test('per-app overrides persist, inherit on reset and cannot override the global pause',async()=>{
 const f=await fixture();try{
  await f.app.abuse.saveApp('perch-mail',{taskAppDay:1,registrationEnabled:true});
  await f.restart();assert.equal((await f.app.abuse.effective('perch-mail')).taskAppDay,1);
  await f.app.abuse.save({...f.app.abuse.settings,registrationEnabled:false});
  assert.equal((await f.call('/v1/registrations',f.input())).status,503);
  await assert.rejects(f.app.abuse.saveApp('perch-mail',{taskGlobalDay:100000}),e=>e.status===400);
  await f.app.abuse.saveApp('perch-mail',{});assert.equal((await f.app.abuse.effective('perch-mail')).taskAppDay,f.app.abuse.settings.taskAppDay);
  assert.equal((await f.call('/admin/servers')).status,401);assert.equal((await f.call('/admin/alerts')).status,401);
 }finally{await f.close();}
});

test('application task budgets are independent while the global ceiling remains shared',async()=>{
 const f=await fixture();try{
  await f.app.applications.create({id:'second',name:'Second'});
  await f.app.abuse.save({...f.app.abuse.settings,taskGlobalDay:3});
  await f.app.abuse.saveApp('perch-mail',{taskAppDay:1});
  const task=(app_id,token_hash)=>f.app.db.transaction(()=>f.app.abuse.task({app_id,token_hash}));
  await task('perch-mail','first');
  await assert.rejects(task('perch-mail','another'),e=>e.reason==='task_app_day');
  await task('second','second');await task('second','third');
  await assert.rejects(task('second','fourth'),e=>e.reason==='task_global_day');
  await f.app.abuse.saveApp('second',{registrationEnabled:false});
  await assert.rejects(f.app.abuse.registration('second'),e=>e.reason==='registration_paused');
 }finally{await f.close();}
});

for(const change of ['policy','server'])test(change+' changes erase notification content when cancelling work',async()=>{
  const f=await fixture();try{
   await f.app.applications.update('perch-mail',{name:'Mail',enabled:true,notifications:{kinds:['sync','alert']}});
   if(change==='server'){
    await f.app.access.createServer({id:'server',name:'Business',apps:['perch-mail']});
    await f.app.access.updateServer('server',{action:'approve'});
   }
   const grant=await f.enroll({...f.input(),kinds:['sync','alert']});
   const entry=await f.app.db.prepare('SELECT * FROM registrations WHERE id=?').get(grant.registrationId);
   const job=await f.app.queue.enqueue(entry,{requestId:'privacy-request-0001',kind:'alert',alert:{title:'Private title',body:'Private body'}});
   assert.ok(job.notification);
   if(change==='policy')await f.policy({});
   else await f.app.access.updateServer('server',{action:'block'});
   const cancelled=await f.app.queue.get(job.id);
   assert.equal(cancelled.state,'cancelled');assert.equal(cancelled.notification,null);
   await f.app.queue.flush();assert.equal(f.sent.length,1);
  }finally{await f.close();}
});

test('startup erases interrupted request content and repairs older terminal job content',async()=>{
 const f=await fixture();try{
  await f.app.applications.update('perch-mail',{name:'Mail',enabled:true,notifications:{kinds:['sync','alert']}});
  const ids=[];
  for(const [n,state,mode]of [[1,'sending','async'],[2,'queued','legacy'],[3,'cancelled','async'],[4,'unknown','async'],[5,'accepted','async'],[6,'failed','async']]){
   const grant=await f.enroll({...f.input(n),kinds:['sync','alert']});
   const entry=await f.app.db.prepare('SELECT * FROM registrations WHERE id=?').get(grant.registrationId);
   const job=await f.app.queue.enqueue(entry,{requestId:'privacy-request-000'+n,kind:'alert',alert:{title:'Private title',body:'Private body'}});
   assert.ok(job.notification);
   await f.app.db.prepare('UPDATE delivery_jobs SET state=?,mode=? WHERE id=?').run(state,mode,job.id);ids.push([job.id,['sending','queued'].includes(state)?'unknown':state]);
  }
  await f.restart();
  for(const [id,state]of ids){const job=await f.app.queue.get(id);assert.equal(job.state,state);assert.equal(job.notification,null);}
  await f.app.queue.flush();assert.equal(f.sent.length,6);
 }finally{await f.close();}
});
