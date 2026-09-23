import {spawn} from 'node:child_process';
import {rename,rm} from 'node:fs/promises';
export function ageProcess(args, {signal, timeout=600000} = {}) {
  return new Promise((resolve,reject)=>{
    const child=spawn('age',args,{stdio:['ignore','ignore','ignore'],signal});
    const timer=setTimeout(()=>child.kill('SIGKILL'),timeout);
    child.on('error',()=>{clearTimeout(timer);reject(Error('EncryptionFailed'));});
    child.on('exit',code=>{clearTimeout(timer);code===0?resolve():reject(Error('EncryptionFailed'));});
  });
}
export async function validateRecipient(value) {
  if(typeof value!=='string'||!/^age1[0-9a-z]{58}$/.test(value)) throw Object.assign(Error('Invalid age public key'),{status:400});
  try {await ageProcess(['--encrypt','--recipient',value,'/dev/null'],{timeout:5000});}
  catch {throw Object.assign(Error('Invalid age public key'),{status:400});}
}
export async function encryptFile(input,output,recipient,signal) {
  const partial=output+'.partial';
  try {await ageProcess(['--encrypt','--recipient',recipient,'--output',partial,input],{signal});await rename(partial,output);}
  finally {await rm(partial,{force:true});}
}
