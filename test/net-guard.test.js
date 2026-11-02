import {test} from 'node:test';
import assert from 'node:assert/strict';
import {isPublicAddress,requirePublic,publicLookup} from '../src/net-guard.js';

const internal=['127.0.0.1','10.0.0.1','172.16.5.4','192.168.1.1','169.254.169.254','100.64.0.1','0.0.0.0','224.0.0.1','255.255.255.255',
 '::1','::','fe80::1','fc00::1','fd12:3456::1','::ffff:127.0.0.1','::ffff:169.254.169.254'];
test('only globally routed unicast addresses count as public',()=>{
 for(const address of ['8.8.8.8','1.1.1.1','2606:4700:4700::1111','::ffff:8.8.8.8'])assert.equal(isPublicAddress(address),true,address);
 for(const address of [...internal,'not-an-address',''])assert.equal(isPublicAddress(address),false,address);
 assert.throws(()=>requirePublic([],'NoAnswer'),/NoAnswer/);
 assert.throws(()=>requirePublic([{address:'8.8.8.8'},{address:'10.0.0.1'}],'Mixed'),/Mixed/);
 assert.equal(requirePublic([{address:'8.8.8.8'}],'Unused').length,1);
});

const lookup=(answers,options)=>{
 const calls=[];
 return new Promise((resolve,reject)=>publicLookup('NotPublic',async(host,opts)=>{calls.push({host,opts});return answers;})(
  'objects.example.com',options,(error,...result)=>error?reject(error):resolve({result,calls})));
};
test('the connection lookup hands sockets only checked addresses',async()=>{
 const answers=[{address:'8.8.8.8',family:4},{address:'2606:4700:4700::1111',family:6}];
 const single=await lookup(answers,{family:0,hints:0});
 assert.deepEqual(single.result,['8.8.8.8',4]);
 assert.deepEqual(single.calls,[{host:'objects.example.com',opts:{family:0,hints:0,all:true}}]);
 assert.deepEqual((await lookup(answers,{family:0,hints:0,all:true})).result,[answers]);
 assert.deepEqual((await lookup([{address:'8.8.4.4'}],{all:true})).result,[[{address:'8.8.4.4',family:4}]]);
 for(const address of internal)await assert.rejects(lookup([{address,family:address.includes(':')?6:4}],{all:true}),/NotPublic/,address);
 await assert.rejects(lookup([...answers,{address:'10.1.2.3',family:4}],{family:0}),/NotPublic/);
 await assert.rejects(lookup([],{}),/NotPublic/);
});
