// Isolated UI fixture. All B2 operations are mocked; no real credentials or uploads.
import {createGateway} from '../src/server.js';
import {BackupWorker} from '../src/backup-worker.js';
import {Database} from '../src/database.js';
import {mkdtempSync,rmSync} from 'node:fs';
import {writeFile,stat} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
const dataDir=mkdtempSync('/tmp/b2-console-'),schema='test_b2_console_'+randomUUID().replaceAll('-','');
const app=await createGateway({dataDir,databaseSchema:schema,adminToken:'console-fixture-token-for-local-testing-only',autoStart:false});
// Deterministic monitoring samples, including an intentional collection gap.
const sampleNow=Date.now();
for(let i=0;i<60;i++){
 if(i>=25&&i<=30)continue;
 await app.db.prepare('INSERT INTO gateway_queue_samples VALUES(?,?,?,?,?)').run(sampleNow-(60-i)*60000,i%5,i%3,i%2,i*10);
 await app.db.prepare('INSERT INTO gateway_samples VALUES(?,?,?,?,?,?,?)').run(sampleNow-(60-i)*60000,(80+i%13*3)*1048576,40*1048576,i%9,i%3,i%9?12+i%12*2:0,i%5);
}
for(let i=0;i<36;i++){
 const time=sampleNow-i*1800000;
 await app.db.prepare('INSERT INTO delivery_jobs(id,registration_id,app_id,channel,device_id,mode,state,created,updated,next_at,expires,reason) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run('fixture-'+i,'fixture','perch-mail',i%2?'apns':'fcm','fixture','async',i%7===0?'failed':i%11===0?'unknown':'accepted',time,time,time,time+86400000,i%7===0?'AuthenticationError':'');
}
const worker=new BackupWorker({db:app.db,backups:app.backups,root:dataDir,localBackup:async()=>{const file='relay-fixture-'+Date.now()+'.tar';await writeFile(dataDir+'/'+file,'isolated fake backup');return file;},storageFactory:()=>({async upload(file){return {bytes:(await stat(file)).size};},close(){}})});
await worker.initialize();
let busy=false;
const timer=setInterval(async()=>{if(busy)return;busy=true;try{await worker.heartbeat();await worker.tick();}finally{busy=false;}},1000);
await new Promise(r=>app.server.listen(43221,'0.0.0.0',r));
console.log('Isolated B2 console fixture ready');
for(const signal of ['SIGTERM','SIGINT'])process.once(signal,async()=>{clearInterval(timer);worker.stop();while(busy)await new Promise(r=>setTimeout(r,10));await app.close();const db=new Database(process.env.GATEWAY_DATABASE_URL);await db.exec(`DROP SCHEMA ${schema} CASCADE`);await db.close();rmSync(dataDir,{recursive:true,force:true});process.exit(0);});
