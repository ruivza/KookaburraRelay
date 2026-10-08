import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {writeFile,readFile,stat} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash} from 'node:crypto';
import {createGateway} from './helpers.mjs';
import {BackupWorker} from '../src/backup-worker.js';
import {B2Storage} from '../src/b2-storage.js';
import {validateRecipient,encryptFile} from '../src/backup-crypto.js';
import {totp} from '../src/security.js';
const exec=promisify(execFile),admin='backup-test-admin-'.repeat(3);
async function fixture(){
 const dir=mkdtempSync('/tmp/relay-backup-tests-');
 const key=dir+'/identity.txt';
 await exec('age-keygen',['-o',key]);
 const recipient=(await exec('age-keygen',['-y',key])).stdout.trim();
 let now=Date.now();
 const app=await createGateway({dataDir:dir,adminToken:admin,autoStart:false,now:()=>now});
 const b=app.backups;
 const settings={...(await b.status()).settings,enabled:true,endpoint:'https://s3.us-west-004.backblazeb2.com',bucket:'test-bucket',prefix:'relay-test',keyId:'testkey123',recipient};
 delete settings.hasApplicationKey;
 return {dir,key,app,b,settings,advance(ms){now+=ms;},now:()=>now,
  save:async extra=>b.save({settings,revision:(await b.row()).settings.revision,currentToken:admin,applicationKey:'fixture-secret-application-key',...extra}),
  close:async()=>{await app.close();rmSync(dir,{recursive:true,force:true});}};
}
test('backup credentials require reauthentication, never return plaintext, and reject unsafe targets and stale writes',async()=>{
 const f=await fixture();try{
  await assert.rejects(f.save({currentToken:'wrong'}),e=>e.status===403);
  await assert.rejects(f.save({settings:{...f.settings,endpoint:'http://127.0.0.1:9000'}}),e=>e.status===400);
  await assert.rejects(f.save({settings:{...f.settings,endpoint:'https://s3.us-west-004.backblazeb2.com.evil.test'}}),e=>e.status===400);
  await assert.rejects(f.save({settings:{...f.settings,recipient:readFileSync(f.key,'utf8')}}),e=>e.status===400);
  const saved=await f.save();assert.equal(saved.settings.hasApplicationKey,true);
  assert.ok(!JSON.stringify(saved).includes('fixture-secret-application-key'));
  const row=await f.b.row();assert.notEqual(row.secret,'fixture-secret-application-key');
  await assert.rejects(f.save({revision:'stale'}),e=>e.status===409);
  await assert.rejects(f.save({settings:{...f.settings,bucket:'another-bucket'},applicationKey:''}),e=>e.status===400);
  await f.save({applicationKey:''});assert.equal((await f.b.row()).secret,row.secret);
 }finally{await f.close();}
});
test('backup configuration changes consume a valid second factor and cannot bypass it',async()=>{
 const f=await fixture();try{
  const setup=await f.app.security.setup({currentToken:admin});
  await f.app.security.confirm({currentToken:admin,code:totp(setup.secret,f.now())});
  await assert.rejects(f.save(),e=>e.status===403);
  f.advance(30000);const code=totp(setup.secret,f.now());
  await f.save({code});await assert.rejects(f.save({code}),e=>e.status===403);
 }finally{await f.close();}
});
test('age encryption round-trips with the offline identity and rejects invalid public keys',async()=>{
 const f=await fixture();try{
  await validateRecipient(f.settings.recipient);
  await assert.rejects(validateRecipient(f.settings.recipient.slice(0,-1)+(f.settings.recipient.endsWith('q')?'p':'q')));
  const input=f.dir+'/plain',output=f.dir+'/encrypted.age';await writeFile(input,'private test backup');
  await encryptFile(input,output,f.settings.recipient);
  assert.ok(!(await readFile(output)).includes(Buffer.from('private test backup')));
  assert.equal((await exec('age',['-d','-i',f.key,output])).stdout,'private test backup');
 }finally{await f.close();}
});
test('worker preserves local success across remote failure and retries the same ciphertext without a second backup',async()=>{
 const f=await fixture();try{
  await f.save();let localCount=0,uploads=0,cipher;
  const worker=new BackupWorker({db:f.app.db,backups:f.b,root:f.dir,now:f.now,
   localBackup:async()=>{localCount++;await writeFile(f.dir+'/relay-fixture.tar','fixture database backup');return 'relay-fixture.tar';},
   storageFactory:()=>({upload:async file=>{uploads++;const bytes=await readFile(file);if(!cipher){cipher=bytes;throw Error('lost response');}assert.deepEqual(bytes,cipher);return {bytes:bytes.length};},close(){}})});
  await worker.initialize();const job=await f.b.enqueue();await worker.tick();
  let row=await f.app.db.prepare('SELECT * FROM backup_jobs WHERE id=?').get(job.id);
  assert.equal(row.local_status,'completed');assert.equal(row.remote_status,'failed');assert.equal(row.state,'retrying');
  assert.ok(!(await f.b.status()).lastRemoteSuccess);
  f.advance(61000);await worker.tick();
  row=await f.app.db.prepare('SELECT * FROM backup_jobs WHERE id=?').get(job.id);
  assert.equal(row.state,'completed');assert.equal(uploads,2);assert.equal(localCount,1);
  await writeFile(f.dir+'/saved.age',cipher);assert.equal((await exec('age',['-d','-i',f.key,f.dir+'/saved.age'])).stdout,'fixture database backup');
 }finally{await f.close();}
});
test('disabling remote backup cancels queued uploads while local jobs still run',async()=>{
 const f=await fixture();try{
  await f.save();const testJob=await f.b.enqueue('test');
  await f.save({settings:{...f.settings,enabled:false}});
  assert.equal((await f.app.db.prepare('SELECT state FROM backup_jobs WHERE id=?').get(testJob.id)).state,'cancelled');
  let sent=false;
  const worker=new BackupWorker({db:f.app.db,backups:f.b,root:f.dir,now:f.now,localBackup:async()=>{await writeFile(f.dir+'/relay-local.tar','local');return 'relay-local.tar';},storageFactory:()=>{sent=true;throw Error();}});
  await worker.initialize();const job=await f.b.enqueue();await worker.tick();
  const row=await f.app.db.prepare('SELECT * FROM backup_jobs WHERE id=?').get(job.id);
  assert.equal(row.state,'completed');assert.equal(row.remote_status,'disabled');assert.equal(sent,false);
 }finally{await f.close();}
});
test('configuration is fenced during an in-flight operation and restart resumes waiting work',async()=>{
 const f=await fixture();let release;
 try{
  await f.save();const job=await f.b.enqueue('test');
  const options={db:f.app.db,backups:f.b,root:f.dir,now:f.now,storageFactory:()=>({upload:()=>new Promise(r=>release=r),close(){}})};
  const worker=new BackupWorker(options);await worker.initialize();const running=worker.tick();
  while(!release)await new Promise(r=>setTimeout(r,5));
  await assert.rejects(f.save(),e=>e.status===409);
  release({bytes:10});await running;
  await f.app.db.prepare("UPDATE backup_jobs SET state='running' WHERE id=?").run(job.id);
  const restarted=new BackupWorker(options);await restarted.initialize();
  assert.equal((await f.app.db.prepare('SELECT state FROM backup_jobs WHERE id=?').get(job.id)).state,'retrying');
 }finally{release?.({bytes:10});await f.close();}
});
test('B2 upload uses checksums and recognizes an already accepted object after a lost response',async()=>{
 const f=await fixture();try{
  const file=f.dir+'/cipher.age';await writeFile(file,'encrypted-fixture');const stored=new Map();let puts=0;
  const client={async send(command){const i=command.input;
   if(command.constructor.name==='HeadObjectCommand'){if(!stored.has(i.Key))throw Object.assign(Error(),{$metadata:{httpStatusCode:404}});return stored.get(i.Key);}
   puts++;const chunks=[];for await(const chunk of i.Body)chunks.push(chunk);const bytes=Buffer.concat(chunks);
   assert.equal(i.ContentMD5,createHash('md5').update(bytes).digest('base64'));
   stored.set(i.Key,{ContentLength:bytes.length,Metadata:i.Metadata});throw Error('response lost');
  },destroy(){}};
  const b2=new B2Storage(f.settings,'secret',{client});
  await assert.rejects(b2.upload(file,'relay-test/job.age'));
  assert.equal((await b2.upload(file,'relay-test/job.age')).bytes,(await stat(file)).size);assert.equal(puts,1);
  await writeFile(file,'different');await assert.rejects(b2.upload(file,'relay-test/job.age'),/RemoteObjectConflict/);
 }finally{await f.close();}
});
test('backup HTTP routes require admin sessions and do not expose keys',async()=>{
 const f=await fixture();try{
  await new Promise(r=>f.app.server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+f.app.server.address().port;
  assert.equal((await fetch(base+'/admin/backups')).status,401);
  const login=await f.app.security.login({token:admin});
  const response=await fetch(base+'/admin/backups',{headers:{Authorization:'Bearer '+login.session}});
  assert.equal(response.status,200);assert.equal((await response.json()).settings.hasApplicationKey,false);
  const run=await fetch(base+'/admin/backups/run',{method:'POST',headers:{Authorization:'Bearer '+login.session,'Content-Type':'application/json'},body:'{}'});
  assert.equal(run.status,202);
 }finally{await f.close();}
});

test('real S3 SDK signs B2 requests and sends encrypted bytes with an explicit MD5 checksum',async()=>{
 const {Readable}=await import('node:stream');const f=await fixture();try{
  const file=f.dir+'/wire.age';await writeFile(file,'encrypted wire fixture');let stored,puts=0;
  const storage=new B2Storage(f.settings,'fixture-secret',{requestHandler:{async handle(request){
   assert.equal(request.hostname,'s3.us-west-004.backblazeb2.com');
   assert.ok(request.headers.authorization.startsWith('AWS4-HMAC-SHA256 '));
   assert.ok(request.path.includes('/test-bucket/relay-test/wire.age'));
   if(request.method==='PUT'){
    puts++;const chunks=[];for await(const chunk of request.body)chunks.push(Buffer.from(chunk));const bytes=Buffer.concat(chunks);
    assert.equal(request.headers['content-md5'],createHash('md5').update(bytes).digest('base64'));
    assert.equal(request.headers['x-amz-sdk-checksum-algorithm'],undefined);
    stored={'content-length':String(bytes.length),'x-amz-meta-sha256':request.headers['x-amz-meta-sha256']};
    return {response:{statusCode:200,headers:{},body:Readable.from([])}};
   }
   return {response:{statusCode:stored?200:404,headers:stored||{},body:Readable.from([])}};
  },destroy(){}}});
  try{assert.equal((await storage.upload(file,'relay-test/wire.age')).bytes,(await stat(file)).size);assert.equal(puts,1);}finally{storage.close();}
 }finally{await f.close();}
});

test('storage settings support providers and preserve legacy B2 configuration',async()=>{
 const {validateTarget,storageSettings}=await import('../src/storage-target.js');
 const base={endpoint:'https://s3.us-west-004.backblazeb2.com',bucket:'test-bucket',prefix:'backups',keyId:'examplekey123'};
 assert.equal(validateTarget(base).region,'us-west-004');assert.equal(storageSettings(base).forcePathStyle,true);
 for(const target of [
  {provider:'r2',endpoint:'https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com',region:'auto'},
  {provider:'aws',endpoint:'https://s3.ap-southeast-2.amazonaws.com',region:'ap-southeast-2',forcePathStyle:false},
  {provider:'custom',endpoint:'https://objects.example.com:9443',region:'us-east-1',forcePathStyle:true}
 ]) assert.equal(validateTarget({...base,...target}).region,target.region);
 for(const target of [
  {provider:'custom',endpoint:'http://objects.example.com'},
  {provider:'custom',endpoint:'https://user:secret@objects.example.com'},
  {provider:'custom',endpoint:'https://objects.example.com/path'},
  {provider:'custom',endpoint:'https://objects.example.com?secret=foo'},
  {provider:'custom',endpoint:'https://127.0.0.1'},
  {provider:'r2',endpoint:'https://r2.cloudflarestorage.com.evil.test'},
  {provider:'aws',endpoint:'https://s3.amazonaws.com.evil.test'},
  {provider:'b2',region:'wrong'},
  {provider:'r2',endpoint:'https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com',region:'us-east-1'},
  {provider:'custom',region:'bad/region'},
  {provider:'custom',forcePathStyle:'false'}
 ])assert.throws(()=>validateTarget({...base,...target}),e=>e.status===400);
});

test('changing storage providers requires replacement credentials and persists S3 options',async()=>{
 const f=await fixture();try{
  await f.save();const settings={...f.settings,provider:'r2',endpoint:'https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com',region:'auto',forcePathStyle:true};
  await assert.rejects(f.save({settings,applicationKey:''}),e=>e.status===400);
  const saved=await f.save({settings,applicationKey:'replacement-fixture-secret'});
  assert.equal(saved.settings.provider,'r2');assert.equal(saved.settings.region,'auto');assert.equal(saved.settings.forcePathStyle,true);
  assert.ok(!JSON.stringify(saved).includes('replacement-fixture-secret'));
 }finally{await f.close();}
});

test('S3 SDK signs uploads for R2, AWS virtual hosts and custom path-style services',async()=>{
 const {Readable}=await import('node:stream');const {S3Storage}=await import('../src/s3-storage.js');
 const f=await fixture();try{
  const file=f.dir+'/multi.age';await writeFile(file,'encrypted multi-provider fixture');
  for(const target of [
   {provider:'r2',endpoint:'https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com',region:'auto',forcePathStyle:true},
   {provider:'aws',endpoint:'https://s3.ap-southeast-2.amazonaws.com',region:'ap-southeast-2',forcePathStyle:false},
   {provider:'custom',endpoint:'https://objects.example.com:9443',region:'us-east-1',forcePathStyle:true}
  ]){
   let stored,puts=0;const hostname=new URL(target.endpoint).hostname;
   const storage=new S3Storage({...f.settings,...target},'fixture-secret',{requestHandler:{async handle(request){
    assert.equal(request.hostname,target.forcePathStyle?hostname:'test-bucket.'+hostname);
    assert.equal(request.path,target.forcePathStyle?'/test-bucket/relay-test/wire.age':'/relay-test/wire.age');
    assert.ok(request.headers.authorization.includes('/'+target.region+'/s3/aws4_request'));
    if(request.method==='PUT'){
     puts++;const chunks=[];for await(const chunk of request.body)chunks.push(Buffer.from(chunk));const bytes=Buffer.concat(chunks);
     assert.equal(request.headers['content-md5'],createHash('md5').update(bytes).digest('base64'));
     stored={'content-length':String(bytes.length),'x-amz-meta-sha256':request.headers['x-amz-meta-sha256']};
     return {response:{statusCode:200,headers:{},body:Readable.from([])}};
    }
    return {response:{statusCode:stored?200:404,headers:stored||{},body:Readable.from([])}};
   },destroy(){}}});
   try{assert.equal((await storage.upload(file,'relay-test/wire.age')).bytes,(await stat(file)).size);assert.equal(puts,1);}finally{storage.close();}
  }
 }finally{await f.close();}
});

test('fixed-name uploads create versions and deduplicate a lost response retry',async()=>{
 const {S3Storage}=await import('../src/s3-storage.js');const f=await fixture();try{
  const file=f.dir+'/version.age';const versions=[];let lost=false;
  const client={async send(command){const i=command.input;
   if(command.constructor.name==='GetBucketVersioningCommand')return {Status:'Enabled'};
   if(command.constructor.name==='HeadObjectCommand'){
    const item=i.VersionId?versions.find(v=>v.VersionId===i.VersionId):versions.at(-1);
    if(!item)throw Object.assign(Error(),{$metadata:{httpStatusCode:404}});return item;
   }
   const chunks=[];for await(const c of i.Body)chunks.push(c);const bytes=Buffer.concat(chunks);
   const item={VersionId:'version-'+(versions.length+1),ContentLength:bytes.length,Metadata:i.Metadata};versions.push(item);
   if(lost){lost=false;throw Error('response lost');}return {VersionId:item.VersionId};
  },destroy(){}};
  const storage=new S3Storage(f.settings,'fixture-secret',{client}),key='relay-test/archives/backup.tar.age';
  await writeFile(file,'first encrypted snapshot');
  assert.equal((await storage.upload(file,key,undefined,{versioned:true,backupId:'job-1'})).versionId,'version-1');
  await writeFile(file,'second encrypted snapshot');lost=true;
  await assert.rejects(storage.upload(file,key,undefined,{versioned:true,backupId:'job-2'}));
  assert.equal((await storage.upload(file,key,undefined,{versioned:true,backupId:'job-2'})).versionId,'version-2');
  assert.equal(versions.length,2);
  await writeFile(file,'unexpected changed data');
  await assert.rejects(storage.upload(file,key,undefined,{versioned:true,backupId:'job-2'}),/RemoteObjectConflict/);
 }finally{await f.close();}
});

test('fixed-name uploads stop before writing if versioning is disabled or unreadable',async()=>{
 const {S3Storage}=await import('../src/s3-storage.js');const f=await fixture();try{
  const file=f.dir+'/version.age';await writeFile(file,'snapshot');
  for(const status of [undefined,'Suspended','denied']){
   let writes=0;const storage=new S3Storage(f.settings,'fixture-secret',{client:{async send(command){
    if(command.constructor.name==='GetBucketVersioningCommand'){if(status==='denied')throw Error('permission denied');return {Status:status};}
    writes++;throw Error('must not reach object operations');
   },destroy(){}}});
   await assert.rejects(storage.upload(file,'backup.tar.age',undefined,{versioned:true,backupId:'job'}),status==='denied'?/VersioningCheckFailed/:/BucketVersioningRequired/);
   assert.equal(writes,0);
  }
 }finally{await f.close();}
});

test('worker uses a stable backup name, isolates connection tests and records version IDs',async()=>{
 const f=await fixture();try{
  await f.save({settings:{...f.settings,fixedFileName:true}});let version=0;const keys=[];
  const worker=new BackupWorker({db:f.app.db,backups:f.b,root:f.dir,now:f.now,
   localBackup:async()=>{await writeFile(f.dir+'/relay-version.tar','local snapshot');return 'relay-version.tar';},
   storageFactory:()=>({async upload(file,key,signal,options){assert.equal(options.versioned,true);assert.ok(options.backupId);keys.push(key);return {bytes:10,versionId:'v'+(++version)};},close(){}})});
  await worker.initialize();
  for(const kind of ['backup','backup','test']){const job=await f.b.enqueue(kind);await worker.tick();const row=await f.app.db.prepare('SELECT * FROM backup_jobs WHERE id=?').get(job.id);assert.equal(row.state,'completed');assert.equal(row.remote_version,'v'+version);}
  assert.deepEqual(keys,['relay-test/archives/backup.tar.age','relay-test/archives/backup.tar.age','relay-test/_connection-tests/connection-test.tar.age']);
 }finally{await f.close();}
});
