import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGateway } from './helpers.mjs';

test('mail alerts require an explicit scoped grant and survive the delivery queue', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mail-alert-')), sent = [];
  const admin = 'alert-test-operator'.repeat(3); let now = Date.now();
  const app = await createGateway({ dataDir: dir, adminToken: admin, now: () => now,
    providerFactory: () => ({ async send(device, token, payload) { sent.push(payload); return { status: 200 }; }, close() {} }) });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const call = async (path, body, token = '', method = 'POST') => {
    const r = await fetch(base + path, { method, headers: { 'Content-Type':'application/json', Authorization:'Bearer '+token }, body: JSON.stringify(body) });
    return { status:r.status, body:await r.json() };
  };
  try {
    const session = (await call('/auth/login', {token:admin})).body.session;
    assert.equal((await call('/admin/apps', {id:'notes-app',name:'Notes',notifications:{kinds:['sync','alert','encrypted_alert'],fallback:{title:'Notes',body:'Open Notes to view the update.'}}}, session)).status, 201);
    assert.equal((await call('/admin/apps/notes-app', {name:'Notes',enabled:true,apns:{keyId:'ABCDEFGHIJ',teamId:'0123456789',topic:'com.example.mohua',environment:'both',privateKey:'fixture-key'}}, session, 'PUT')).status, 200);
    const enroll = async purpose => {
      const result = await call('/v1/registrations', {appId:'notes-app',deviceId:'phone',serverId:'server',deviceToken:'ab'.repeat(32),environment:'sandbox',nonce:'n'.repeat(40),purpose});
      assert.equal(result.status,202); const proof = sent.at(-1).perchRegistration;
      return (await call(`/v1/registrations/${proof.id}/confirm`, proof)).body;
    };
    const scope = {appId:'notes-app',deviceId:'phone',serverId:'server',kind:'encrypted_alert'};
    const sync = await enroll('sync');
    assert.equal((await call('/v1/notify',scope,sync.credential)).status,403);
    const mail = await enroll('encrypted_alert'); assert.equal(mail.purpose,'encrypted_alert');
    assert.equal((await call('/v1/validate',scope,mail.credential)).status,200);
    assert.equal((await call('/v1/notify',{...scope,deviceId:'other'},mail.credential)).status,403);
    assert.equal((await call('/v1/notify',{...scope,subject:'never forward'},mail.credential)).status,200);
    assert.deepEqual(sent.at(-1), {aps:{alert:{title:'Notes',body:'Open Notes to view the update.'},sound:'default','content-available':1,'mutable-content':1},relay:{version:1,deviceId:'phone',appId:'notes-app',serverId:'server',kind:'encrypted_alert'}});
    assert.equal((await app.db.prepare("SELECT kind FROM delivery_jobs WHERE state='accepted'").get()).kind,'encrypted_alert');
    now += 61000;
    const encrypted = {version:1,keyId:'a'.repeat(64),id:'11111111-1111-4111-8111-111111111111',expires:now+60000,
      ephemeralKey:Buffer.concat([Buffer.from([4]),Buffer.alloc(64,1)]).toString('base64'),ciphertext:Buffer.alloc(128,2).toString('base64')};
    assert.equal((await call('/v1/notify',{...scope,encryptedNotification:{sender:'Plaintext'}},mail.credential)).status,400);
    const result = await call('/v1/jobs',{...scope,encryptedNotification:encrypted,requestId:'encrypted-request-0001'},mail.credential);
    assert.equal(result.status,202);
    assert.equal(result.body.notification,undefined);
    assert.equal(result.body.notification_hash,undefined);
    await app.queue.flush();
    assert.deepEqual(sent.at(-1).encryptedNotification,encrypted);
    assert.equal(sent.at(-1).aps['mutable-content'],1);
    assert.equal((await app.db.prepare('SELECT notification FROM delivery_jobs WHERE id=?').get(result.body.id)).notification,null);
    assert.equal((await call('/v1/jobs',{...scope,encryptedNotification:{...encrypted,ciphertext:Buffer.alloc(128,3).toString('base64')},requestId:'encrypted-request-0001'},mail.credential)).status,409);
    now += 61000;
    assert.equal((await call('/v1/notify',{...scope,kind:'sync'},mail.credential)).status,200);
    assert.equal(sent.at(-1).aps.alert,undefined);
    now += 61000;
    const enrollment = await call('/v1/registrations',{appId:'notes-app',deviceId:'plain-phone',serverId:'server',deviceToken:'cd'.repeat(32),environment:'sandbox',nonce:'q'.repeat(40),kinds:['sync','alert','encrypted_alert']});
    assert.equal(enrollment.status,202);
    const proof=sent.at(-1).perchRegistration;
    const plain=(await call(`/v1/registrations/${proof.id}/confirm`,proof)).body;
    assert.deepEqual(plain.kinds,['sync','alert','encrypted_alert']);
    const alertScope={appId:'notes-app',deviceId:'plain-phone',serverId:'server',kind:'alert'};
    assert.equal((await call('/v1/notify',{...scope,kind:'alert',alert:{title:'No',body:'Permission'}},mail.credential)).status,403);
    const task=await call('/v1/jobs',{...alertScope,requestId:'plain-alert-test-0001',alert:{title:'Note updated',body:'A collaborator edited your note.',sound:false}},plain.credential);
    assert.equal(task.status,202);
    const stored=await app.db.prepare('SELECT notification,notification_sealed FROM delivery_jobs WHERE id=?').get(task.body.id);
    assert.equal(stored.notification_sealed,1);assert(!stored.notification.includes('collaborator'));
    await app.queue.flush();
    assert.deepEqual(sent.at(-1).aps.alert,{title:'Note updated',body:'A collaborator edited your note.'});
    assert.equal(sent.at(-1).aps.sound,undefined); assert.equal(sent.at(-1).aps['mutable-content'],undefined);
    assert.equal(sent.at(-1).relay.appId,'notes-app');
    assert.equal((await call('/v1/notify',{...alertScope,appId:'other'},plain.credential)).status,403);
    assert.equal((await call('/v1/registrations',{appId:'notes-app',platform:'android',channel:'fcm',purpose:'encrypted_alert'},'')).status,501);
    const pendingEnrollment=await call('/v1/registrations',{appId:'notes-app',deviceId:'pending-phone',serverId:'server',deviceToken:'ef'.repeat(32),environment:'sandbox',nonce:'p'.repeat(40),purpose:'alert'});
    assert.equal(pendingEnrollment.status,202);
    const pendingProof=sent.at(-1).perchRegistration;
    const revision=(await app.applications.row('notes-app')).revision;
    assert.equal((await call('/admin/apps/notes-app',{name:'Notes',enabled:true,notifications:{fallback:{title:'Updated',body:'Open the app',sound:false}}},session,'PUT')).status,200);
    assert.equal((await app.applications.row('notes-app')).revision,revision);
    assert.equal((await app.applications.notifications('notes-app')).fallback.sound,true);
    now += 61000;
    const pendingSync=await call('/v1/jobs',{...scope,kind:'sync',requestId:'preserved-sync-task-0001'},mail.credential);
    assert.equal(pendingSync.status,202);
    const pendingAlert=await call('/v1/jobs',{...alertScope,requestId:'disabled-alert-task-0001',alert:{title:'Pending',body:'Do not deliver'}},plain.credential);
    assert.equal(pendingAlert.status,202);
    assert.equal((await call('/admin/apps/notes-app',{name:'Notes',enabled:true,notifications:{kinds:['sync']}},session,'PUT')).status,200);
    assert.equal((await call(`/v1/registrations/${pendingProof.id}/confirm`,pendingProof)).status,403);
    const cancelled=await app.queue.get(pendingAlert.body.id);
    assert.equal(cancelled.state,'cancelled');
    assert.equal(cancelled.reason,'CapabilityDisabled');
    assert.equal(cancelled.notification,null);
    assert.equal((await app.queue.get(pendingSync.body.id)).state,'queued');
    await app.queue.flush();
    assert.equal((await app.queue.get(pendingSync.body.id)).state,'accepted');

    assert.equal((await call('/v1/validate',alertScope,plain.credential)).status,403);
    assert.equal((await call('/v1/validate',{...alertScope,kind:'sync'},plain.credential)).status,200);
    assert.equal((await app.applications.row('notes-app')).revision,revision);
    assert.equal((await call('/admin/apps/notes-app',{name:'Notes',enabled:true,notifications:{kinds:['sync','alert','encrypted_alert']}},session,'PUT')).status,200);
    assert.equal((await call('/v1/validate',alertScope,plain.credential)).status,200);
    assert.equal((await call('/v1/validate',{...scope,kind:'alert'},mail.credential)).status,403);
    await call('/admin/apps/notes-app',{name:'Notes',enabled:true,notifications:{kinds:['sync']}},session,'PUT');
    const state=await (await fetch(base+'/v1/status?appId=notes-app')).json();
    assert.deepEqual(state.kinds,['sync']);assert.equal(state.notificationEncryption,null);

  } finally { await app.close(); rmSync(dir,{recursive:true,force:true}); }
});
