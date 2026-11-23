import { expect, open, test } from "nsh/test";
import { homeHtml } from "./tests/fixtures/home";
import { serviceConfig } from "./src/service-client";
const candidate = {id:"7503745441910017049",title:"宴律，你的白月光回国了",cover:"",episodes:76,tags:["都市"]};
const categories = {items:[candidate],selectors:[],hasMore:false,nextOffset:0,sessionId:"test"};
const routes = {
 "https://hongguoduanju.com/": {status:200,body:homeHtml},
 [`GET ${serviceConfig.baseUrl}/auth/status`]: {status:200,body:JSON.stringify({loggedIn:false})},
 [`POST ${serviceConfig.baseUrl}/discover/rank`]: {status:200,body:JSON.stringify({items:[candidate],hasMore:false,nextOffset:0,sessionId:"test"})},
 [`POST ${serviceConfig.baseUrl}/discover/category`]: {status:200,body:JSON.stringify(categories)},
 [`POST ${serviceConfig.baseUrl}/danmaku`]: {status:200,body:JSON.stringify({items:[],nextMs:30000,total:0})},
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
 await app.press("id:sidebar-toggle");
 await app.waitFor("发现",{state:"gone"});
 await app.press("id:sidebar-toggle");
 await app.waitFor("发现");
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
  await app.waitFor("id:player-header-episode");
  await app.waitFor("id:player-title-episode");
  await app.press("label:视频全屏");
  await app.waitFor("id:global-video");
  expect(app.window("main").state()?.mode).toBe("fullScreen");
  expect(app.texts()).not.toContain("短剧播放");
  expect(app.texts()).not.toContain("收起");
  await app.press("label:退出视频全屏 >> nth=1");
  await app.waitFor("短剧播放");
  await app.waitFor("发现");
  await app.waitFor("id:global-video");
  expect(app.window("main").state()?.mode).toBe("normal");
});

test("rank row opens the drama home with verified detail fields", async () => {
  const detail = {seriesId:candidate.id,title:candidate.title,cover:"",intro:"七年前，顾星晚捅伤亲生父亲入狱。",tags:["都市","爱情"],episodeText:"全76集",recordNumber:"（番茄）网微剧备字（2025）第13009号",celebrities:[{nickname:"申浩男",role:"饰 宴矜",avatar:""}],episodes:[{episodeId:"123",index:1},{episodeId:"124",index:2}]};
  const app = await open("./App.tsx",{platform:"macos",width:1480,height:820,network:{...routes,[`POST ${serviceConfig.baseUrl}/detail`]:{status:200,body:JSON.stringify(detail)}}});
  await app.press("排行榜");
  await app.waitFor("热播榜");
  await app.waitFor(candidate.title);
  await app.press("详情");
  await app.waitFor("全76集");
  await app.waitFor("饰 宴矜");
  await app.waitFor("（番茄）网微剧备字（2025）第13009号");
  await app.waitFor("第 2 集");
  await app.press("label:返回剧集列表");
  await app.waitFor("热播榜");
});

test("discover filters shrink so the grid stays visible in small windows", async () => {
  const manyChips = Array.from({length: 24}, (_, i) => ({id:`t${i}`, label:`题材${i}`}));
  const selectors = [
    {type:"category_dim_theme", label:"题材", items:manyChips},
    {type:"category_dim_role", label:"设定", items:manyChips},
    {type:"category_dim_epoch", label:"背景", items:manyChips},
  ];
  const app = await open("./App.tsx",{platform:"macos",width:1200,height:640,network:{...routes,[`POST ${serviceConfig.baseUrl}/discover/category`]:{status:200,body:JSON.stringify({...categories,selectors})}}});
  await app.press("找剧");
  await app.waitFor("id:discover-grid");
  await app.waitFor(`id:play-${candidate.id}`);
});

test("discover search results persist when returning from drama home", async () => {
  const searchResult = {id:"7503745441910017999",title:"谁让这个文盲修仙的第四季",cover:"",episodes:175,score:"8.2",tags:["玄幻","穿越"]};
  const detail = {seriesId:searchResult.id,title:searchResult.title,cover:"",intro:"修仙简介",tags:["玄幻","穿越"],episodeText:"全175集",recordNumber:"",celebrities:[],episodes:[{episodeId:"e1",index:1}]};
  const app = await open("./App.tsx",{platform:"macos",width:1480,height:820,network:{
    ...routes,
    [`POST ${serviceConfig.baseUrl}/search`]:{status:200,body:JSON.stringify({items:[searchResult],hasMore:false,cursor:null})},
    [`POST ${serviceConfig.baseUrl}/detail`]:{status:200,body:JSON.stringify(detail)},
  }});
  await app.press("找剧");
  await app.waitFor("输入剧名 / 关键词");
  await app.type("输入剧名 / 关键词", "文盲");
  await app.press("搜索");
  await app.waitFor("返回筛选");
  await app.waitFor(searchResult.title);
  await app.hover(`id:play-${searchResult.id}`);
  await app.press(`label:主页 ${searchResult.title}`);
  await app.waitFor("全175集");
  await app.press("label:返回剧集列表");
  await app.waitFor("返回筛选");
  await app.waitFor(searchResult.title);
  await app.press(searchResult.title);
  await app.waitFor("全175集");
  await app.press("label:返回剧集列表");
  await app.waitFor("返回筛选");
  await app.press("返回筛选");
  await app.waitFor("返回筛选", {state:"gone"});
});

