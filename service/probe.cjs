'use strict';
const {fetchAppPlayUrl}=require('./vendor/hongguo/app-source');
const {bytes}=require('./transport.cjs');
const fs=require('node:fs/promises');
(async()=> {
 const variant=await fetchAppPlayUrl(process.argv[2] || '7503780574541122622');
 process.stdout.write(JSON.stringify({stage:'model',codec:variant.codec,quality:variant.quality,encrypted:!!variant.contentKey,variants:variant.variants.length,host:new URL(variant.url).hostname})+'\n');
 const response=await bytes(variant.url,{domains:['qznovelvod.com','fqnovelvod.com','douyinvod.com'],headers:{'User-Agent':variant.userAgent},maxBytes:256*1024*1024,timeout:60000});
 if(response.status!==200)throw new Error('媒体 HTTP '+response.status);
 await fs.mkdir('.tmp/media',{recursive:true});
 if(variant.contentKey){
  const {decryptMp4Buffer}=require('../src/media/cenc.cjs');
  const clear=decryptMp4Buffer(response.data,Buffer.from(variant.contentKey,'hex'));
  await fs.writeFile('.tmp/media/first.mp4',clear,{mode:0o600});
 } else await fs.writeFile('.tmp/media/first.mp4',response.data,{mode:0o600});
 process.stdout.write(JSON.stringify({stage:'media',bytes:response.data.length,output:'.tmp/media/first.mp4'})+'\n');
})().catch(error=>{process.stderr.write(JSON.stringify({stage:'probe',code:error.code,message:error.message,registrationFailure:error.registrationFailure})+'\n');process.exitCode=1});
