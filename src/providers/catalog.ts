export interface Drama { id: string; title: string; cover: string; episodes: number }
export interface Section { name: string; dramas: Drama[] }
function record(value: unknown): Record<string, unknown> {
 if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("官网数据结构异常");
 return value as Record<string, unknown>;
}
function text(value: unknown): string {
 if (typeof value !== "string") throw new Error("官网必需文本字段缺失");
 return value;
}
export function routerData(html: string): Record<string, unknown> {
 const marker = /(?:window\.)?_ROUTER_DATA\s*=\s*/g.exec(html);
 if (!marker) throw new Error("官网未返回页面数据");
 const start = marker.index + marker[0].length;
 if (html[start] !== "{") throw new Error("官网页面数据格式变化");
 let depth = 0, quoted = false, escaped = false;
 for (let i = start; i < html.length; i++) {
  const c = html[i];
  if (quoted) { if (escaped) escaped = false; else if (c === "\\") escaped = true; else if (c === '"') quoted = false; continue; }
  if (c === '"') quoted = true;
  else if (c === "{") depth++;
  else if (c === "}" && --depth === 0) return record(JSON.parse(html.slice(start, i + 1)));
 }
 throw new Error("官网页面数据不完整");
}
export function parseHome(html: string): Section[] {
 const page = record(record(routerData(html).loaderData).page);
 if (page.isSuccess !== true || !Array.isArray(page.homeSections)) throw new Error("官网目录加载失败");
 return page.homeSections.map(value => {
  const section = record(value);
  if (!Array.isArray(section.video_list)) throw new Error("官网分区剧集缺失");
  return { name: text(section.tab_name), dramas: section.video_list.filter(item => item != null).map(value => {
   const row = record(value), id = text(row.series_id);
   if (!/^\d+$/.test(id)) throw new Error("官网剧集编号无效");
   if (typeof row.episode_cnt !== "number" || !Number.isInteger(row.episode_cnt) || row.episode_cnt < 1) throw new Error("官网集数无效");
   const cover = new URL(text(row.series_cover));
   if (cover.protocol !== "https:" || !(cover.hostname === "byteimg.com" || cover.hostname.endsWith(".byteimg.com"))) throw new Error("官网封面域名不受支持");
   return { id, title: text(row.series_title), cover: cover.href, episodes: row.episode_cnt };
  }) };
 });
}
export async function loadHome(signal: AbortSignal): Promise<Section[]> {
 const response = await fetch("https://hongguoduanju.com/", { signal, redirect: "error" });
 if (!response.ok) throw new Error(`官网请求失败（HTTP ${response.status}）`);
 return parseHome(await response.text());
}
