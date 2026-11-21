'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {createService}=require('./server.cjs');
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
