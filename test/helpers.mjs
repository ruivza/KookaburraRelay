import {createGateway as create} from '../server.js';
import {Database} from '../database.js';
import {createHash} from 'node:crypto';
import {after} from 'node:test';
const schemas=new Set();
export async function createGateway(options){const databaseSchema='test_'+createHash('sha256').update(options.dataDir).digest('hex').slice(0,16);schemas.add(databaseSchema);return create({...options,databaseSchema});}
after(async()=>{if(!schemas.size)return;const db=new Database(process.env.GATEWAY_DATABASE_URL);try{for(const s of schemas)await db.exec(`DROP SCHEMA IF EXISTS ${s} CASCADE`);}finally{await db.close();}});