test("fullscreen player auto-hides overlay UI when idle and restores it on mouse move", async () => {
  const playback = {seriesId:candidate.id,title:candidate.title,episode:{episodeId:"123",index:1},episodes:[{episodeId:"123",index:1},{episodeId:"124",index:2}],codec:"hevc",quality:"1080p",encrypted:true,mediaUrl:serviceConfig.baseUrl+"/media/"+"a".repeat(64)};
  const app = await open("./App.tsx",{platform:"macos",width:1480,height:820,clock:{},network:{...routes,[`POST ${serviceConfig.baseUrl}/play`]:{status:200,body:JSON.stringify(playback)}}});
  await app.waitFor("id:global-video");
  await app.hover("id:recommendation-page");
  await app.press("label:视频全屏");
  expect(app.window("main").state()?.mode).toBe("fullScreen");
  await app.waitFor("label:暂停播放");
  // 无操作 3 秒后自动隐藏 UI
  await app.wait(3200);
  await app.waitFor("label:暂停播放", {state:"gone"});
  await app.waitFor("label:退出视频全屏", {state:"gone"});
  // 鼠标移动后重新显示 UI
  await app.hover("id:recommendation-page");
  await app.waitFor("label:暂停播放");
  await app.waitFor("label:退出视频全屏");
  // 打开选集面板时不自动隐藏
  await app.press("选集 · 全2集");
  await app.waitFor("关闭播放面板");
  await app.wait(3500);
  await app.waitFor("关闭播放面板");
  await app.press("关闭播放面板");
  await app.wait(3200);
  await app.waitFor("label:暂停播放", {state:"gone"});
});

test("clicking the video surface toggles pause and resume with visual indicator", async () => {
  const playback = {seriesId:candidate.id,title:candidate.title,episode:{episodeId:"123",index:1},episodes:[{episodeId:"123",index:1},{episodeId:"124",index:2}],codec:"hevc",quality:"1080p",encrypted:true,mediaUrl:serviceConfig.baseUrl+"/media/"+"a".repeat(64)};
  const app = await open("./App.tsx",{platform:"macos",width:1480,height:820,network:{...routes,[`POST ${serviceConfig.baseUrl}/play`]:{status:200,body:JSON.stringify(playback)}}});
  await app.waitFor("id:global-video");
  await app.waitFor("id:video-surface-tap");
  await app.hover("id:recommendation-page");
  await app.waitFor("label:暂停播放");
  // 点击视频画面暂停播放
  await app.press("id:video-surface-tap");
  await app.waitFor("id:video-paused-indicator");
  await app.waitFor("label:继续播放");
  // 再次点击视频画面恢复播放
  await app.press("id:video-surface-tap");
  await app.waitFor("id:video-paused-indicator", {state:"gone"});
  await app.waitFor("label:暂停播放");
});

test("episodes sheet auto-centers current episode, toggles order, and jumps to start or end", async () => {
  const episodes = Array.from({length: 120}, (_, i) => ({episodeId: String(1000 + i), index: i + 1}));
  const playback = {
    seriesId: candidate.id,
    title: candidate.title,
    episode: episodes[74],
    episodes,
    codec: "hevc",
    quality: "1080p",
    encrypted: true,
    mediaUrl: serviceConfig.baseUrl + "/media/" + "a".repeat(64),
  };
  const app = await open("./App.tsx", {
    platform: "macos",
    width: 1480,
    height: 820,
    network: { ...routes, [`POST ${serviceConfig.baseUrl}/play`]: { status: 200, body: JSON.stringify(playback) } },
  });
  await app.waitFor("id:global-video");
  await app.hover("id:recommendation-page");
  await app.waitFor("id:player-title-episode");
  await app.press("选集 · 全120集");
  await app.waitFor("id:episodes-list");
  await app.waitFor("id:episode-item-75");
  await app.waitFor("id:episodes-locate-current");
  // 正序时第 1 集排在第 120 集之前
  const ascTexts = app.texts();
  expect(ascTexts.indexOf("1")).toBeGreaterThan(-1);
  expect(ascTexts.indexOf("120")).toBeGreaterThan(ascTexts.indexOf("1"));
  // 到头、到底与定位当前集均可正常触发
  await app.press("id:episodes-scroll-top");
  await app.press("id:episodes-scroll-bottom");
  await app.press("id:episodes-locate-current");
  // 切换倒序后，第 120 集排在第 1 集之前
  await app.press("id:episodes-order-desc");
  await app.waitUntil(() => {
    const texts = app.texts();
    const first = texts.indexOf("1");
    const last = texts.indexOf("120");
    return first > -1 && last > -1 && last < first;
  });
  await app.press("id:episodes-scroll-top");
  await app.press("id:episodes-scroll-bottom");
  // 切回正序后，恢复第 1 集在第 120 集之前
  await app.press("id:episodes-order-asc");
  await app.waitUntil(() => {
    const texts = app.texts();
    const first = texts.indexOf("1");
    const last = texts.indexOf("120");
    return first > -1 && last > -1 && first < last;
  });
});

