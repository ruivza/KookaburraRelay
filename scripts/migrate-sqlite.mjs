import {DatabaseSync} from 'node:sqlite';
import {Database} from '../src/database.js';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
export const tables=['configuration','applications','app_channels','registrations','delivery_jobs','gateway_logs','gateway_runs','gateway_samples','gateway_probes','limits'];
function checksum(rows){return createHash('sha256').update(JSON.stringify(rows.map(row=>Object.fromEntries(Object.entries(row).sort(([a],[b])=>a.localeCompare(b)))).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b))))).digest('hex');}
export async function migrate(source,db){
  const sqlite=new DatabaseSync(source,{readOnly:true});
  try {
    const snapshot={};
    for(const table of tables){if(!sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table))throw Error('Source schema must first be upgraded: missing '+table);snapshot[table]=sqlite.prepare(`SELECT * FROM ${table}`).all();}
    await db.initialize();
    return await db.transaction(async()=>{
      await db.query('SELECT pg_advisory_xact_lock(72841101)');
      const locked=await db.prepare('SELECT pg_try_advisory_xact_lock(hashtext(current_schema()),72841102) locked').get();
      if(!locked.locked)throw Error('Stop the target gateway before migration');
      if(await db.prepare('SELECT 1 FROM schema_migrations WHERE version>=2').get())throw Error('Target already initialized; refusing to overwrite');
      for(const table of [...tables,'admin_security','admin_sessions'])if((await db.prepare(`SELECT count(*) n FROM ${table}`).get()).n)throw Error('Target must be empty: '+table);
      const report=[];
      for(const table of tables){
        const rows=snapshot[table];
        for(const row of rows){const cols=Object.keys(row);if(cols.some(c=>!/^\w+$/.test(c)))throw Error('Invalid source column');await db.prepare(`INSERT INTO ${table} (${cols.join(',')}) VALUES(${cols.map(()=>'?').join(',')})`).run(...Object.values(row));}
        const imported=await db.prepare(`SELECT * FROM ${table}`).all();
        if(checksum(rows)!==checksum(imported))throw Error('Migration verification failed: '+table);
        report.push({table,rows:rows.length,verified:true});
      }
      await db.exec("SELECT setval(pg_get_serial_sequence('gateway_logs','id'),GREATEST(COALESCE((SELECT max(id) FROM gateway_logs),0),1),(SELECT count(*)>0 FROM gateway_logs)); INSERT INTO schema_migrations VALUES(2),(3)");
      return report;
    });
  }finally{sqlite.close();}
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const source=process.argv[2];if(!source)throw Error('Usage: node --env-file=.env scripts/migrate-sqlite.mjs /path/to/stopped-gateway.sqlite');
  const db=new Database(process.env.GATEWAY_DATABASE_URL,process.env.GATEWAY_DATABASE_SCHEMA||'public');
  try{console.log(JSON.stringify(await migrate(source,db),null,2));}finally{await db.close();}
}
