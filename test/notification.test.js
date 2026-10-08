import {test} from 'node:test';
import assert from 'node:assert/strict';
import {encryptedNotification,deliveryContent,requestedKinds,notificationSettings} from '../notification.js';
test('encrypted envelope validator rejects plaintext, unknown fields, oversize and expired content',()=>{
 const now=1800000000000;
 const e={version:1,keyId:'a'.repeat(64),id:'11111111-1111-4111-8111-111111111111',expires:now+60000,ephemeralKey:Buffer.concat([Buffer.from([4]),Buffer.alloc(64)]).toString('base64'),ciphertext:Buffer.alloc(100).toString('base64')};
 assert.deepEqual(encryptedNotification(e,'encrypted_alert',now),e);
 for(const bad of [{...e,sender:'not allowed'},{...e,expires:now-1},{...e,ciphertext:Buffer.alloc(2401).toString('base64')},{...e,keyId:'bad'},{...e,keyId:[e.keyId]},{...e,id:[e.id]},{...e,id:'-'.repeat(36)}]) assert.throws(()=>encryptedNotification(bad,'encrypted_alert',now));
 assert.throws(()=>encryptedNotification(e,'sync',now));
});

test('ordinary alerts validate a bounded shape and cannot be smuggled through sync',()=>{
 const alert={title:'Task assigned',body:'You have a new task',sound:false};
 assert.deepEqual(deliveryContent('alert',null,alert),{alert});
 assert.throws(()=>deliveryContent('sync',null,alert));
 assert.throws(()=>deliveryContent('encrypted_alert',null,alert));
 assert.throws(()=>deliveryContent('alert',null,{...alert,url:'https://example.test'}));
 assert.throws(()=>deliveryContent('alert',null,{...alert,body:'x'.repeat(401)}));
 assert.deepEqual(requestedKinds({kinds:['alert','sync']}),['sync','alert']);
 assert.throws(()=>requestedKinds({purpose:'mail'}));
});

test('legacy encrypted fallback sound is normalized without changing content or capabilities',()=>{
 const config=notificationSettings({kinds:['sync','encrypted_alert'],fallback:{title:'Mail',body:'New mail',sound:false}});
 assert.deepEqual(config,{kinds:['sync','encrypted_alert'],fallback:{title:'Mail',body:'New mail',sound:true}});
 assert.equal(notificationSettings().fallback.sound,true);
});

test('APNs encrypted alerts request sound while background hints remain silent',async()=>{
 const {APNsChannel}=await import('../channels.js');
 let payload;
 const channel=new APNsChannel({},()=>({send(_target,_token,value){payload=value;return {status:200}}}));
 const target={device_id:'phone',app_id:'mail',server_id:'server',environment:'sandbox'};
 await channel.send(target,'token',{kind:'encrypted_alert',fallback:{title:'Mail',body:'New mail',sound:false}});
 assert.equal(payload.aps.sound,'default');
 assert.equal(payload.aps['mutable-content'],1);
 await channel.send(target,'token',{kind:'sync'});
 assert.deepEqual(payload.aps,{'content-available':1});
 await channel.send(target,'token',{kind:'alert',alert:{title:'Mail',body:'New mail',sound:false}});
 assert.equal(payload.aps.sound,undefined);
});
