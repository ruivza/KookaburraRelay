import {test} from 'node:test';import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {createGateway} from './helpers.mjs';import {totp,base32} from '../security.js';
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
