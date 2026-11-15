// [DEBUG-playback-validation] Reproducible live chain; retains no content key or upstream signed URL.
'use strict';
const fs=require('node:fs/promises');
const {serviceConfig}=require('../.tmp/service-config.ts');
(async()=>{
 const response=await fetch(serviceConfig.baseUrl+'/play',{method:'POST',headers:{Authorization:'Bearer '+serviceConfig.token,'Content-Type':'application/json'},body:JSON.stringify({seriesId:'7503745441910017049'})});
 const result=await response.json();
 if(!response.ok)throw new Error(result.code+': '+result.message);
 await fs.writeFile('.tmp/prepared-playback.ts',`export const preparedPlayback = ${JSON.stringify(result)};\n`,{mode:0o600});
 const media=await fetch(result.mediaUrl,{headers:{Range:'bytes=0-1023'}});
 if(media.status!==206||(await media.arrayBuffer()).byteLength!==1024)throw new Error('Range verification failed');
 console.log(JSON.stringify({stage:'service',title:result.title,episode:result.episode.index,episodes:result.episodes.length,codec:result.codec,quality:result.quality,encrypted:result.encrypted,rangeStatus:media.status}));
})().catch(error=>{console.error(error.message);process.exitCode=1;});
