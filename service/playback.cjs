'use strict';
const {routerData}=require('../src/providers/catalog.ts');
const {fetchAppPlayUrl}=require('./vendor/hongguo/app-source');
const {bytes}=require('./transport.cjs');
const {decryptMp4Buffer}=require('../src/media/cenc.cjs');
const id=value=>typeof value==='string' && /^\d{1,30}$/.test(value);
async function details(seriesId, signal) {
 if(!id(seriesId)) throw Object.assign(new Error('剧集编号无效'),{code:'INVALID_ID'});
 const response=await bytes(`https://hongguoduanju.com/player/${seriesId}`,{domains:['hongguoduanju.com'],signal,maxBytes:4*1024*1024});
 if(response.status!==200)throw Object.assign(new Error(`剧集页面请求失败（HTTP ${response.status}）`),{code:'DETAIL_HTTP'});
 const loader=routerData(response.data.toString('utf8')).loaderData;
 const page=loader?.['player_(series_id)/page'];
 const detail=page?.seriesDetail;
 if(page?.isSuccess!==true || detail?.series_id!==seriesId || typeof detail.series_name!=='string' || !Array.isArray(detail.vid_list) || !detail.vid_list.length || !detail.vid_list.every(id)) throw Object.assign(new Error('剧集详情格式变化'),{code:'INVALID_DETAIL'});
 return {
  seriesId,
  title:detail.series_name,
  cover:typeof detail.series_cover==='string'?detail.series_cover:'',
  intro:typeof detail.series_intro==='string'?detail.series_intro:'',
  tags:Array.isArray(detail.tags)?detail.tags.filter(t=>typeof t==='string'):[],
  episodeText:typeof detail.episode_right_text==='string'?detail.episode_right_text:'',
  recordNumber:typeof detail.record_number==='string'?detail.record_number:'',
  celebrities:Array.isArray(detail.celebrities)?detail.celebrities
    .filter(c=>c&&typeof c.nickname==='string'&&c.nickname.trim())
    .slice(0,8)
    .map(c=>({
      nickname:c.nickname,
      role:typeof c.sub_title==='string'?c.sub_title:'',
      avatar:typeof c.avatar==='string'?c.avatar:''
    })):[],
  episodes:detail.vid_list.map((episodeId,index)=>({episodeId,index:index+1}))
 };
}
async function prepare({seriesId,episodeId,signal,quality='auto'}) {
 const detail=await details(seriesId,signal);
 const episode=episodeId ? detail.episodes.find(item=>item.episodeId===episodeId) : detail.episodes[0];
 if(!episode)throw Object.assign(new Error('所选分集不属于本剧'),{code:'INVALID_EPISODE'});
 const model=await fetchAppPlayUrl(episode.episodeId,{quality,signal});
 const variants=(model.variants || [model]).filter(v=>['h264','hevc'].includes(v.codec));
 if(!variants.length)throw Object.assign(new Error('本集没有兼容 H.264/HEVC 片源'),{code:'NO_COMPATIBLE_SOURCE'});
 // The upstream model already enforces the quality tier; prefer AVC within that tier.
 const ordered=[...variants.filter(v=>v.codec==='h264'),...variants.filter(v=>v.codec!=='h264')];
 let variant,response,lastError;
 for(const candidate of ordered){
  if(signal?.aborted)throw Object.assign(new Error('已取消'),{code:'ERR_CANCELED'});
  try{
   const res=await bytes(candidate.url,{domains:['qznovelvod.com','fqnovelvod.com','douyinvod.com'],headers:{'User-Agent':candidate.userAgent},signal,maxBytes:256*1024*1024,timeout:90000});
   if(res.status===200 && res.data?.length){variant=candidate;response=res;break;}
   lastError=Object.assign(new Error(`媒体请求失败（HTTP ${res.status}）`),{code:'MEDIA_HTTP'});
  }catch(error){
   if(error?.code==='ERR_CANCELED' || signal?.aborted)throw error;
   lastError=error;
  }
 }
 if(!response || !variant)throw lastError || Object.assign(new Error('媒体请求失败'),{code:'MEDIA_HTTP'});
 const data=variant.contentKey ? decryptMp4Buffer(response.data,Buffer.from(variant.contentKey,'hex')) : response.data;
 return {...detail,episode,codec:variant.codec,quality:variant.quality,encrypted:!!variant.contentKey,data};
}
module.exports={details,prepare};
