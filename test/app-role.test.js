import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {randomBytes} from 'node:crypto';
import pg from 'pg';
import {createGateway} from '../src/server.js';

const adminToken='app-role-test-admin-'.repeat(3);
const transfer=readFileSync(new URL('../ops/relay-app-role.sql',import.meta.url),'utf8');

test('the app role SQL hands only the gateway schema to a non-superuser role that can start and upgrade the gateway',{timeout:30000},async()=>{
 const suffix=randomBytes(6).toString('hex'),role='relay_app_'+suffix,password=randomBytes(16).toString('hex');
 const legacy='test_role_'+suffix,fresh='test_fresh_'+suffix,other='test_other_'+suffix;
 const dirs=[mkdtempSync('/tmp/relay-app-role-'),mkdtempSync('/tmp/relay-app-role-')];
 const admin=new pg.Client({connectionString:process.env.GATEWAY_DATABASE_URL});await admin.connect();
 const url=new URL(process.env.GATEWAY_DATABASE_URL);url.username=role;url.password=password;
 const superuser=(await admin.query('SELECT current_user AS name')).rows[0].name;
 const run=async(appRole,schema)=>{
  await admin.query("SELECT set_config('relay.app_role',$1,false),set_config('relay.app_schema',$2,false)",[appRole,schema]);
  await admin.query(transfer);
 };
 const owners=async schema=>(await admin.query(`
  SELECT 'schema' AS kind,nspname AS name,nspowner::regrole::text AS owner FROM pg_namespace WHERE nspname=$1
  UNION ALL SELECT 'relation',relname,relowner::regrole::text FROM pg_class WHERE relnamespace=$1::regnamespace
  UNION ALL SELECT 'routine',proname,proowner::regrole::text FROM pg_proc WHERE pronamespace=$1::regnamespace
  UNION ALL SELECT 'type',typname,typowner::regrole::text FROM pg_type WHERE typnamespace=$1::regnamespace`,[schema])).rows;
 let app;
 try{
  // An installation from before the role existed: the superuser owns everything.
  app=await createGateway({databaseSchema:legacy,dataDir:dirs[0],adminToken,autoStart:false});
  await app.close();app=null;
  await admin.query(`CREATE VIEW ${legacy}.legacy_view AS SELECT 1 AS one;CREATE SEQUENCE ${legacy}.legacy_sequence;
   CREATE TYPE ${legacy}.legacy_state AS ENUM ('on');CREATE DOMAIN ${legacy}.legacy_text AS text;
   CREATE FUNCTION ${legacy}.legacy_one() RETURNS integer LANGUAGE sql AS 'SELECT 1';
   CREATE SCHEMA ${other};CREATE TABLE ${other}.untouched(id BIGSERIAL PRIMARY KEY)`);
  await admin.query(`CREATE ROLE ${role} LOGIN PASSWORD '${password}'`);
  await assert.rejects(run(superuser,legacy),/must exist, log in and hold no administrative attributes/);
  await run(role,legacy);await run(role,legacy);
  const moved=await owners(legacy);
  assert.ok(moved.filter(o=>o.kind==='relation').length>40);
  assert.ok(['schema','routine','type'].every(kind=>moved.some(o=>o.kind===kind)));
  assert.deepEqual(moved.filter(o=>o.owner!==role),[]);
  assert.deepEqual([...new Set((await owners(other)).map(o=>o.owner))],[superuser]);

  for(const attempt of [1,2]){
   app=await createGateway({databaseUrl:url.href,databaseSchema:legacy,dataDir:dirs[0],adminToken,autoStart:false});
   assert.equal((await app.db.prepare('SELECT current_user AS name').get()).name,role);
   assert.ok(Array.isArray(await app.applications.list()),'attempt '+attempt);
   await app.close();app=null;
  }
  app=await createGateway({databaseUrl:url.href,databaseSchema:legacy,dataDir:dirs[0],adminToken,autoStart:false});
  // Future releases add columns at startup; the owner may, and server programs stay out of reach.
  await app.db.exec('ALTER TABLE backup_jobs ADD COLUMN IF NOT EXISTS role_test TEXT');
  await assert.rejects(app.db.exec("COPY (SELECT 1) TO PROGRAM 'true'"),/permission denied/);
  await assert.rejects(app.db.exec(`SELECT * FROM ${other}.untouched`),/permission denied/);
  await app.close();app=null;

  // A new installation: the schema does not exist until the role is set up.
  await run(role,fresh);
  assert.deepEqual(await owners(fresh),[{kind:'schema',name:fresh,owner:role}]);
  app=await createGateway({databaseUrl:url.href,databaseSchema:fresh,dataDir:dirs[1],adminToken,autoStart:false});
  assert.ok(Array.isArray(await app.applications.list()));
 }finally{
  await app?.close();
  try{
   await admin.query(`DROP SCHEMA IF EXISTS ${legacy} CASCADE;DROP SCHEMA IF EXISTS ${fresh} CASCADE;DROP SCHEMA IF EXISTS ${other} CASCADE`);
   if((await admin.query('SELECT 1 FROM pg_roles WHERE rolname=$1',[role])).rowCount)await admin.query(`DROP OWNED BY ${role};DROP ROLE ${role}`);
  }finally{
   await admin.end();
   for(const dir of dirs)rmSync(dir,{recursive:true,force:true});
  }
 }
});
