import QRCode from 'qrcode';
import { randomBytes, createHash, createHmac, timingSafeEqual, scrypt } from 'node:crypto';
import { promisify } from 'node:util';
const derive=promisify(scrypt), digest=s=>createHash('sha256').update(s).digest('hex');
const fail=(status,message)=>{throw Object.assign(Error(message),{status});};
const equal=(a,b)=>a.length===b.length&&timingSafeEqual(Buffer.from(a),Buffer.from(b));
const alphabet='ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export function base32(bytes){let bits=0,value=0,out='';for(const byte of bytes){value=(value<<8)|byte;bits+=8;while(bits>=5){out+=alphabet[(value>>>(bits-5))&31];bits-=5;}}if(bits)out+=alphabet[(value<<(5-bits))&31];return out;}
function decode(secret){let bits=0,value=0,out=[];for(const c of secret){value=(value<<5)|alphabet.indexOf(c);bits+=5;if(bits>=8){out.push((value>>>(bits-8))&255);bits-=8;}}return Buffer.from(out);}
export function totp(secret,time=Date.now()){const counter=Buffer.alloc(8);counter.writeBigUInt64BE(BigInt(Math.floor(time/30000)));const h=createHmac('sha1',decode(secret)).update(counter).digest();const o=h[19]&15;return String((h.readUInt32BE(o)&0x7fffffff)%1000000).padStart(6,'0');}
async function tokenHash(value){const salt=randomBytes(16).toString('hex');return salt+':'+(await derive(value,salt,32)).toString('hex');}
async function verifyToken(value,stored){if(typeof value!=='string'||value.length>512)return false;const [salt,hash]=stored.split(':');return equal((await derive(value,salt,32)).toString('hex'),hash);}
export class Security {
  constructor({db,seal,open,now=Date.now}){Object.assign(this,{db,seal,open,now});}
  async initialize(token){await this.db.prepare('INSERT INTO admin_security(id,token_hash) VALUES(1,?) ON CONFLICT DO NOTHING').run(await tokenHash(token));}
  async row(){return this.db.prepare('SELECT * FROM admin_security WHERE id=1 FOR UPDATE').get();}
  async factor(row,code){
    code=typeof code==='string'?code.trim():'';
    if(!row.totp_secret)return;
    if(/^\d{6}$/.test(code)){
      const secret=this.open(row.totp_secret),step=Math.floor(this.now()/30000);
      for(const offset of [0,-1,1])if(step+offset>row.last_step&&equal(totp(secret,(step+offset)*30000),code)){
        await this.db.prepare('UPDATE admin_security SET last_step=? WHERE id=1').run(step+offset);return;
      }
    } else {
      const hashes=row.recovery_hashes,hash=digest(code.toLowerCase().replace(/\s/g,''));const index=hashes.findIndex(h=>equal(h,hash));
      if(index>=0){hashes.splice(index,1);await this.db.prepare('UPDATE admin_security SET recovery_hashes=? WHERE id=1').run(JSON.stringify(hashes));return;}
    }
    fail(403,'Invalid or already used verification code');
  }
  async reauthenticate(row,body){if(!await verifyToken(body.currentToken,row.token_hash))fail(403,'Invalid current token');await this.factor(row,body.code);}
  async login(body){return this.db.transaction(async()=>{
    const row=await this.row();if(!await verifyToken(body.token,row.token_hash))fail(401,'Unauthorized');
    if(row.totp_secret&&!body.code)return {requiresSecondFactor:true};
    await this.factor(row,body.code);
    const session=randomBytes(32).toString('base64url'),expires=this.now()+8*3600000;
    await this.db.prepare('DELETE FROM admin_sessions WHERE expires<=?').run(this.now());
    await this.db.prepare('INSERT INTO admin_sessions VALUES(?,?)').run(digest(session),expires);
    return {session,expires};
  });}
  async authenticate(value){if(!await this.db.prepare('SELECT 1 FROM admin_sessions WHERE hash=? AND expires>?').get(digest(value),this.now()))fail(401,'Unauthorized');}
  async logout(value){await this.db.prepare('DELETE FROM admin_sessions WHERE hash=?').run(digest(value));}
  async status(){const row=await this.db.prepare('SELECT totp_secret,recovery_hashes FROM admin_security WHERE id=1').get();return {twoFactorEnabled:!!row.totp_secret,recoveryCodesRemaining:row.recovery_hashes.length};}
  async changeToken(body){
    if(typeof body.newToken!=='string'||body.newToken.length<32||body.newToken.length>256||/\s/.test(body.newToken))fail(400,'New token must contain 32–256 characters without spaces');
    return this.db.transaction(async()=>{const row=await this.row();await this.reauthenticate(row,body);if(await verifyToken(body.newToken,row.token_hash))fail(400,'New token must differ from current token');await this.db.prepare('UPDATE admin_security SET token_hash=?,pending_secret=NULL,pending_until=NULL WHERE id=1').run(await tokenHash(body.newToken));await this.db.exec('DELETE FROM admin_sessions');return {signInAgain:true};});
  }
  async setup(body){return this.db.transaction(async()=>{
    const row=await this.row();if(row.totp_secret)fail(409,'Two-step verification is already enabled');await this.reauthenticate(row,body);
    const secret=base32(randomBytes(20));await this.db.prepare('UPDATE admin_security SET pending_secret=?,pending_until=? WHERE id=1').run(this.seal(secret),this.now()+600000);
    const uri='otpauth://totp/Kookaburra%20Relay:Admin?secret='+secret+'&issuer=Kookaburra%20Relay&algorithm=SHA1&digits=6&period=30';
    return {secret,qr:await QRCode.toDataURL(uri,{width:220,margin:2})};
  });}
  async confirm(body){return this.db.transaction(async()=>{
    const row=await this.row();if(row.totp_secret||!row.pending_secret||row.pending_until<this.now())fail(400,'Setup expired; start again');
    if(!await verifyToken(body.currentToken,row.token_hash))fail(403,'Invalid current token');
    const codes=Array.from({length:10},()=>randomBytes(10).toString('hex').match(/.{1,5}/g).join('-'));
    await this.factor({...row,totp_secret:row.pending_secret,last_step:-1},body.code);
    await this.db.prepare('UPDATE admin_security SET totp_secret=pending_secret,pending_secret=NULL,pending_until=NULL,recovery_hashes=? WHERE id=1').run(JSON.stringify(codes.map(digest)));
    await this.db.exec('DELETE FROM admin_sessions');return {recoveryCodes:codes,signInAgain:true};
  });}
  async disable(body){return this.db.transaction(async()=>{const row=await this.row();await this.reauthenticate(row,body);await this.db.exec("UPDATE admin_security SET totp_secret=NULL,pending_secret=NULL,pending_until=NULL,last_step=-1,recovery_hashes='[]' WHERE id=1; DELETE FROM admin_sessions");return {signInAgain:true};});}
}
