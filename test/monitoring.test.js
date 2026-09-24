import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {createGateway} from './helpers.mjs';
test('business monitoring separates outcomes, old queued work, scheduled retries and backup freshness',async()=>{
 const dataDir=mkdtempSync('/tmp/relay-monitor-');let app;let time=Date.now();
 try{
  app=await createGateway({dataDir,adminToken:'monitor-test-'.repeat(5),now:()=>time,autoStart:false});
  const job=async(id,state,created,updated,next)=>app.db.prepare("INSERT INTO delivery_jobs(id,registration_id,app_id,channel,device_id,mode,state,created,updated,next_at,expires) VALUES(?,?,?,?,?,?,?,?,?,?,?)").run(id,'r','perch-mail','apns','d','async',state,created,updated,next,time+86400000);
  await job('old','queued',time-2*86400000,time,time-360000);
  await job('retry','retrying',time-600000,time,time+3600000);
  await job('stuck','sending',time-600000,time-130000,time);
  await job('accepted','accepted',time-2*86400000,time,time);
  await job('unknown','unknown',time,time,time);
  const v=await app.monitor.business();
  assert.equal(v.queueStatus.queued,1);assert.equal(v.queueStatus.retrying,1);assert.equal(v.queueStatus.sending,1);
  assert.equal(v.queueStatus.overdue,1);assert.equal(v.queueStatus.stuck,1);
  assert.equal(v.queueStatus.oldestWaitSeconds,172800);
  assert.equal(v.results.find(r=>r.state==='accepted').count,1);
  assert.equal(v.backupSummary.local.status,'unverified');assert.equal(v.backupSummary.remote.status,'disabled');
  await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
  const metrics=await fetch('http://127.0.0.1:'+app.server.address().port+'/metrics',{headers:{Authorization:'Bearer '+readFileSync(app.monitorPath,'utf8').trim()}});
  assert.equal(metrics.status,200);const text=await metrics.text();
  assert.match(text,/perch_gateway_queue_overdue 1/);assert.match(text,/perch_gateway_sending_stuck 1/);
  assert.match(text,/perch_gateway_backup_attention\{target="remote"\} 0/);
  const row=await app.backups.row();
  await app.db.prepare("INSERT INTO backup_jobs(id,kind,source,state,created,finished,next_at,config_revision,local_status,local_completed,remote_status) VALUES(?,?,?,?,?,?,?,?,?,?,?)").run('backup','backup','scheduled','completed',time,time,time,row.settings.revision,'completed',time,'disabled');
  assert.equal((await app.backups.summary()).local.status,'ok');
  time+=26*3600000;assert.equal((await app.backups.summary()).local.status,'overdue');
  await app.monitor.sample();const sample=(await app.monitor.business()).queueSamples.at(-1);
  assert.equal(sample.queued+sample.retrying+sample.sending,3);
 }finally{await app?.close();rmSync(dataDir,{recursive:true,force:true});}
});
test('requests completing during collection survive to the next sample',async()=>{
 const dataDir=mkdtempSync('/tmp/relay-sampling-');let app;
 try{
  app=await createGateway({dataDir,adminToken:'monitor-test-'.repeat(5),autoStart:false});
  app.monitor.request(200,10);
  const original=app.db.prepare.bind(app.db);let injected=false;
  app.db.prepare=sql=>{const statement=original(sql);if(sql.startsWith('INSERT INTO gateway_samples')){const run=statement.run;statement.run=async(...args)=>{if(!injected){injected=true;app.monitor.request(500,30);}return run(...args);};}return statement;};
  await app.monitor.sample();assert.equal(app.monitor.requests,1);assert.equal(app.monitor.errors,1);assert.equal(app.monitor.elapsed,30);
 }finally{await app?.close();rmSync(dataDir,{recursive:true,force:true});}
});
