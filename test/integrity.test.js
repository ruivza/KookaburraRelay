import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash,generateKeyPairSync,sign} from 'node:crypto';
import cbor from 'cbor';
import {verifyApple,validateGoogleVerdict,googleCredential,GoogleIntegrity} from '../integrity.js';
const sha=b=>createHash('sha256').update(b).digest();
test('Apple assertions verify real P-256 signatures, app binding and increasing counter',()=>{
 const {publicKey,privateKey}=generateKeyPairSync('ec',{namedCurve:'prime256v1'}),policy={teamId:'0123456789',bundleId:'com.example.mail'},payload='challenge-random';
 const auth=Buffer.alloc(37);sha(policy.teamId+'.'+policy.bundleId).copy(auth);auth.writeUInt32BE(2,33);
 const signature=sign('sha256',sha(Buffer.concat([auth,sha(payload)])),privateKey);
 const proof={keyId:sha('key').toString('base64'),assertion:cbor.encode({signature,authenticatorData:auth}).toString('base64')};
 const key={public_key:publicKey.export({type:'spki',format:'pem'}),counter:1};
 assert.equal(verifyApple({proof,payload,policy,key}).counter,2);
 for(const patch of [{payload:'wrong'},{policy:{...policy,bundleId:'com.evil.app'}},{key:{...key,counter:2}},{proof:{...proof,assertion:'AAAA'}}])assert.throws(()=>verifyApple({proof,payload,policy,key,...patch}),e=>e.status===403);
 assert.throws(()=>verifyApple({proof:{...proof,attestation:'AAAA'},payload,policy}),e=>e.status===403);
});
test('Google verdict requires matching hash, package, signing certificate, freshness, device and license',()=>{
 const now=Date.now(),payload='challenge',policy={packageName:'com.example.app',certificateDigests:['a'.repeat(43)]};
 const verdict={requestDetails:{requestPackageName:policy.packageName,requestHash:sha(payload).toString('base64url'),timestampMillis:String(now)},appIntegrity:{packageName:policy.packageName,appRecognitionVerdict:'PLAY_RECOGNIZED',certificateSha256Digest:policy.certificateDigests},deviceIntegrity:{deviceRecognitionVerdict:['MEETS_DEVICE_INTEGRITY']},accountDetails:{appLicensingVerdict:'LICENSED'}};
 assert.equal(validateGoogleVerdict(verdict,{policy,payload,now}),true);
 for(const patch of [{requestDetails:{...verdict.requestDetails,requestHash:'bad'}},{requestDetails:{...verdict.requestDetails,timestampMillis:now-300001}},{appIntegrity:{...verdict.appIntegrity,packageName:'com.evil.app'}},{appIntegrity:{...verdict.appIntegrity,certificateSha256Digest:['b'.repeat(43)]}},{deviceIntegrity:{}},{deviceIntegrity:{deviceRecognitionVerdict:'NOT_MEETS_DEVICE_INTEGRITY'}},{accountDetails:{appLicensingVerdict:'UNLICENSED'}}])assert.throws(()=>validateGoogleVerdict({...verdict,...patch},{policy,payload,now}),e=>e.status===403);
});
test('Google remote errors fail closed with bounded retry; credentials need a strong RSA key',async()=>{
 assert.throws(()=>googleCredential({type:'service_account',client_email:'a@example.com',private_key:'bad'}),e=>e.status===400);
 const {privateKey}=generateKeyPairSync('rsa',{modulusLength:2048});const credential=googleCredential({type:'service_account',client_email:'a@project.iam.gserviceaccount.com',private_key:privateKey.export({type:'pkcs8',format:'pem'})});
 let calls=0;const verifier=new GoogleIntegrity({fetcher:async(url,options)=>{calls++;assert.equal(url,'https://oauth2.googleapis.com/token');assert.equal(options.redirect,'error');return new Response('{}',{status:503});}});
 await assert.rejects(verifier.verify({proof:{integrityToken:'a'.repeat(30)},payload:'challenge',policy:{packageName:'com.example.app'},credential}),e=>e.status===503&&e.retryAfter===60);assert.equal(calls,1);
});

function googleFixture(fetcher) {
 const {privateKey}=generateKeyPairSync('rsa',{modulusLength:2048});
 const credential={clientEmail:'a@project.iam.gserviceaccount.com',privateKey:privateKey.export({type:'pkcs8',format:'pem'})};
 let now=1800000000000;
 const payload='challenge',policy={packageName:'com.example.app',certificateDigests:['a'.repeat(43)]};
 const verdict=()=>({tokenPayloadExternal:{requestDetails:{requestPackageName:policy.packageName,requestHash:sha(payload).toString('base64url'),timestampMillis:String(now)},appIntegrity:{packageName:policy.packageName,appRecognitionVerdict:'PLAY_RECOGNIZED',certificateSha256Digest:policy.certificateDigests},deviceIntegrity:{deviceRecognitionVerdict:['MEETS_DEVICE_INTEGRITY']},accountDetails:{appLicensingVerdict:'LICENSED'}}});
 const verifier=new GoogleIntegrity({now:()=>now,fetcher:(url,options)=>fetcher(url,options,verdict)});
 return {verifier,credential,advance(ms){now+=ms;},verify(next=credential){return verifier.verify({proof:{integrityToken:'a'.repeat(30)},payload,policy,credential:next});}};
}

