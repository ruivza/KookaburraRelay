import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync,writeFileSync,existsSync,unlinkSync,cpSync,symlinkSync,realpathSync} from 'node:fs';
import {randomBytes} from 'node:crypto';
import {createGateway} from './helpers.mjs';
import {clientAddressResolver,normalizeIP} from '../src/client-address.js';

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
  const {Database} = await import('../src/database.js');
  const dataDir=mkdtempSync('/tmp/relay-exit-test-');let child, control;
  try {
    const seed=await createGateway({dataDir,adminToken,autoStart:false});
    const schema=seed.db.schema;await seed.close();
    control=new Database(process.env.GATEWAY_DATABASE_URL,schema);
    child=spawn(process.execPath,[new URL('../src/server.js',import.meta.url).pathname],{
      cwd:dataDir,
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

test('an installation serves unchanged public URLs and keeps default data at its root from another working directory', {timeout:15000}, async () => {
  const {execFile,spawn} = await import('node:child_process');
  const {promisify} = await import('node:util');
  const {fileURLToPath} = await import('node:url');
  const {once} = await import('node:events');
  const installation=realpathSync(mkdtempSync('/tmp/relay-layout-test-'));
  const outside=realpathSync(mkdtempSync('/tmp/relay-layout-cwd-'));
  let seed,child;
  try {
    cpSync(new URL('../src/',import.meta.url),installation+'/src',{recursive:true});
    cpSync(new URL('../public/',import.meta.url),installation+'/public',{recursive:true});
    cpSync(new URL('../package.json',import.meta.url),installation+'/package.json');
    symlinkSync(fileURLToPath(new URL('../node_modules/',import.meta.url)),installation+'/node_modules','dir');
    seed=await createGateway({dataDir:installation+'/data',adminToken,autoStart:false});
    const schema=seed.db.schema;await seed.close();
    const env={...process.env,GATEWAY_DATABASE_SCHEMA:schema};
    delete env.GATEWAY_DATA_DIR;
    const script=`
      import assert from 'node:assert/strict';
      import {readFileSync} from 'node:fs';
      import {pathToFileURL} from 'node:url';
      const root=process.argv[1];
      const {createGateway}=await import(pathToFileURL(root+'/src/server.js'));
      const app=await createGateway({adminToken:process.argv[2],autoStart:false,trustedProxies:''});
      try {
        assert.equal(app.adminPath,root+'/data/admin.token');
        assert.equal(app.monitorPath,root+'/data/monitor.token');
        await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
        const base='http://127.0.0.1:'+app.server.address().port;
        const files={'/':'index.html','/admin.js':'admin.js','/theme.js':'theme.js','/i18n.js':'i18n.js','/security-ui.js':'security-ui.js','/maintenance-ui.js':'maintenance-ui.js','/monitor-charts.js':'monitor-charts.js','/backups-ui.js':'backups-ui.js','/abuse-ui.js':'abuse-ui.js','/access-ui.js':'access-ui.js','/style.css':'style.css','/logo.png':'assets/logo.png','/favicon.png':'assets/favicon.png'};
        for(const [path,file] of Object.entries(files)) {
          const response=await fetch(base+path);
          assert.equal(response.status,200,path);
          assert.deepEqual(Buffer.from(await response.arrayBuffer()),readFileSync(root+'/public/'+file),path);
        }
        for(const path of ['/src/server.js','/server.js','/schema.sql','/.env','/data/master.key','/public/admin.js'])assert.equal((await fetch(base+path)).status,404,path);
        console.log(JSON.stringify({staticFiles:Object.keys(files).length,defaultDataDirectory:root+'/data'}));
      } finally {await app.close();}
    `;
    const result=await promisify(execFile)(process.execPath,['--input-type=module','-e',script,installation,adminToken],{cwd:outside,env,timeout:10000,maxBuffer:65536});
    const report=JSON.parse(result.stdout.trim());
    assert.equal(report.staticFiles,13);
    assert.equal(report.defaultDataDirectory,installation+'/data');
    assert.equal(existsSync(outside+'/data'),false);
    assert.equal(existsSync(installation+'/src/data'),false);

    // Exercise the actual entrypoint with only this disposable installation's .env.
    writeFileSync(installation+'/.env',[
      'GATEWAY_DATABASE_URL='+process.env.GATEWAY_DATABASE_URL,
      'GATEWAY_DATABASE_SCHEMA='+schema,
      'GATEWAY_ADMIN_TOKEN='+adminToken,
      'GATEWAY_HOST=127.0.0.1',
      'GATEWAY_PORT=0',
      'GATEWAY_TRUSTED_PROXIES=',
    ].join('\n')+'\n',{mode:0o600});
    // Discover the ephemeral listener port without changing the gateway entrypoint.
    const hook=outside+'/listener.mjs';
    writeFileSync(hook,`
      import {Server} from 'node:http';
      const listen=Server.prototype.listen;
      Server.prototype.listen=function(...args){
        this.once('listening',()=>console.log('LAYOUT_TEST_PORT '+this.address().port));
        return listen.apply(this,args);
      };
    `);
    const cliEnv={...process.env};
    for(const key of ['GATEWAY_DATABASE_URL','GATEWAY_DATABASE_SCHEMA','GATEWAY_ADMIN_TOKEN','GATEWAY_HOST','GATEWAY_PORT','GATEWAY_DATA_DIR','GATEWAY_TRUSTED_PROXIES'])delete cliEnv[key];
    child=spawn(process.execPath,['--import',hook,installation+'/src/server.js'],{cwd:outside,env:cliEnv,stdio:['ignore','pipe','pipe']});
    const exited=once(child,'exit');
    let stdout='',stderr='';
    child.stderr.on('data',chunk=>{stderr+=chunk;});
    const listening=new Promise(resolve=>child.stdout.on('data',chunk=>{
      stdout+=chunk;const match=/LAYOUT_TEST_PORT (\d+)/.exec(stdout);if(match)resolve(Number(match[1]));
    }));
    const port=await Promise.race([listening,exited.then(()=>{throw Error('Gateway entrypoint exited before listening: '+stderr);})]);
    const base='http://127.0.0.1:'+port;
    assert.equal((await fetch(base+'/healthz')).status,200);
    assert.equal((await fetch(base+'/admin/apps')).status,401);
    const response=await fetch(base+'/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token:adminToken})});
    assert.equal(response.status,200);
    const {session}=await response.json();
    assert.equal((await fetch(base+'/admin/apps',{headers:{Authorization:'Bearer '+session}})).status,200);
    child.kill('SIGTERM');
    const [code,signal]=await exited;
    assert.equal(code,0);assert.equal(signal,null);
  } finally {
    if(child&&child.exitCode===null&&child.signalCode===null){const exited=once(child,'exit');child.kill('SIGKILL');await exited;}
    await seed?.close();
    rmSync(installation,{recursive:true,force:true});
    rmSync(outside,{recursive:true,force:true});
  }
});