test("player switches to previous and next episodes with boundary disabled states", async () => {
  const episodes = [
    { episodeId: "121", index: 1 },
    { episodeId: "122", index: 2 },
    { episodeId: "123", index: 3 },
  ];
  const app = await open("./App.tsx", {
    platform: "macos",
    width: 1480,
    height: 820,
    network: {
      ...routes,
      [`POST ${serviceConfig.baseUrl}/play`]: request => {
        const body = request.body ? (JSON.parse(request.body) as { episodeId?: string }) : {};
        const ep = episodes.find(item => item.episodeId === body.episodeId) ?? episodes[1];
        return {
          status: 200,
          body: JSON.stringify({
            seriesId: candidate.id,
            title: candidate.title,
            episode: ep,
            episodes,
            codec: "hevc",
            quality: "1080p",
            encrypted: true,
            mediaUrl: serviceConfig.baseUrl + "/media/" + "a".repeat(64),
          }),
        };
      },
    },
  });
  await app.waitFor("id:global-video");
  await app.hover("id:recommendation-page");
  await app.waitFor("第2集");
  expect(app.enabled("id:player-prev-episode")).toBe(true);
  expect(app.enabled("id:player-next-episode")).toBe(true);

  await app.press("id:player-next-episode");
  await app.waitFor("第3集");
  expect(app.enabled("id:player-prev-episode")).toBe(true);
  expect(app.enabled("id:player-next-episode")).toBe(false);

  await app.press("id:player-prev-episode");
  await app.waitFor("第2集");
  await app.press("id:player-prev-episode");
  await app.waitFor("第1集");
  expect(app.enabled("id:player-prev-episode")).toBe(false);
  expect(app.enabled("id:player-next-episode")).toBe(true);
});

test("player fetches and renders danmaku, toggles visibility, and updates danmaku settings", async () => {
  const playback = {
    seriesId: candidate.id,
    title: candidate.title,
    episode: { episodeId: "123", index: 1 },
    episodes: [{ episodeId: "123", index: 1 }, { episodeId: "124", index: 2 }],
    codec: "hevc",
    quality: "1080p",
    encrypted: true,
    mediaUrl: serviceConfig.baseUrl + "/media/" + "a".repeat(64),
  };
  const app = await open("./App.tsx", {
    platform: "macos",
    width: 1480,
    height: 820,
    network: {
      ...routes,
      [`POST ${serviceConfig.baseUrl}/play`]: { status: 200, body: JSON.stringify(playback) },
      [`POST ${serviceConfig.baseUrl}/danmaku`]: {
        status: 200,
        body: JSON.stringify({
          items: [
            { id: "dm1", text: "前排打卡", timeMs: 0, likeCount: 2 },
            { id: "dm2", text: "前排打卡！", timeMs: 0, likeCount: 1 },
          ],
          nextMs: 30000,
          total: 2,
        }),
      },
    },
  });
  await app.waitFor("id:global-video");
  await app.waitFor("id:danmaku-layer");
  await app.waitFor("id:danmaku-bullet-dm1");
  expect(app.texts()).toContain("前排打卡");
  // 合并重复弹幕开启时，dm2 并入 dm1 并显示 ×2
  expect(app.texts()).toContain("×2");
  expect(app.shows("id:danmaku-bullet-dm2")).toBe(false);

  await app.hover("id:recommendation-page");
  await app.waitFor("弹幕 开");
  await app.press("id:player-danmaku-toggle");
  await app.waitFor("弹幕 关");
  await app.waitFor("id:danmaku-bullet-dm1", { state: "gone" });

  await app.press("id:player-danmaku-toggle");
  await app.waitFor("弹幕 开");
  await app.waitFor("id:danmaku-bullet-dm1");

  await app.press("id:player-danmaku-settings-btn");
  await app.waitFor("不透明度");
  await app.waitFor("字号随画面大小缩放");
  await app.press("id:settings-danmaku-weight-700");
  await app.press("id:settings-danmaku-color-ffe14d");
  await app.press("id:settings-danmaku-lanes-inc");
  await app.waitFor("9 行");
  await app.press("id:settings-danmaku-speed-fast");
  await app.press("id:settings-danmaku-scale");
  await app.press("id:settings-danmaku-fullscreen");
  await app.press("id:settings-danmaku-mergedup");
  await app.press("id:settings-danmaku-mergedup");

  // 屏蔽词管理：添加屏蔽词后实时过滤屏幕上的弹幕
  await app.press("id:settings-danmaku-block-manage");
  await app.waitFor("屏蔽词管理");
  await app.type("id:danmaku-block-input", "前排");
  await app.press("id:danmaku-block-add");
  await app.waitFor("id:danmaku-block-word-前排");
  await app.waitFor("id:danmaku-bullet-dm1", { state: "gone" });
  await app.press("id:settings-danmaku-block-back");
  await app.waitFor("已设 1 个");
});
