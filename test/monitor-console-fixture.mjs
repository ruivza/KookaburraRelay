// Isolated UI fixture. All B2 operations are mocked; no real credentials or uploads.
import {createGateway} from '../server.js';
import {BackupWorker} from '../backup-worker.js';
import {Database} from '../database.js';
import {mkdtempSync,rmSync} from 'node:fs';
import {writeFile,stat} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
const dataDir=mkdtempSync('/tmp/b2-console-'),schema='test_b2_console_'+randomUUID().replaceAll('-','');
const app=await createGateway({dataDir,databaseSchema:schema,adminToken:'console-fixture-token-for-local-testing-only',autoStart:false});
// Deterministic monitoring samples, including an intentional collection gap.
const sampleNow=Date.now();
for(let i=0;i<60;i++){
 if(i>=25&&i<=30)continue;
 await app.db.prepare('INSERT INTO gateway_samples VALUES(?,?,?,?,?,?,?)').run(sampleNow-(60-i)*60000,(80+i%13*3)*1048576,40*1048576,i%9,i%3,i%9?12+i%12*2:0,i%5);
}
const worker=new BackupWorker({db:app.db,backups:app.backups,root:dataDir,localBackup:async()=>{const file='relay-fixture-'+Date.now()+'.tar';await writeFile(dataDir+'/'+file,'isolated fake backup');return file;},storageFactory:()=>({async upload(file){return {bytes:(await stat(file)).size};},close(){}})});
await worker.initialize();
let busy=false;
const timer=setInterval(async()=>{if(busy)return;busy=true;try{await worker.heartbeat();await worker.tick();}finally{busy=false;}},1000);
await new Promise(r=>app.server.listen(43221,'0.0.0.0',r));
console.log('Isolated B2 console fixture ready');
for(const signal of ['SIGTERM','SIGINT'])process.once(signal,async()=>{clearInterval(timer);worker.stop();while(busy)await new Promise(r=>setTimeout(r,10));await app.close();const db=new Database(process.env.GATEWAY_DATABASE_URL);await db.exec(`DROP SCHEMA ${schema} CASCADE`);await db.close();rmSync(dataDir,{recursive:true,force:true});process.exit(0);});
