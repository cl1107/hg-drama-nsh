import { expect, open, test } from "nsh/test";
import { homeHtml } from "./tests/fixtures/home";
import { serviceConfig } from "./.tmp/service-config";
const candidate = {id:"7503745441910017049",title:"宴律，你的白月光回国了",cover:"",episodes:76,tags:["都市"]};
const categories = {items:[candidate],selectors:[],hasMore:false,nextOffset:0,sessionId:"test"};
const routes = {
 "https://hongguoduanju.com/": {status:200,body:homeHtml},
 [`GET ${serviceConfig.baseUrl}/auth/status`]: {status:200,body:JSON.stringify({loggedIn:false})},
 [`POST ${serviceConfig.baseUrl}/discover/rank`]: {status:200,body:JSON.stringify({items:[candidate],hasMore:false,nextOffset:0,sessionId:"test"})},
 [`POST ${serviceConfig.baseUrl}/discover/category`]: {status:200,body:JSON.stringify(categories)},
 [`POST ${serviceConfig.baseUrl}/play`]: {status:502,body:JSON.stringify({code:"EMPTY_RESPONSE"})},
};
test("keeps retry and next actions available when the recommended episode has no source", async () => {
 const app = await open("./App.tsx",{platform:"macos",width:1480,height:820,network:routes});
 await app.waitFor("id:recommendation-page");
 await app.waitFor("上游暂未提供本集正片片源");
 await app.waitFor("重试播放");
 await app.waitFor("下一部");
 expect(app.texts()).not.toContain("打开红果官网");
 await app.hover("id:recommendation-page");
 await app.press("id:recommend-tab-关注");
 await app.waitFor("还没有追更的短剧");
 await app.press("去找剧");
 await app.waitFor("输入剧名 / 关键词");
 expect(app.texts()).not.toContain("App 分类筛选");
 expect(app.texts()).not.toContain("海报网格");
});
test("recommendation source failure never masquerades as an empty following list", async () => {
 const app = await open("./App.tsx",{platform:"macos",width:1280,height:820,network:{...routes,[`POST ${serviceConfig.baseUrl}/discover/rank`]:{status:503,body:JSON.stringify({message:"推荐源暂不可用"})}}});
 await app.waitFor("id:recommendation-page");
 await app.hover("id:recommendation-page");
 await app.press("id:recommend-tab-关注");
 await app.waitFor("还没有追更的短剧");
 await app.press("id:recommend-tab-推荐");
 await app.waitFor("重试推荐");
 await app.waitFor("去找剧");
});
test("discovery pages, settings, and sidebar stay reachable without debug-source controls", async () => {
 const app = await open("./App.tsx",{platform:"macos",width:1480,height:820,network:routes});
 await app.press("排行榜");
 await app.waitFor("热播榜");
 await app.press("新剧");
 await app.waitFor("新剧推荐");
 await app.press("上新日历");
 await app.waitFor("新剧推荐");
 await app.press("历史/收藏/点赞");
 await app.waitFor("暂无本地观看历史");
 await app.press("下载");
 await app.waitFor("全部 (0)");
 await app.press("设置");
 await app.waitFor("播完自动连播下一集");
 await app.press("label:切换到浅色模式");
 await app.waitFor("label:切换到深色模式");
 await app.press("收起");
 await app.waitFor("展开");
});

test("recommendation player opens episodes and navigating away removes its video", async () => {
 const playback = {seriesId:candidate.id,title:candidate.title,episode:{episodeId:"123",index:1},episodes:[{episodeId:"123",index:1},{episodeId:"124",index:2}],codec:"hevc",quality:"1080p",encrypted:true,mediaUrl:serviceConfig.baseUrl+"/media/"+"a".repeat(64)};
 const app = await open("./App.tsx",{platform:"macos",width:1480,height:820,network:{...routes,[`POST ${serviceConfig.baseUrl}/play`]:{status:200,body:JSON.stringify(playback)}}});
 await app.waitFor("id:global-video");
 await app.hover("id:recommendation-page");
 await app.press("选集 · 全2集");
 await app.waitFor("关闭播放面板");
 await app.press("关闭播放面板");
 await app.press("label:暂停播放");
 await app.waitFor("label:继续播放");
 await app.press("找剧 >> nth=0");
 await app.waitFor("输入剧名 / 关键词");
  await app.waitFor("id:global-video",{state:"gone"});
  expect(app.texts()).not.toContain("App 分类筛选");
});

test("history playback toggles fullscreen in place without blanking the player", async () => {
  const playback = {seriesId:candidate.id,title:candidate.title,episode:{episodeId:"123",index:1},episodes:[{episodeId:"123",index:1},{episodeId:"124",index:2}],codec:"hevc",quality:"1080p",encrypted:true,mediaUrl:serviceConfig.baseUrl+"/media/"+"a".repeat(64)};
  const app = await open("./App.tsx",{platform:"macos",width:1480,height:820,network:{
    ...routes,
    [`GET ${serviceConfig.baseUrl}/auth/status`]: {status:200,body:JSON.stringify({loggedIn:true,user:{userId:"u1",nickname:"测试用户"}})},
    [`GET ${serviceConfig.baseUrl}/auth/cloud-history`]: {status:200,body:JSON.stringify({items:[{seriesId:candidate.id,title:candidate.title,cover:"",episodeId:"123",episodeIndex:1,totalEpisodes:76,watchedAt:1700000000000}]})},
    [`GET ${serviceConfig.baseUrl}/auth/cloud-bookshelf`]: {status:200,body:JSON.stringify({items:[]})},
    [`POST ${serviceConfig.baseUrl}/play`]: {status:200,body:JSON.stringify(playback)},
  }});
  await app.waitFor("测试用户");
  await app.press("历史/收藏/点赞");
  await app.press("云端历史 (1)");
  await app.waitFor(candidate.title);
  await app.press("播放");
  await app.waitFor("短剧播放");
  await app.waitFor("id:global-video");
  await app.hover("id:global-player");
  await app.press("label:视频全屏");
  await app.waitFor("id:global-video");
  expect(app.window("main").state()?.mode).toBe("fullScreen");
  expect(app.texts()).not.toContain("短剧播放");
  expect(app.texts()).not.toContain("收起");
  await app.press("label:退出视频全屏 >> nth=1");
  await app.waitFor("短剧播放");
  await app.waitFor("收起");
  await app.waitFor("id:global-video");
  expect(app.window("main").state()?.mode).toBe("normal");
});
