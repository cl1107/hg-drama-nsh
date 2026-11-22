'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {createService}=require('./server.cjs');
const {downloadFromVariants}=require('./playback.cjs');
const {parseDanmakuResponse}=require('./danmaku.cjs');
const {parseRange}=require('./range.cjs');
const {publicAddress,allowedUrl}=require('./transport.cjs');
test('range handles exact, open, suffix and invalid requests',()=>{
 assert.deepEqual(parseRange('bytes=2-4',10),{start:2,end:4,partial:true});
 assert.deepEqual(parseRange('bytes=7-',10),{start:7,end:9,partial:true});
 assert.deepEqual(parseRange('bytes=-4',10),{start:6,end:9,partial:true});
 for(const range of ['bytes=10-','bytes=4-2','bytes=-0','bytes=0-1,4-5','bytes=9007199254740992-'])assert.equal(parseRange(range,10),null);
});
test('upstream targets require HTTPS, approved domains and public DNS',()=>{
 for(const address of ['127.0.0.1','10.0.0.1','172.16.1.1','192.168.1.1','169.254.1.1','100.96.1.1','::1','::ffff:127.0.0.1','fd00::1'])assert.equal(publicAddress(address),false);
 assert.equal(publicAddress('8.8.8.8'),true);
 for(const url of ['https://fqnovel.com.evil.test/','http://fqnovel.com','https://user:pass@fqnovel.com','https://fqnovel.com:9999'])assert.throws(()=>allowedUrl(url,['fqnovel.com']));
});
test('service authorizes controls and serves only opaque resources with Range',async t=>{
 let calls=0;
 const {server}=createService({token:'test-only-secret',prepareMedia:async()=>{calls++;return {title:'test',data:Buffer.from('0123456789')};}});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve)); t.after(()=>new Promise(resolve=>server.close(resolve)));
 const base=`http://127.0.0.1:${server.address().port}`;
 assert.equal((await fetch(base+'/play',{method:'POST',body:'{}'})).status,401);
 assert.equal((await fetch(base+'/play',{method:'POST',headers:{Authorization:'Bearer test-only-secret',Origin:'https://evil.test'},body:'{}'})).status,403);
 const response=await fetch(base+'/play',{method:'POST',headers:{Authorization:'Bearer test-only-secret'},body:JSON.stringify({seriesId:'123'})});
 assert.equal(response.status,200); const result=await response.json(); assert.equal(calls,1);
 const part=await fetch(result.mediaUrl,{headers:{Range:'bytes=2-4'}});
 assert.equal(part.status,206); assert.equal(part.headers.get('content-range'),'bytes 2-4/10');assert.equal(await part.text(),'234');
 const head=await fetch(result.mediaUrl,{method:'HEAD'});assert.equal(head.headers.get('content-length'),'10');assert.equal(await head.text(),'');
 assert.equal((await fetch(result.mediaUrl,{headers:{Range:'bytes=10-'}})).status,416);
 assert.equal((await fetch(base+'/media/not-a-session')).status,401);
});
test('service enforces validation and auth boundaries on detail, search, auth and downloads routes',async t=>{
 const {server}=createService({token:'test-only-secret',prepareMedia:async()=>({title:'test',data:Buffer.from('0123456789')})});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve)); t.after(()=>new Promise(resolve=>server.close(resolve)));
 const base=`http://127.0.0.1:${server.address().port}`;
 const headers={Authorization:'Bearer test-only-secret','Content-Type':'application/json'};

 const statusRes=await fetch(base+'/auth/status',{headers});
 assert.equal(statusRes.status,200);
 assert.equal((await statusRes.json()).loggedIn,false);

 const cloudRes=await fetch(base+'/auth/cloud-history',{headers});
 assert.equal(cloudRes.status,401);

 const badDetail=await fetch(base+'/detail',{method:'POST',headers,body:JSON.stringify({seriesId:'invalid-id'})});
 assert.equal(badDetail.status,400);

 const badSearch=await fetch(base+'/search',{method:'POST',headers,body:JSON.stringify({keyword:'   '})});
 assert.equal(badSearch.status,400);

 const badDl=await fetch(base+'/downloads/start',{method:'POST',headers,body:JSON.stringify({seriesId:'bad'})});
 assert.equal(badDl.status,400);

 const dlList=await fetch(base+'/downloads',{headers});
 assert.equal(dlList.status,200);
 assert.ok(Array.isArray((await dlList.json()).items));
});
test('keep-awake route reflects requested assertion state only for authed clients',async t=>{
 let requested;
 const keepAwake={setKeepAwake:active=>{requested=active;},stopKeepAwake:()=>{requested=false;}};
 const {server}=createService({token:'test-only-secret',prepareMedia:async()=>({title:'test',data:Buffer.from('0123456789')}),keepAwake});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve)); t.after(()=>new Promise(resolve=>server.close(resolve)));
 const base=`http://127.0.0.1:${server.address().port}`;
 const headers={Authorization:'Bearer test-only-secret','Content-Type':'application/json'};
 assert.equal((await fetch(base+'/keep-awake',{method:'POST',body:'{}'})).status,401);
 const on=await fetch(base+'/keep-awake',{method:'POST',headers,body:JSON.stringify({active:true})});
 assert.equal(on.status,200); assert.deepEqual(await on.json(),{active:true}); assert.equal(requested,true);
 const off=await fetch(base+'/keep-awake',{method:'POST',headers,body:JSON.stringify({active:false})});
 assert.equal(off.status,200); assert.deepEqual(await off.json(),{active:false}); assert.equal(requested,false);
 const junk=await fetch(base+'/keep-awake',{method:'POST',headers,body:JSON.stringify({active:'yes'})});
 assert.equal(junk.status,200); assert.deepEqual(await junk.json(),{active:false}); assert.equal(requested,false);
});
test('parseDanmakuResponse normalizes, deduplicates, sorts, and derives nextMs/total',()=>{
 assert.throws(()=>parseDanmakuResponse(null),{code:'INVALID_RESPONSE'});
 assert.throws(()=>parseDanmakuResponse({code:1001,message:'上游失败'}),{code:'UPSTREAM_ERROR',message:'上游失败'});
 const parsed=parseDanmakuResponse({
  code:0,
  data:{
   data_list:[
    {comment:{comment_id:'c2',common:{content:{text:' 第二条 '}},expand:{offset_time:1520},stat:{digg_count:3}}},
    {comment:{comment_id:'c1',common:{content:{text:'第一条'}},expand:{offset_time:400},stat:{digg_count:0}}},
    {comment:{comment_id:'c1',common:{content:{text:'重复'}},expand:{offset_time:400}}},
    {comment:{comment_id:'',common:{content:{text:'无id'}},expand:{offset_time:500}}},
    {comment:{comment_id:'c3',common:{content:{text:'   '}},expand:{offset_time:500}}},
    {comment:{comment_id:'c4',common:{content:{text:'负时间'}},expand:{offset_time:-10}}},
   ],
   common_list_info:{cursor:JSON.stringify({end_offset_time:30000,danmaku_count:128}),total:2},
   extra:{next_query_danmaku_list_time:30000},
  },
 },0);
 assert.deepEqual(parsed,{
  items:[
   {id:'c1',text:'第一条',timeMs:400,likeCount:0},
   {id:'c2',text:'第二条',timeMs:1520,likeCount:3},
  ],
  nextMs:30000,
  total:128,
 });
 const fallback=parseDanmakuResponse({
  code:0,
  data:{
   data_list:[],
   common_list_info:{cursor:JSON.stringify({end_offset_time:60000}),total:5},
  },
 },30000);
 assert.deepEqual(fallback,{items:[],nextMs:60000,total:5});
});
test('danmaku route enforces auth, ID validation, and forwards parsed danmaku payload',async t=>{
 let received=null;
 const {server}=createService({
  token:'test-only-secret',
  prepareMedia:async()=>({title:'test',data:Buffer.from('0123456789')}),
  fetchDanmaku:async opts=>{received=opts;return {items:[{id:'100',text:'打卡',timeMs:200,likeCount:1}],nextMs:30000,total:1};},
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve)); t.after(()=>new Promise(resolve=>server.close(resolve)));
 const base=`http://127.0.0.1:${server.address().port}`;
 const headers={Authorization:'Bearer test-only-secret','Content-Type':'application/json'};
 assert.equal((await fetch(base+'/danmaku',{method:'POST',body:'{}'})).status,401);
 assert.equal((await fetch(base+'/danmaku',{method:'POST',headers,body:JSON.stringify({seriesId:'bad',episodeId:'123'})})).status,400);
 assert.equal((await fetch(base+'/danmaku',{method:'POST',headers,body:JSON.stringify({seriesId:'123',episodeId:'bad'})})).status,400);
 const ok=await fetch(base+'/danmaku',{method:'POST',headers,body:JSON.stringify({seriesId:'7503745441910017049',episodeId:'7503780574541122622',startMs:0,durationMs:120000})});
 assert.equal(ok.status,200);
 assert.deepEqual(await ok.json(),{items:[{id:'100',text:'打卡',timeMs:200,likeCount:1}],nextMs:30000,total:1});
 assert.equal(received.seriesId,'7503745441910017049');
 assert.equal(received.episodeId,'7503780574541122622');
 assert.equal(received.startMs,0);
 assert.equal(received.durationMs,120000);
});
test('downloadFromVariants races probes, reassembles 206 chunks, and handles 200 full responses',async()=>{
 const totalSize=2*1024*1024+12345;
 const expected=Buffer.alloc(totalSize);
 for(let i=0;i<expected.length;i++)expected[i]=i%251;
 const seenHosts=[];
 const transportMock=async(url,opts={})=>{
  const host=new URL(url).hostname;
  seenHosts.push(host);
  if(host==='slow.qznovelvod.com'){
   await new Promise((resolve,reject)=>{
    const timer=setTimeout(resolve,150);
    opts.signal?.addEventListener('abort',()=>{clearTimeout(timer);reject(Object.assign(new Error('aborted'),{code:'ERR_CANCELED'}));},{once:true});
   });
  }else{
   await new Promise(resolve=>setTimeout(resolve,5));
  }
  const m=String(opts.headers?.Range||'').match(/^bytes=(\d+)-(\d+)$/);
  const start=Number(m[1]),end=Math.min(totalSize-1,Number(m[2]));
  return {status:206,headers:{'content-range':`bytes ${start}-${end}/${totalSize}`},data:expected.subarray(start,end+1)};
 };
 const res=await downloadFromVariants([
  {url:'https://slow.qznovelvod.com/v.mp4',codec:'h264',userAgent:'ua'},
  {url:'https://fast.qznovelvod.com/v.mp4',codec:'h264',userAgent:'ua'},
 ],undefined,transportMock);
 assert.equal(new URL(res.variant.url).hostname,'fast.qznovelvod.com');
 assert.equal(Buffer.compare(res.data,expected),0);

 let singleCalls=0;
 const fullPayload=Buffer.from('single-shot-mp4-data');
 const res200=await downloadFromVariants([
  {url:'https://plain.qznovelvod.com/v.mp4',codec:'hevc',userAgent:'ua'},
 ],undefined,async()=>{singleCalls++;return {status:200,headers:{},data:fullPayload};});
 assert.equal(singleCalls,1);
 assert.equal(Buffer.compare(res200.data,fullPayload),0);
});
test('play route caches episodes, prefetches the next episode, and preempts active requests without 409',async t=>{
 const episodes=[{episodeId:'1001',index:1},{episodeId:'1002',index:2}];
 const calls=[];
 const {server}=createService({
  token:'test-only-secret',
  prepareMedia:async({episodeId,signal})=>{
   calls.push(episodeId||'1001');
   if(episodeId==='9999'){
    await new Promise((resolve,reject)=>{
     const timer=setTimeout(resolve,200);
     signal?.addEventListener('abort',()=>{clearTimeout(timer);reject(Object.assign(new Error('aborted'),{code:'ERR_CANCELED'}));},{once:true});
    });
   }
   const ep=episodes.find(e=>e.episodeId===(episodeId||'1001'))||episodes[0];
   return {seriesId:'7503745441910017049',title:'测试剧',episode:ep,episodes,codec:'hevc',quality:'1080p',encrypted:false,data:Buffer.from('ep-'+ep.episodeId)};
  },
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve)); t.after(()=>new Promise(resolve=>server.close(resolve)));
 const base=`http://127.0.0.1:${server.address().port}`;
 const headers={Authorization:'Bearer test-only-secret','Content-Type':'application/json'};

 const r1=await fetch(base+'/play',{method:'POST',headers,body:JSON.stringify({seriesId:'7503745441910017049',episodeId:'1001',quality:'auto'})});
 assert.equal(r1.status,200);
 assert.equal((await r1.json()).episode.episodeId,'1001');
 // Wait for background prefetch of episode 1002 to finish.
 await new Promise(resolve=>setTimeout(resolve,250));
 assert.deepEqual(calls,['1001','1002']);

 // Switching to 1002 and back to 1001 hits cache with zero extra prepareMedia calls.
 const r2=await fetch(base+'/play',{method:'POST',headers,body:JSON.stringify({seriesId:'7503745441910017049',episodeId:'1002',quality:'auto'})});
 assert.equal(r2.status,200);
 assert.equal((await r2.json()).episode.episodeId,'1002');
 const r1Again=await fetch(base+'/play',{method:'POST',headers,body:JSON.stringify({seriesId:'7503745441910017049',episodeId:'1001',quality:'auto'})});
 assert.equal(r1Again.status,200);
 assert.deepEqual(calls,['1001','1002']);

 // Preempting an in-flight slow request returns 200 instead of 409 BUSY.
 const slowReq=fetch(base+'/play',{method:'POST',headers,body:JSON.stringify({seriesId:'7503745441910017049',episodeId:'9999',quality:'auto'})}).catch(()=>null);
 await new Promise(resolve=>setTimeout(resolve,30));
 const fastReq=await fetch(base+'/play',{method:'POST',headers,body:JSON.stringify({seriesId:'7503745441910017049',episodeId:'1002',quality:'auto'})});
 assert.equal(fastReq.status,200);
 await slowReq;
});
