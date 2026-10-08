import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, verify } from 'node:crypto';
import { FCMChannel } from '../src/fcm.js';
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
export const account = { type:'service_account', project_id:'perch-test', client_email:'worker@perch-test.iam.gserviceaccount.com', private_key: privateKey.export({ type:'pkcs8', format:'pem' }) };
test('FCM signs OAuth JWT, shares token refresh, preserves token case and classifies provider errors', async () => {
  let oauth=0, error=false;
  const sent=[];
  const provider = new FCMChannel({ projectId:account.project_id, clientEmail:account.client_email, privateKey:account.private_key }, {
    now:()=>1800000000000,
    fetcher:async (url,options)=>{
      assert.equal(options.redirect,'error');
      if(url==='https://oauth2.googleapis.com/token') {
        oauth++;
        const assertion=new URLSearchParams(options.body).get('assertion');
        const [header,payload,signature]=assertion.split('.');
        assert.ok(verify('RSA-SHA256',Buffer.from(header+'.'+payload),publicKey,Buffer.from(signature,'base64url')));
        const claims=JSON.parse(Buffer.from(payload,'base64url'));
        assert.equal(claims.aud,url);assert.equal(claims.iss,account.client_email);
        assert.equal(claims.scope,'https://www.googleapis.com/auth/firebase.messaging');
        return Response.json({access_token:'scoped-token',expires_in:3600});
      }
      assert.equal(url,'https://fcm.googleapis.com/v1/projects/perch-test/messages:send');
      assert.equal(options.headers.Authorization,'Bearer scoped-token');sent.push(JSON.parse(options.body));
      return error ? Response.json({error:{details:[{'@type':'type.googleapis.com/google.firebase.fcm.v1.FcmError',errorCode:'UNREGISTERED'}]}},{status:404}) : Response.json({name:'projects/perch-test/messages/1'});
    },
  });
  const target={device_id:'phone',app_id:'notes'};
  const results=await Promise.all([provider.send(target,'AbC_Token',{kind:'challenge',proof:{id:'proof'}}),provider.send(target,'AbC_Token',{kind:'sync'})]);
  assert.equal(oauth,1);assert.ok(results.every(r=>r.status===200));
  assert.equal(sent[0].message.token,'AbC_Token');
  assert.deepEqual(JSON.parse(sent[0].message.data.perchRegistration),{id:'proof'});
  assert.equal(sent[1].message.android.priority,'normal');
  assert.equal((await provider.send(target,'AbC_Token',{kind:'alert',alert:{title:'Reminder',body:'Meeting starts',sound:false}})).status,200);
  assert.deepEqual(sent[2].message.notification,{title:'Reminder',body:'Meeting starts'});
  assert.equal(sent[2].message.android.priority,'high');
  assert.equal(sent[2].message.android.notification.default_sound,false);
  assert.equal(JSON.parse(sent[2].message.data.relay).appId,'notes');
  assert.equal((await provider.send(target,'AbC_Token',{kind:'encrypted_alert'})).reason,'UnsupportedMessage');
  assert.equal(sent.length,3);
  error=true;assert.equal((await provider.send(target,'AbC_Token',{kind:'sync'})).reason,'UNREGISTERED');
  provider.close();
});
