import {test} from 'node:test';import assert from 'node:assert/strict';import {DatabaseSync} from 'node:sqlite';import {readFileSync,mkdtempSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';import {randomUUID} from 'node:crypto';import {Database} from '../database.js';import {migrate} from '../migrate-sqlite.mjs';
test('SQLite import preserves exact rows and refuses initialized targets',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'relay-import-')),source=join(dir,'gateway.sqlite'),schema='test_import_'+randomUUID().replaceAll('-','');const db=new Database(process.env.GATEWAY_DATABASE_URL,schema);const sqlite=new DatabaseSync(source);
 sqlite.exec(readFileSync(new URL('../schema.sql',import.meta.url),'utf8').replace(/^ALTER TABLE .*;$/gm,'').replace(/BIGSERIAL/g,'INTEGER').replace(/JSONB/g,'TEXT').replace(/ ON CONFLICT DO NOTHING/g,''));
 sqlite.prepare('INSERT INTO applications VALUES(?,?,1,?,?)').run('notes','测试应用','revision','encrypted-private-key');
 sqlite.prepare('INSERT INTO gateway_logs VALUES(?,?,?,?,?,?,?,?,?)').run(42,1790000000000,'audit','test','notes','apns',200,5,'req');sqlite.close();
 try{const report=await migrate(source,db);assert.ok(report.every(r=>r.verified));assert.equal((await db.prepare('SELECT name FROM applications WHERE id=?').get('notes')).name,'测试应用');
 await db.prepare('INSERT INTO gateway_logs(time,kind,action,status,duration,request_id) VALUES(?,?,?,?,?,?)').run(1790000000001,'audit','next',200,1,'next');assert.equal((await db.prepare('SELECT max(id) n FROM gateway_logs').get()).n,43);
 await assert.rejects(migrate(source,db),/already initialized/);
 }finally{await db.exec(`DROP SCHEMA ${schema} CASCADE`);await db.close();rmSync(dir,{recursive:true,force:true});}
});
