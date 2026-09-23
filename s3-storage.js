import {S3Client,PutObjectCommand,HeadObjectCommand,GetBucketVersioningCommand} from '@aws-sdk/client-s3';
import {createReadStream} from 'node:fs';
import {stat} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {validateTarget} from './storage-target.js';
export class S3Storage {
  constructor(settings,applicationKey,{client,requestHandler}={}){
    settings=validateTarget(settings);
    this.settings=settings;
    this.client=client||new S3Client({endpoint:settings.endpoint,region:settings.region,forcePathStyle:settings.forcePathStyle,maxAttempts:1,
      requestChecksumCalculation:'WHEN_REQUIRED',responseChecksumValidation:'WHEN_REQUIRED',
      credentials:{accessKeyId:settings.keyId,secretAccessKey:applicationKey},requestHandler:requestHandler||{connectionTimeout:10000,requestTimeout:120000}});
  }
  async upload(file,key,signal,{versioned=false,backupId}={}){
    if(versioned&&(!backupId||typeof backupId!=='string'))throw Error('RemoteVerificationFailed');
    const {size}=await stat(file);
    if(size>5*1024**3)throw Error('BackupTooLarge');
    const sha=createHash('sha256'),md5=createHash('md5');
    for await(const chunk of createReadStream(file,{signal})){sha.update(chunk);md5.update(chunk);}
    const digest=sha.digest('hex'),options={Bucket:this.settings.bucket,Key:key};
    const requestSignal=AbortSignal.any([signal||new AbortController().signal,AbortSignal.timeout(600000)]);
    const verify=response=>response.ContentLength===size&&response.Metadata?.sha256===digest&&(!versioned||response.Metadata?.['backup-id']===backupId);
    if(versioned){
      let state;try{state=await this.client.send(new GetBucketVersioningCommand({Bucket:this.settings.bucket}),{abortSignal:requestSignal});}catch{throw Error('VersioningCheckFailed');}
      if(state.Status!=='Enabled')throw Error('BucketVersioningRequired');
    }
    const result=response=>{
      if(versioned&&(!response.VersionId||response.VersionId==='null'))throw Error('BucketVersioningRequired');
      return {bytes:size,...(response.VersionId?{versionId:response.VersionId}:{})};
    };
    try{
      const previous=await this.client.send(new HeadObjectCommand(options),{abortSignal:requestSignal});
      if(verify(previous))return result(previous);
      if(!versioned||previous.Metadata?.['backup-id']===backupId)throw Error('RemoteObjectConflict');
    }catch(error){if(error.$metadata?.httpStatusCode!==404&&error.name!=='NotFound')throw error;}
    const stream=createReadStream(file,{signal:requestSignal});
    let uploaded;
    try {uploaded=await this.client.send(new PutObjectCommand({...options,Body:stream,ContentLength:size,ContentMD5:md5.digest('base64'),ContentType:'application/octet-stream',Metadata:{sha256:digest,...(versioned?{'backup-id':backupId}:{})}}),{abortSignal:requestSignal});}
    finally{stream.destroy();}
    const verified=await this.client.send(new HeadObjectCommand({...options,...(uploaded.VersionId?{VersionId:uploaded.VersionId}:{})}),{abortSignal:requestSignal});
    if(!verify(verified))throw Error('RemoteVerificationFailed');
    return result(verified);
  }
  close(){this.client.destroy();}
}
