const fail=message=>{throw Object.assign(Error(message),{status:400});};
export function storageSettings(s){
 const provider=s.provider??'b2';
 const b2Region=/^https:\/\/s3\.([a-z0-9-]+)\.backblazeb2\.com$/.exec(s.endpoint||'')?.[1];
 return {...s,fixedFileName:s.fixedFileName??false,provider,region:s.region||(provider==='b2'?b2Region||'':provider==='r2'?'auto':'us-east-1'),forcePathStyle:s.forcePathStyle??provider!=='aws'};
}
export function validateTarget(input){
 const s=storageSettings(input);
 if(!['b2','r2','aws','custom'].includes(s.provider))fail('Invalid storage provider');
 let url;try{url=new URL(s.endpoint);}catch{fail('Use an HTTPS S3 endpoint');}
 if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash||url.pathname!=='/'||s.endpoint.length>250||!url.hostname.includes('.')||url.hostname.endsWith('.')||url.hostname==='localhost'||/^[\d.]+$/.test(url.hostname)||url.hostname.includes(':'))fail('Use an HTTPS S3 endpoint');
 if(s.provider==='b2'&&!/^s3\.[a-z0-9]+(?:-[a-z0-9]+)+\.backblazeb2\.com$/.test(url.hostname))fail('Use a Backblaze B2 HTTPS S3 endpoint');
 if(s.provider==='r2'&&!/^[a-f0-9]{32}(?:\.(?:eu|fedramp))?\.r2\.cloudflarestorage\.com$/.test(url.hostname))fail('Use a Cloudflare R2 S3 endpoint');
 if(s.provider==='aws'&&!/^s3(?:[.-][a-z0-9-]+)?\.amazonaws\.com(?:\.cn)?$/.test(url.hostname))fail('Use an AWS S3 endpoint');
 if(s.provider!=='custom'&&url.port)fail('Use an HTTPS S3 endpoint');
 if(typeof s.region!=='string'||! /^[a-z0-9][a-z0-9-]{0,62}$/.test(s.region))fail('Invalid S3 region');
 if(s.provider==='b2'&&s.region!==url.hostname.split('.')[1])fail('B2 region must match endpoint');
 if(s.provider==='r2'&&s.region!=='auto')fail('R2 region must be auto');
 if(typeof s.fixedFileName!=='boolean')fail('Invalid backup filename mode');
 if(typeof s.forcePathStyle!=='boolean')fail('Invalid S3 addressing style');
 if(typeof s.bucket!=='string'||!(s.provider==='b2'?/^[A-Za-z0-9][A-Za-z0-9-]{4,61}[A-Za-z0-9]$/:/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/).test(s.bucket)||s.bucket.includes('..')||/^\d+\.\d+\.\d+\.\d+$/.test(s.bucket))fail('Invalid S3 bucket name');
 if(!/^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/.test(s.prefix)||s.prefix.length>200)fail('Invalid backup prefix');
 if(typeof s.keyId!=='string'||!/^[A-Za-z0-9_+=.@-]{3,128}$/.test(s.keyId))fail('Invalid S3 Access Key ID');
 return s;
}
