import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createGateway} from './helpers.mjs';
test('cleanup previews, protects pending work, consumes confirmation and persists policy',async()=>{
 const dataDir=mkdtempSync(join(tmpdir(),'relay-cleanup-'));let now=Date.now();
 const opts={dataDir,adminToken:'test-admin-'.repeat(5),autoStart:false,now:()=>now};let app=await createGateway(opts);
 try{
  const {db,maintenance:m}=app,old=now-100*86400000;
  for(const kind of ['request','error','audit'])await db.prepare('INSERT INTO gateway_logs(time,kind,action,status,duration,request_id) VALUES(?,?,?,200,0,?)').run(old,kind,'fixture',kind);
  for(const state of ['accepted','queued','retrying','sending'])await db.prepare('INSERT INTO delivery_jobs(id,registration_id,app_id,channel,device_id,mode,state,created,updated,next_at,expires) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(state,'reg','perch-mail','apns','device','sync',state,old,old,now,now+10000);
  await db.prepare('INSERT INTO admin_sessions VALUES(?,?)').run('expired',old);await db.prepare('INSERT INTO admin_sessions VALUES(?,?)').run('valid',now+100000);
  const p=await m.preview({types:['requests','errors','audit','jobs','expired']});assert.equal(p.counts.jobs,1);assert.equal((await db.prepare('SELECT count(*) n FROM delivery_jobs').get()).n,4);
  await m.manual(p.previewId);await m.work;
  assert.equal((await db.prepare('SELECT count(*) n FROM delivery_jobs').get()).n,3);assert.ok(await db.prepare('SELECT * FROM admin_sessions WHERE hash=?').get('valid'));assert.equal((await m.state()).runs[0].status,'completed');
  await assert.rejects(m.manual(p.previewId),/preview expired/);
  await assert.rejects(m.preview({types:['jobs'],before:now+1}),/cutoff/);
  await assert.rejects(m.preview({types:[]}),/selection/);
  let settings={...(await m.state()).settings,enabled:false,requestsDays:7};let preview=await m.preview({mode:'settings',settings});await m.save(preview.previewId);
  await app.close();app=await createGateway(opts);assert.equal((await app.maintenance.state()).settings.requestsDays,7);assert.equal((await app.maintenance.state()).nextAt,null);
  now+=200*86400000;await app.maintenance.tick();assert.equal(app.maintenance.busy,false);
  const expired=await app.maintenance.preview({types:['requests']});now+=300001;await assert.rejects(app.maintenance.manual(expired.previewId),/preview expired/);
  const enable=await app.maintenance.preview({mode:'settings',settings:{...settings,enabled:true,intervalHours:1}});await app.maintenance.save(enable.previewId);now+=3600001;await app.maintenance.tick();await app.maintenance.work;assert.equal((await app.maintenance.state()).runs[0].source,'automatic');
 }finally{await app.close();rmSync(dataDir,{recursive:true,force:true});}
});
