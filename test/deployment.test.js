import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync,writeFileSync,existsSync,unlinkSync} from 'node:fs';
import {randomBytes} from 'node:crypto';
import {createGateway} from './helpers.mjs';
import {clientAddressResolver,normalizeIP} from '../client-address.js';

const req = (remoteAddress, header) => ({socket:{remoteAddress},headers:{'x-forwarded-for':header}});
test('forwarded IPs require explicit trusted peers, stop at the first untrusted hop, and normalize IPs', () => {
  const strict = clientAddressResolver();
  assert.equal(strict(req('127.0.0.1','203.0.113.9')), '127.0.0.1');
  const trusted = clientAddressResolver('127.0.0.1,10.10.0.0/24,2001:db8:1::/64');
  assert.equal(trusted(req('::ffff:127.0.0.1','203.0.113.9, 10.10.0.7')), '203.0.113.9');
  assert.equal(trusted(req('127.0.0.1','1.1.1.1, 203.0.113.9')), '203.0.113.9');
  assert.equal(trusted(req('192.0.2.3','1.1.1.1')), '192.0.2.3');
  assert.equal(trusted(req('2001:db8:1::2','2001:0db8:0:0::7')), '2001:db8::7');
  assert.equal(normalizeIP('::ffff:c000:0203'), '192.0.2.3');
  assert.throws(() => trusted(req('127.0.0.1','unknown')), e => e.status === 400);
  assert.throws(() => clientAddressResolver('0.0.0.0/0'));
  assert.throws(() => clientAddressResolver('localhost'));
});

const adminToken='deployment-test-only-'.repeat(3);
test('proxy clients have independent login limits and untrusted headers cannot select a rate-limit bucket', async () => {
  const dataDir=mkdtempSync('/tmp/relay-proxy-test-'); let app;
  try {
    app=await createGateway({dataDir,adminToken,autoStart:false,trustedProxies:'127.0.0.1'});
    await new Promise(r=>app.server.listen(0,'127.0.0.1',r));
    await app.db.prepare('INSERT INTO limits VALUES(?,?,?)').run('login:203.0.113.1',Date.now(),20);
    const call=ip=>fetch('http://127.0.0.1:'+app.server.address().port+'/auth/login',{method:'POST',headers:{'Content-Type':'application/json','X-Forwarded-For':ip},body:JSON.stringify({token:'wrong'})});
    assert.equal((await call('203.0.113.1')).status,429);
    assert.equal((await call('203.0.113.2')).status,401);
    await app.close();
    app=await createGateway({dataDir,adminToken,autoStart:false,trustedProxies:''});
    await new Promise(r=>app.server.listen(0,'127.0.0.1',r));
    assert.equal((await call('203.0.113.1')).status,401);
    assert.equal((await app.db.prepare('SELECT count FROM limits WHERE key=?').get('login:127.0.0.1')).count,1);
  } finally {await app?.close();rmSync(dataDir,{recursive:true,force:true});}
});

test('missing and mismatched master keys fail startup without replacing data or leaking an ownership lock', async () => {
  const dataDir=mkdtempSync('/tmp/relay-key-test-');let app;
  const options={dataDir,adminToken,autoStart:false,providerFactory:()=>({send(){},close(){}})};
  try {
    app=await createGateway(options);
    await app.applications.update('perch-mail',{name:'Mail',enabled:true,apns:{privateKey:'fixture',keyId:'ABCDEFGHIJ',teamId:'0123456789',topic:'com.example.keys',environment:'both'}});
    const key=readFileSync(dataDir+'/master.key');
    await app.close();
    unlinkSync(dataDir+'/master.key');
    await assert.rejects(createGateway(options),/Master key missing/);
    assert.equal(existsSync(dataDir+'/master.key'),false);
    writeFileSync(dataDir+'/master.key',randomBytes(32));
    await assert.rejects(createGateway(options),/does not match/);
    writeFileSync(dataDir+'/master.key',key);
    app=await createGateway(options);
    assert.equal((await app.applications.describe('perch-mail')).apns.hasKey,true);
    // A legacy install has no sentinel; authenticate its ciphertexts before migration.
    await app.db.exec('DELETE FROM gateway_key_check');
    await app.close();
    writeFileSync(dataDir+'/master.key',randomBytes(32));
    await assert.rejects(createGateway(options),/does not match/);
    writeFileSync(dataDir+'/master.key',key);
    app=await createGateway(options);
    assert.ok(await app.db.prepare('SELECT 1 FROM gateway_key_check').get());
  }finally{await app?.close();rmSync(dataDir,{recursive:true,force:true});}
});

