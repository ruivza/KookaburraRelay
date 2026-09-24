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
 for(const patch of [{requestDetails:{...verdict.requestDetails,requestHash:'bad'}},{requestDetails:{...verdict.requestDetails,timestampMillis:now-300001}},{appIntegrity:{...verdict.appIntegrity,packageName:'com.evil.app'}},{appIntegrity:{...verdict.appIntegrity,certificateSha256Digest:['b'.repeat(43)]}},{deviceIntegrity:{}},{accountDetails:{appLicensingVerdict:'UNLICENSED'}}])assert.throws(()=>validateGoogleVerdict({...verdict,...patch},{policy,payload,now}),e=>e.status===403);
});
test('Google remote errors fail closed with bounded retry; credentials need a strong RSA key',async()=>{
 assert.throws(()=>googleCredential({type:'service_account',client_email:'a@example.com',private_key:'bad'}),e=>e.status===400);
 const {privateKey}=generateKeyPairSync('rsa',{modulusLength:2048});const credential=googleCredential({type:'service_account',client_email:'a@project.iam.gserviceaccount.com',private_key:privateKey.export({type:'pkcs8',format:'pem'})});
 let calls=0;const verifier=new GoogleIntegrity({fetcher:async(url,options)=>{calls++;assert.equal(url,'https://oauth2.googleapis.com/token');assert.equal(options.redirect,'error');return new Response('{}',{status:503});}});
 await assert.rejects(verifier.verify({proof:{integrityToken:'a'.repeat(30)},payload:'challenge',policy:{packageName:'com.example.app'},credential}),e=>e.status===503&&e.retryAfter===60);assert.equal(calls,1);
});
