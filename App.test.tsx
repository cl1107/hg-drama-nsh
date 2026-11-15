import { expect, open, test } from "nsh/test";
import { homeHtml } from "./tests/fixtures/home";

test("catalog loads official sections and filters without fabricating results", async () => {
  const html = homeHtml;
  const app = await open("./App.tsx", {
    width: 1280,
    height: 820,
    network: { "https://hongguoduanju.com/": { status: 200, body: html } },
  });
  await app.press("加载官网目录");
  await app.waitFor("少夫人来自东北3");
  await app.type("text:搜索已加载的官网目录", "不存在的测试剧名");
  await app.waitFor("没有匹配的短剧");
  expect(app.texts()).not.toContain("少夫人来自东北3");
});

test("catalog failures are visible and navigation can reach the media probe", async () => {
  const app = await open("./App.tsx", {
    width: 1280,
    height: 820,
    network: { "https://hongguoduanju.com/": { status: 503, body: "unavailable" } },
  });
  await app.press("加载官网目录");
  await app.waitFor("官网请求失败（HTTP 503）");
  await app.press("播放探针");
  await app.waitFor("HTTPS 视频地址");
});

test("navigation reaches rank, calendar, history, downloads, login, settings and supports sidebar collapse and theme toggle", async () => {
  const app = await open("./App.tsx", {
    width: 1280,
    height: 820,
    network: { "https://hongguoduanju.com/": { status: 200, body: homeHtml } },
  });
  await app.press("排行榜");
  await app.waitFor("加载官网目录");
  await app.press("上新日历");
  await app.waitFor("当前展示官网公开剧集与本地预约状态（云端上新日历接口待补全）");
  await app.press("历史/收藏/点赞");
  await app.waitFor("暂无本地观看历史");
  await app.press("云端历史");
  await app.waitFor("请先在“我的 / 登录”中登录账号后再查看云端历史");
  await app.press("下载");
  await app.waitFor("离线下载保存在本机临时目录（已完成可离线播放）");
  await app.press("我的 / 登录");
  await app.waitFor("生成登录二维码");
  await app.press("短信登录");
  await app.waitFor("发送验证码");
  await app.press("设置");
  await app.waitFor("播完自动连播下一集");
  await app.press("浅色 >> nth=0");
  await app.waitFor("深色 >> nth=0");
  await app.press("‹ 收起");
  await app.waitFor("展开");
});