test('ownership connection termination closes the listener, providers and pool, allowing a clean restart', {timeout:10000}, async () => {
  const dataDir=mkdtempSync('/tmp/relay-fault-test-');let app, notified, providerClosed=0;
  const fatal=new Promise(resolve=>notified=resolve);
  const options={dataDir,adminToken,autoStart:true,onFatal:notified,providerFactory:()=>({send(){},close(){providerClosed++;}})};
  try {
    app=await createGateway(options);
    await new Promise(r=>app.server.listen(0,'127.0.0.1',r));
    await app.applications.update('perch-mail',{name:'Mail',enabled:true,apns:{privateKey:'fixture',keyId:'ABCDEFGHIJ',teamId:'0123456789',topic:'com.example.fault',environment:'both'}});
    await app.applications.resolve('perch-mail','apns','sandbox');
    const before=providerClosed;
    const lock=await app.db.prepare("SELECT pid FROM pg_locks WHERE locktype='advisory' AND classid=(hashtext(?)::bigint & 4294967295)::oid AND objid=72841102 AND database=(SELECT oid FROM pg_database WHERE datname=current_database())").get(app.db.schema);
    assert.ok(lock);
    await app.db.prepare('SELECT pg_terminate_backend(?)').get(lock.pid);
    await fatal;
    await app.close();
    assert.equal(app.server.listening,false);
    assert.equal(app.queue.stopping,true);
    assert.ok(providerClosed>before);
    assert.equal(app.db.pool.ended,true);
    app=await createGateway({...options,autoStart:false});
    assert.ok(await app.db.prepare('SELECT 1').get());
  } finally {await app?.close();rmSync(dataDir,{recursive:true,force:true});}
});

test('the executable exits nonzero on ownership loss instead of remaining an unhealthy process', {timeout:15000}, async () => {
  const {spawn} = await import('node:child_process');
  const {once} = await import('node:events');
  const {Database} = await import('../database.js');
  const dataDir=mkdtempSync('/tmp/relay-exit-test-');let child, control;
  try {
    const seed=await createGateway({dataDir,adminToken,autoStart:false});
    const schema=seed.db.schema;await seed.close();
    control=new Database(process.env.GATEWAY_DATABASE_URL,schema);
    child=spawn(process.execPath,[new URL('../server.js',import.meta.url).pathname],{
      env:{...process.env,GATEWAY_DATA_DIR:dataDir,GATEWAY_DATABASE_SCHEMA:schema,GATEWAY_ADMIN_TOKEN:adminToken,GATEWAY_HOST:'127.0.0.1',GATEWAY_PORT:'0',GATEWAY_TRUSTED_PROXIES:''},
      stdio:['ignore','pipe','pipe'],
    });
    const exited=once(child,'exit');
    await Promise.race([
      new Promise(resolve=>child.stdout.on('data',chunk=>{if(chunk.toString().includes('gateway ready'))resolve();})),
      exited.then(()=>{throw Error('Child exited before listening');}),
    ]);
    const row=await control.prepare("SELECT pid FROM pg_locks WHERE locktype='advisory' AND classid=(hashtext(?)::bigint & 4294967295)::oid AND objid=72841102 AND database=(SELECT oid FROM pg_database WHERE datname=current_database())").get(schema);
    assert.ok(row);
    await control.prepare('SELECT pg_terminate_backend(?)').get(row.pid);
    const [code,signal]=await exited;
    assert.equal(code,1);assert.equal(signal,null);
  }finally{
    if(child && child.exitCode===null){const done=once(child,'exit');child.kill('SIGKILL');await done;}
    await control?.close();rmSync(dataDir,{recursive:true,force:true});
  }
});