test('Google OAuth caches one credential, shares concurrent refreshes and refreshes before expiry',async()=>{
 let oauth=0,decoded=0,begin,finish;
 const begun=new Promise(r=>begin=r),pending=new Promise(r=>finish=r);
 const f=googleFixture(async(url,options,verdict)=>{
  if(url==='https://oauth2.googleapis.com/token'){
   oauth++;if(oauth===1){begin();await pending;}
   return new Response(JSON.stringify({access_token:'test-token-'+oauth,expires_in:120}));
  }
  decoded++;assert.equal(options.headers.Authorization,'Bearer test-token-'+oauth);
  return new Response(JSON.stringify(verdict()));
 });
 const first=f.verify();await begun;const second=f.verify();
 const concurrentOAuth=oauth;finish();
 await Promise.all([first,second]);assert.equal(concurrentOAuth,1);await f.verify();
 assert.equal(oauth,1);assert.equal(decoded,3);
 f.advance(61000);await f.verify();assert.equal(oauth,2);
 await f.verify({...f.credential,clientEmail:'b@project.iam.gserviceaccount.com'});assert.equal(oauth,3);
 // Rotating a key under the same service-account email must not reuse the old token.
 const {privateKey}=generateKeyPairSync('rsa',{modulusLength:2048});
 await f.verify({...f.credential,clientEmail:'b@project.iam.gserviceaccount.com',privateKey:privateKey.export({type:'pkcs8',format:'pem'})});assert.equal(oauth,4);
});

test('Google OAuth refresh failure and rejected cached tokens are cleared for a later retry',async()=>{
 let oauth=0,rejectDecode=false;
 const f=googleFixture(async(url,options,verdict)=>{
  if(url==='https://oauth2.googleapis.com/token'){
   oauth++;return oauth===1?new Response('{}',{status:503}):new Response(JSON.stringify({access_token:'test-token-'+oauth,expires_in:3600}));
  }
  return rejectDecode?new Response('{}',{status:401}):new Response(JSON.stringify(verdict()));
 });
 const failed=await Promise.allSettled([f.verify(),f.verify()]);
 assert.ok(failed.every(r=>r.status==='rejected'&&r.reason.status===503));assert.equal(oauth,1);
 await f.verify();assert.equal(oauth,2);
 rejectDecode=true;await assert.rejects(f.verify(),e=>e.status===503);assert.equal(oauth,2);
 rejectDecode=false;await f.verify();assert.equal(oauth,3);
});

test('Google OAuth responses without a trustworthy lifetime are never cached',async()=>{
 for(const expires_in of [undefined,0,-1,'3600']){
  let oauth=0;
  const f=googleFixture(async(url,options,verdict)=>{
   if(url==='https://oauth2.googleapis.com/token'){oauth++;return new Response(JSON.stringify({access_token:'test-token',expires_in}));}
   return new Response(JSON.stringify(verdict()));
  });
  await f.verify();await f.verify();assert.equal(oauth,2);
 }
});

test('a delayed old credential refresh cannot replace the latest credential cache',async()=>{
 let oauth=0,begin,finish;
 const begun=new Promise(r=>begin=r),pending=new Promise(r=>finish=r),decoded=[];
 const f=googleFixture(async(url,options,verdict)=>{
  if(url==='https://oauth2.googleapis.com/token'){
   oauth++;
   const jwt=new URLSearchParams(options.body).get('assertion');
   const {iss}=JSON.parse(Buffer.from(jwt.split('.')[1],'base64url'));
   if(iss===f.credential.clientEmail){begin();await pending;}
   return new Response(JSON.stringify({access_token:'test-token-'+iss,expires_in:3600}));
  }
  decoded.push(options.headers.Authorization);return new Response(JSON.stringify(verdict()));
 });
 const old=f.verify();await begun;
 const current={...f.credential,clientEmail:'current@project.iam.gserviceaccount.com'};
 try{await f.verify(current);}finally{finish();}
 await old;await f.verify(current);
 assert.equal(oauth,2);
 assert.deepEqual(decoded,['Bearer test-token-'+current.clientEmail,'Bearer test-token-'+f.credential.clientEmail,'Bearer test-token-'+current.clientEmail]);
});
