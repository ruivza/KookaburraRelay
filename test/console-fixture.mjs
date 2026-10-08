// Isolated browser acceptance fixture: no real providers, keys or devices.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGateway } from "../src/server.js";
import { Database } from "../src/database.js";
import { randomUUID } from "node:crypto";
const databaseSchema="test_console_"+randomUUID().replaceAll("-","");
const dir=mkdtempSync(join(tmpdir(),'perch-console-browser-'));
let proof;
const app=(await createGateway({dataDir:dir,databaseSchema,adminToken:'console-fixture-token-for-local-testing-only',
  providerFactory:()=>({async send(_d,_t,p){if(p.perchRegistration)proof=p.perchRegistration;return {status:200};},close(){}}),
  fcmFactory:()=>({async send(_d,_t,m){if(m.proof)proof=m.proof;return {status:200};},close(){}})}));
(await app.applications.update('perch-mail',{name:'Perch Mail',enabled:true,apns:{privateKey:'fixture',keyId:'ABCDEFGHIJ',teamId:'0123456789',topic:'com.example.perch',environment:'both'}}));
(await app.applications.create({id:'notes',name:'Notes'}));
await new Promise(resolve=>app.server.listen(43221,process.env.TEST_HOST||'127.0.0.1',resolve));
const post=(path,body,credential='')=>fetch('http://127.0.0.1:43221'+path,{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+credential},body:JSON.stringify(body)});
await post('/v1/registrations',{deviceId:'test-iphone',serverId:'fixture-server',environment:'sandbox',deviceToken:'ab'.repeat(32),nonce:'n'.repeat(40)});
const grant=await (await post('/v1/registrations/'+proof.id+'/confirm',proof)).json();
await post('/v1/notify',{deviceId:'test-iphone',serverId:'fixture-server',kind:'sync'},grant.credential);
(await app.monitor.sample());
console.log('Isolated console fixture ready at http://127.0.0.1:43221');
for(const signal of ['SIGINT','SIGTERM'])process.once(signal,async()=>{await app.close();const cleanup=new Database(process.env.GATEWAY_DATABASE_URL);await cleanup.exec(`DROP SCHEMA ${databaseSchema} CASCADE`);await cleanup.close();rmSync(dir,{recursive:true,force:true});process.exit(0);});
