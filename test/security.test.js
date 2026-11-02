import {test} from 'node:test';import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync,writeFileSync,symlinkSync,lstatSync,existsSync,readdirSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {createGateway} from './helpers.mjs';import {totp,base32,rotatedMarker} from '../src/security.js';
test('TOTP matches RFC 6238 SHA-1 vectors (six digit truncation)',()=>{const secret=base32(Buffer.from('12345678901234567890'));for(const [time,code]of [[59,'287082'],[1111111109,'081804'],[1111111111,'050471'],[1234567890,'005924'],[2000000000,'279037'],[20000000000,'353130']])assert.equal(totp(secret,time*1000),code);});
test('two-step setup, replay protection, single-use recovery, rotation and session revocation',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'relay-security-'));let time=Date.now();const token='test-admin-token-'.repeat(3),next='new-admin-token-'.repeat(3);let app=await createGateway({dataDir:dir,adminToken:token,autoStart:false,now:()=>time});
 try{
  await assert.rejects(app.security.authenticate(token),{status:401});
  const login=await app.security.login({token});await app.security.authenticate(login.session);
  await assert.rejects(app.security.setup({currentToken:'wrong'}),{status:403});
  const setup=await app.security.setup({currentToken:token});assert.ok(setup.qr.startsWith('data:image/png;base64,'));
  assert.equal((await app.security.status()).twoFactorEnabled,false);
  const enabled=await app.security.confirm({currentToken:token,code:totp(setup.secret,time)});assert.equal(enabled.recoveryCodes.length,10);
  await assert.rejects(app.security.authenticate(login.session),{status:401});
  assert.deepEqual(await app.security.login({token}),{requiresSecondFactor:true});
  await assert.rejects(app.security.login({token,code:totp(setup.secret,time)}),{status:403});
  time+=30000;const code=totp(setup.secret,time);
  const concurrent=await Promise.allSettled([app.security.login({token,code}),app.security.login({token,code})]);assert.equal(concurrent.filter(r=>r.status==='fulfilled').length,1);
  const recovery=enabled.recoveryCodes[0];const recovered=await app.security.login({token,code:recovery});
  await assert.rejects(app.security.login({token,code:recovery}),{status:403});
  assert.equal((await app.security.status()).recoveryCodesRemaining,9);
  await assert.rejects(app.security.changeToken({currentToken:token,newToken:'short',code:enabled.recoveryCodes[1]}),{status:400});
  await app.security.changeToken({currentToken:token,newToken:next,code:enabled.recoveryCodes[1]});
  await assert.rejects(app.security.authenticate(recovered.session),{status:401});await assert.rejects(app.security.login({token}),{status:401});
  await app.close();app=await createGateway({dataDir:dir,adminToken:token,autoStart:false,now:()=>time});
  assert.deepEqual(await app.security.login({token:next}),{requiresSecondFactor:true});
  time+=30000;const session=await app.security.login({token:next,code:totp(setup.secret,time)});
  time+=8*3600000;await assert.rejects(app.security.authenticate(session.session),{status:401});
  await app.security.disable({currentToken:next,code:totp(setup.secret,time)});
  assert.equal((await app.security.status()).twoFactorEnabled,false);assert.ok((await app.security.login({token:next})).session);
  const stored=JSON.stringify((await app.db.query('SELECT * FROM admin_security')).rows);
  for(const sensitive of [token,next,setup.secret,recovery])assert.ok(!stored.includes(sensitive));
 }finally{await app.close();rmSync(dir,{recursive:true,force:true});}
});
test('login HTTP endpoint never grants a session for only a token when 2FA is enabled; logout revokes',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'relay-auth-http-')),token='http-token'.repeat(5);const app=await createGateway({dataDir:dir,adminToken:token,autoStart:false});
 try{await new Promise(r=>app.server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+app.server.address().port;
 const post=async(path,body,bearer='')=>fetch(base+path,{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+bearer},body:JSON.stringify(body)});
 const login=await (await post('/auth/login',{token})).json();assert.ok(login.session);
 assert.equal((await fetch(base+'/admin/apps',{headers:{Authorization:'Bearer '+token}})).status,401);
 await post('/admin/logout',{},login.session);assert.equal((await fetch(base+'/admin/apps',{headers:{Authorization:'Bearer '+login.session}})).status,401);
 const setup=await app.security.setup({currentToken:token});await app.security.confirm({currentToken:token,code:totp(setup.secret)});
 const pending=await (await post('/auth/login',{token})).json();assert.equal(pending.requiresSecondFactor,true);assert.equal(pending.session,undefined);
 for(let i=0;i<21;i++){const res=await post('/auth/login',{token:'wrong'});if(i===20)assert.equal(res.status,429);}
 }finally{await app.close();rmSync(dir,{recursive:true,force:true});}
});
test('token verification has a global in-flight cap; excess attempts get 503 with Retry-After before touching the database',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'relay-auth-cap-')),token='capped-token'.repeat(4);const app=await createGateway({dataDir:dir,adminToken:token,autoStart:false});let client;
 try{await new Promise(r=>app.server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+app.server.address().port;
 // Hold the admin row so verifications queue behind it, as they would behind slow scrypt work.
 client=await app.db.pool.connect();await client.query('BEGIN');await client.query('SELECT 1 FROM admin_security WHERE id=1 FOR UPDATE');
 const held=Array.from({length:4},()=>app.security.login({token}));
 assert.equal(app.security.verifying,4);
 await assert.rejects(app.security.login({token}),{status:503,reason:'login_concurrency'});
 await assert.rejects(app.security.changeToken({currentToken:token,newToken:'next-capped-token'.repeat(3)}),{status:503});
 await assert.rejects(app.security.reauthenticate({token_hash:'00:00'},{currentToken:token}),{status:503});
 const res=await fetch(base+'/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token})});
 assert.equal(res.status,503);assert.equal(res.headers.get('retry-after'),'5');assert.equal((await res.json()).reason,'login_concurrency');
 await client.query('ROLLBACK');client.release();client=null;
 for(const result of await Promise.all(held))assert.ok(result.session);
 assert.equal(app.security.verifying,0);
 assert.equal((await fetch(base+'/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token})})).status,200);
 }finally{if(client){await client.query('ROLLBACK');client.release();}await app.close();rmSync(dir,{recursive:true,force:true});}
});
test('bootstrap token file is read only before a token is stored, replaced by a marker after rotation, and a stale configured token warns',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'relay-bootstrap-')),file=join(dir,'admin.token'),next='rotated-admin-token-'.repeat(3);let app;
 const start=adminToken=>createGateway({dataDir:dir,adminToken,autoStart:false});
 const warnings=t.mock.method(console,'warn',()=>{});const stale=()=>warnings.mock.calls.filter(c=>String(c.arguments[0]).includes('GATEWAY_ADMIN_TOKEN')).length;
 try{
  app=await start('');const initial=readFileSync(file,'utf8').trim();assert.ok(initial.length>=32);
  assert.ok((await app.security.login({token:initial})).session);
  await app.security.changeToken({currentToken:initial,newToken:next});
  assert.equal(readFileSync(file,'utf8'),rotatedMarker+'\n');
  await app.close();app=await start('');
  assert.equal(readFileSync(file,'utf8'),rotatedMarker+'\n');
  assert.ok((await app.security.login({token:next})).session);await assert.rejects(app.security.login({token:initial}),{status:401});
  // Once a token is stored the file is never read, even if it no longer holds a usable token.
  writeFileSync(file,'short');await app.close();app=await start('');
  assert.ok((await app.security.login({token:next})).session);assert.equal(stale(),0);
  await app.close();app=await start(initial);assert.equal(stale(),1);
  assert.ok((await app.security.login({token:next})).session);await assert.rejects(app.security.login({token:initial}),{status:401});
  await app.close();app=await start(next);assert.equal(stale(),1);
  // A fresh database with a rotated data directory gets a new bootstrap token instead of failing.
  writeFileSync(file,rotatedMarker+'\n');await app.db.exec('DELETE FROM admin_security');await app.close();app=await start('');
  const regenerated=readFileSync(file,'utf8').trim();assert.notEqual(regenerated,rotatedMarker);assert.ok(regenerated.length>=32);
  assert.ok((await app.security.login({token:regenerated})).session);
 }finally{await app?.close();rmSync(dir,{recursive:true,force:true});}
});
test('admin token file writes replace a planted symlink instead of writing through it',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'relay-token-link-')),file=join(dir,'admin.token'),outside=join(dir,'outside'),next='linked-admin-token-'.repeat(3);let app;
 try{
  symlinkSync(outside,file);app=await createGateway({dataDir:dir,adminToken:'',autoStart:false});
  assert.ok(lstatSync(file).isFile());assert.equal(existsSync(outside),false);const initial=readFileSync(file,'utf8').trim();assert.ok(initial.length>=32);
  rmSync(file);writeFileSync(outside,'untouched');symlinkSync(outside,file);
  await app.security.changeToken({currentToken:initial,newToken:next});
  assert.equal(readFileSync(outside,'utf8'),'untouched');assert.ok(lstatSync(file).isFile());assert.equal(readFileSync(file,'utf8'),rotatedMarker+'\n');
  assert.deepEqual(readdirSync(dir).filter(name=>name.endsWith('.tmp')),[]);
 }finally{await app?.close();rmSync(dir,{recursive:true,force:true});}
});
