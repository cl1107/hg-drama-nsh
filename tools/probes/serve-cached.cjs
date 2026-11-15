// [DEBUG-playback-validation] Serve the previously verified media for visual acceptance only.
'use strict';
const fs=require('node:fs/promises');
const crypto=require('node:crypto');
const {createService}=require('../../service/server.cjs');
(async()=> {
 const {preparedPlayback}=require('../../.tmp/prepared-playback.ts');
 const data=await fs.readFile('.tmp/media/first.mp4');
 if(crypto.createHash('sha256').update(data).digest('hex')!=='d9684e0cb60537f8377a8dfd1961e20e9ee35eb1fa881aa111d02d2815912694')throw new Error('缓存与已验证媒体摘要不符');
 const {server,token}=createService({prepareMedia:async({seriesId,episodeId})=>{
  if(seriesId!==preparedPlayback.seriesId || episodeId && episodeId!==preparedPlayback.episode.episodeId)throw new Error('此验证缓存仅包含已验证第一集');
  return {...preparedPlayback,data};
 }});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const response=await fetch(`http://127.0.0.1:${server.address().port}/play`,{method:'POST',headers:{Authorization:'Bearer '+token},body:JSON.stringify({seriesId:preparedPlayback.seriesId})});
 if(!response.ok)throw new Error('缓存验证服务准备失败');
 const result=await response.json();
 await fs.writeFile('.tmp/prepared-playback.ts',`export const preparedPlayback = ${JSON.stringify(result)};\n`,{mode:0o600});
 console.log('已校验缓存摘要并恢复原生画面验证资源；本次不代表重新在线取源成功');
 for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>{server.close();process.exit(0);});
})().catch(error=>{console.error(error.message);process.exitCode=1;});
