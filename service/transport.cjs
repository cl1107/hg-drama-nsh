'use strict';
const https = require('node:https');
const dns = require('node:dns');
const net = require('node:net');
const zlib = require('node:zlib');
function publicAddress(address) {
 if (net.isIPv4(address)) {
  const [a,b] = address.split('.').map(Number);
  return !([0,10,127].includes(a) || a >= 224 || (a===169&&b===254) || (a===172&&b>=16&&b<=31) || (a===192&&b===168) || (a===100&&b>=64&&b<=127));
 }
 if (net.isIPv6(address)) return !(/^(::|fc|fd|fe[89ab])/i.test(address));
 return false;
}
function allowedUrl(value, domains) {
 const url = new URL(value);
 if (url.protocol !== 'https:' || url.port && url.port !== '443' || url.username || url.password || !domains.some(d => url.hostname === d || url.hostname.endsWith('.'+d))) throw Object.assign(new Error('请求地址不受支持'), {code:'SECURITY_BLOCKED'});
 return url;
}
function lookup(host, options, callback) {
 dns.lookup(host, {all:true}, (error, records) => {
  if (error) return callback(error);
  if (!records.length || records.some(r=>!publicAddress(r.address))) return callback(Object.assign(new Error('非公网 DNS 目标'), {code:'SECURITY_BLOCKED'}));
  const selected = records.find(r=>r.family===4) || records[0];
  callback(null, options.all ? [selected] : selected.address, selected.family);
 });
}
async function bytes(value, options = {}) {
 const url = allowedUrl(value, options.domains || ['fqnovel.com','snssdk.com']);
 return new Promise((resolve,reject)=> {
  const req = https.request(url, {method:options.method || 'GET',headers:options.headers,signal:options.signal,lookup}, res=> {
   const chunks=[]; let size=0;
   res.on('data', chunk=> {
    size+=chunk.length;
    if(size > (options.maxBytes || 2*1024*1024)) req.destroy(Object.assign(new Error('响应超过大小限制'), {code:'RESPONSE_TOO_LARGE'}));
    else chunks.push(chunk);
   });
   res.on('error',reject);
   res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,data:Buffer.concat(chunks)}));
  });
  const timer=setTimeout(()=>req.destroy(Object.assign(new Error('请求超时'),{code:'ETIMEDOUT'})),options.timeout || 15000);
  req.once('close',()=>clearTimeout(timer)); req.on('error',reject);
  req.end(options.data);
 });
}
async function transport(options) {
 const response=await bytes(options.url,options);
 let data=response.data;
 if (response.headers['content-encoding']==='gzip') data=zlib.gunzipSync(data,{maxOutputLength:options.maxContentLength || 2*1024*1024});
 if (response.headers['content-encoding']==='br') data=zlib.brotliDecompressSync(data,{maxOutputLength:options.maxContentLength || 2*1024*1024});
 return {...response,data:data.toString('utf8')};
}
module.exports=transport;
module.exports.bytes=bytes;
module.exports.allowedUrl=allowedUrl;
module.exports.publicAddress=publicAddress;
