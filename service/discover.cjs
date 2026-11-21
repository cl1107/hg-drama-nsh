'use strict';
const { getPlaybackDevice } = require('./vendor/hongguo/playback-device');
const { signedSearchRequest, signedMetadataRequest, parseSearchInteger, requestJson } = require('./vendor/hongguo/app-source');

const CATEGORY_API = '/reading/distribution/category/landpage/v/';
const RANK_API = '/reading/bookapi/bookmall/cell/change/v';

const GENRE_SCENES = {
  short_play: 'default',
  comic_series: 'comic_series',
  ai_series: 'ai_series',
};

const RANK_TYPES = {
  'hot-drama': { outer: 'all', sub: 'ranklist_hot_play_sc', contentTypes: [1, 1004] },
  'hot-real-drama': { outer: 'human', sub: 'human_hot_play', contentTypes: [1] },
  'hot-comic-drama': { outer: 'comic_series_rank', sub: 'comic_series_hot_play', contentTypes: [1004] },
  'hot-ai-drama': { outer: 'ai_playlet', sub: 'ai_playlet_hot_play', contentTypes: [1004] },
};

const OUTER_CONTENT_TYPES = {
  all: [1, 1004],
  series_album: [1, 1004],
  human: [1],
  comic_series_rank: [1004],
  ai_playlet: [1004],
};

const SELECTOR_LABELS = {
  genre: '类型',
  category_dim_theme: '题材',
  category_dim_role: '设定',
  category_dim_epoch: '背景',
  sort: '排序',
  gender: '受众',
  online_time: '时间',
};

function str(value) {
  return typeof value === 'string'
    ? value.trim()
    : typeof value === 'number' && Number.isSafeInteger(value)
      ? String(value)
      : '';
}

function catalogCover(value) {
  const raw = str(value);
  if (!raw) return '';
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return '';
    if (/\.heic$/i.test(url.pathname)) {
      if (
        !/(^|\.)(fqnovelpic\.com|byteimg\.com)$/i.test(url.hostname) ||
        !url.pathname.startsWith('/novel-pic/') ||
        !url.pathname.includes('~')
      ) {
        return '';
      }
      return `https://p3-novel.byteimg.com${url.pathname.split('~', 1)[0]}~tplv-shrink:640:0.image`;
    }
    return url.protocol === 'https:' ? url.href : '';
  } catch {
    return '';
  }
}

function parseSearchItem(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const book = raw.video_data?.[0] || raw.book_data?.[0] || raw.series_info || raw;
  const id = str(book.series_id || book.book_id);
  const title = str(book.series_name || book.book_name || book.series_title || book.title);
  if (!/^\d{1,30}$/.test(id) || !title) return null;
  const cover = catalogCover(book.cover || book.thumb_url || book.series_cover);
  const episodes = Number(book.episode_cnt || book.serial_count || book.total_episode || 0);
  const score = str(book.score);
  const tags = Array.isArray(book.tags)
    ? book.tags.filter(t => typeof t === 'string')
    : Array.isArray(book.sub_title_list)
      ? book.sub_title_list.map(t => str(t?.content)).filter(Boolean).slice(0, 4)
      : [];
  return {
    id,
    title,
    cover,
    episodes: Number.isInteger(episodes) && episodes > 0 ? episodes : 0,
    score,
    tags,
  };
}

function parseSearchResponse(payload) {
  if (!payload || typeof payload !== 'object') {
    throw Object.assign(new Error('App 搜索返回格式异常'), { code: 'INVALID_RESPONSE' });
  }
  const tabs = Array.isArray(payload.search_tabs)
    ? payload.search_tabs
    : Array.isArray(payload.data?.search_tabs)
      ? payload.data.search_tabs
      : [];
  const items = [];
  const seen = new Set();
  let hasMore = false;
  let nextCursor = null;

  for (const tab of tabs) {
    const list = Array.isArray(tab?.data) ? tab.data : [];
    for (const entry of list) {
      const parsed = parseSearchItem(entry);
      if (parsed && !seen.has(parsed.id)) {
        seen.add(parsed.id);
        items.push(parsed);
      }
    }
    if (tab?.has_more) hasMore = true;
    if (tab?.search_id || tab?.passback || tab?.next_offset !== undefined) {
      nextCursor = {
        ...(tab.search_id ? { search_id: String(tab.search_id) } : {}),
        ...(tab.passback ? { passback: String(tab.passback) } : {}),
        ...(tab.next_offset !== undefined ? { next_offset: Number(tab.next_offset) } : {}),
      };
    }
  }

  if (!items.length && Array.isArray(payload.data?.book_list)) {
    for (const entry of payload.data.book_list) {
      const parsed = parseSearchItem(entry);
      if (parsed && !seen.has(parsed.id)) {
        seen.add(parsed.id);
        items.push(parsed);
      }
    }
    hasMore = Boolean(payload.data?.has_more);
  }

  return { items, hasMore, cursor: nextCursor };
}

function parseCatalogCard(video, allowedContentTypes = null) {
  if (!video || typeof video !== 'object') return null;
  const id = str(video.series_id);
  const title = str(video.title || video.series_title || video.series_name);
  if (!/^\d{1,30}$/.test(id) || !title) return null;
  if (allowedContentTypes && !allowedContentTypes.includes(Number(video.content_type))) return null;
  const tags = Array.isArray(video.sub_title_list)
    ? video.sub_title_list.map(t => str(t?.content)).filter(Boolean).slice(0, 4)
    : [];
  const badge = str(video.tag_info?.text);
  const episodes = parseSearchInteger(video.episode_cnt) || 0;
  return {
    id,
    title,
    cover: catalogCover(video.cover || video.series_cover),
    episodes,
    score: str(video.score),
    tags,
    ...(badge ? { badge } : {}),
  };
}

function parseSelectorGroups(selectorRows) {
  if (!Array.isArray(selectorRows)) return [];
  const groups = [];
  for (const row of selectorRows) {
    const type = str(row?.type);
    if (!type || !SELECTOR_LABELS[type] || !Array.isArray(row.items)) continue;
    const seen = new Set();
    const items = [];
    for (const entry of row.items) {
      const id = str(entry?.selector_item_id);
      const label = str(entry?.show_name);
      if (!id || !label || seen.has(id)) continue;
      seen.add(id);
      items.push({ id, label });
    }
    if (items.length) {
      groups.push({ type, label: SELECTOR_LABELS[type], items });
    }
  }
  return groups;
}

function parseCategoryResponse(payload) {
  if (!payload || typeof payload !== 'object' || Number(payload.code) !== 0) {
    throw Object.assign(new Error('App 分类目录返回异常'), { code: 'INVALID_RESPONSE' });
  }
  const data = payload.data;
  if (!data || !Array.isArray(data.video_data)) {
    throw Object.assign(new Error('App 分类目录结构异常'), { code: 'INVALID_RESPONSE' });
  }
  const seen = new Set();
  const items = [];
  for (const row of data.video_data) {
    const card = parseCatalogCard(row);
    if (card && !seen.has(card.id)) {
      seen.add(card.id);
      items.push(card);
    }
  }
  return {
    items,
    selectors: parseSelectorGroups(data.selector_rows),
    hasMore: data.has_more === true,
    nextOffset: parseSearchInteger(data.next_offset) ?? 0,
    sessionId: str(data.session_id),
  };
}

function parseRankSelectors(cellSelector) {
  const outerItems = Array.isArray(cellSelector?.outer_row?.items) ? cellSelector.outer_row.items : [];
  const groups = [];
  for (const outer of outerItems) {
    const id = str(outer?.selector_item_id);
    const label = str(outer?.show_name);
    if (!id || !label) continue;
    const subItems = Array.isArray(outer?.sub_cell_selector?.outer_row?.items) ? outer.sub_cell_selector.outer_row.items : [];
    const items = [];
    for (const sub of subItems) {
      const subId = str(sub?.selector_item_id);
      const subLabel = str(sub?.show_name);
      if (subId && subLabel) items.push({ id: subId, label: subLabel, subTitle: str(sub?.sub_title) });
    }
    if (items.length) groups.push({ id, label, items });
  }
  return groups;
}

function resolveRankConfig(input = 'hot-drama') {
  if (input && typeof input === 'object') {
    if (input.outerTab && input.subTab) {
      if (!/^[a-z0-9_]+$/i.test(input.outerTab) || !/^[a-z0-9_]+$/i.test(input.subTab)) {
        throw Object.assign(new Error('不支持的榜单类型'), { code: 'APP_INPUT' });
      }
      return {
        outer: input.outerTab,
        sub: input.subTab,
        contentTypes: OUTER_CONTENT_TYPES[input.outerTab] || [1, 1004],
      };
    }
    return resolveRankConfig(input.rankType || 'hot-drama');
  }
  const rankCfg = RANK_TYPES[input];
  if (!rankCfg) throw Object.assign(new Error('不支持的榜单类型'), { code: 'APP_INPUT' });
  return rankCfg;
}

function parseRankResponse(payload, rankTypeOrOpts = 'hot-drama') {
  const rankCfg = resolveRankConfig(rankTypeOrOpts);
  if (!payload || typeof payload !== 'object' || Number(payload.code) !== 0) {
    throw Object.assign(new Error('App 榜单返回异常'), { code: 'INVALID_RESPONSE' });
  }
  const view = payload.data?.cell_view;
  if (!view || !Array.isArray(view.cell_data)) {
    throw Object.assign(new Error('App 榜单结构异常'), { code: 'INVALID_RESPONSE' });
  }
  const selected = view.cell_selector?.outer_row?.items?.find(i => i?.is_selected === true);
  const child = selected?.sub_cell_selector?.outer_row?.items?.find(i => i?.is_selected === true);
  if (selected && (selected.selector_item_id !== rankCfg.outer || child?.selector_item_id !== rankCfg.sub)) {
    throw Object.assign(new Error('App 返回了其他榜单'), { code: 'INVALID_RESPONSE' });
  }
  const rows = view.cell_data.flatMap(cell =>
    Array.isArray(cell?.video_data) ? cell.video_data : cell?.video_data ? [cell.video_data] : [],
  );
  const seen = new Set();
  const items = [];
  for (const row of rows) {
    const card = parseCatalogCard(row, rankCfg.contentTypes);
    if (card && !seen.has(card.id)) {
      seen.add(card.id);
      items.push(card);
    }
  }
  return {
    items,
    selectors: parseRankSelectors(view.cell_selector),
    subTitle: str(child?.sub_title),
    hasMore: view.has_more === true,
    nextOffset: parseSearchInteger(view.next_offset) ?? 0,
    sessionId: str(view.session_id),
  };
}

async function searchDramas({ keyword, page = 1, cursor = null, signal } = {}) {
  const clean = typeof keyword === 'string' ? keyword.trim() : '';
  if (!clean) throw Object.assign(new Error('请输入搜索关键词'), { code: 'APP_INPUT' });
  const identity = await getPlaybackDevice(requestJson);
  const req = signedSearchRequest({ keyword: clean, page, cursor, identity });
  const payload = await requestJson(
    req.url,
    {
      headers: req.headers,
      preserveLargeIntegerFields: ['book_id', 'series_id', 'item_id', 'video_id'],
    },
    Date.now() + 12000,
    signal,
  );
  return parseSearchResponse(payload);
}

async function browseCategory({
  genre = 'short_play',
  theme = '',
  role = '',
  epoch = '',
  sort = 'hot_score',
  gender = '',
  onlineTime = '',
  offset = 0,
  sessionId = '',
  needSelectorPanel = true,
  limit = 20,
  signal,
} = {}) {
  const reqScene = GENRE_SCENES[genre] || 'default';
  const safeGenre = GENRE_SCENES[genre] ? genre : 'short_play';
  const safeOffset = parseSearchInteger(offset) ?? 0;
  const safeLimit = Math.min(50, Math.max(1, parseSearchInteger(limit) ?? 20));
  const payloadBody = {
    filter_ids: '',
    req_scene: reqScene,
    offset: safeOffset,
    need_selector_panel: Boolean(needSelectorPanel && safeOffset === 0),
    limit: safeLimit,
    select_items: {
      genre: [safeGenre],
      sort: [sort || 'hot_score'],
      category_dim_theme: theme ? [theme] : [],
      category_dim_role: role ? [role] : [],
      category_dim_epoch: epoch ? [epoch] : [],
      gender: gender ? [gender] : [],
      online_time: onlineTime ? [onlineTime] : [],
      creation_status: [],
    },
    session_id: typeof sessionId === 'string' ? sessionId : '',
    req_type: safeOffset > 0 ? 'only_content' : 'default',
    client_req_type: 3,
  };
  const req = signedMetadataRequest(CATEGORY_API, {}, payloadBody);
  const payload = await requestJson(
    req.url,
    {
      method: 'POST',
      headers: req.headers,
      data: req.body,
      preserveLargeIntegerFields: ['series_id', 'book_id', 'item_id', 'video_id', 'session_id'],
    },
    Date.now() + 12000,
    signal,
  );
  return parseCategoryResponse(payload);
}

async function browseRank({ rankType = 'hot-drama', outerTab = '', subTab = '', offset = 0, sessionId = '', limit = 20, signal } = {}) {
  const rankCfg = resolveRankConfig(outerTab && subTab ? { outerTab, subTab } : rankType);
  const safeOffset = parseSearchInteger(offset) ?? 0;
  const safeLimit = Math.min(50, Math.max(1, parseSearchInteger(limit) ?? 20));
  const req = signedMetadataRequest(RANK_API, {
    tab_type: safeOffset === 0 ? '26' : '18',
    client_req_type: '2',
    client_template: '2',
    background_selected_items: '',
    category_id: '0',
    limit: String(safeLimit),
    cell_sub_id: '0',
    gender: '2',
    cell_id: '7470092475068071998',
    selected_items: rankCfg.outer,
    sub_selected_items: rankCfg.sub,
    panel_selected_items: '',
    offset: String(safeOffset),
    session_id: typeof sessionId === 'string' ? sessionId : '',
    filter_ids: '',
    unlimited_selector_change_type: '0',
  });
  const payload = await requestJson(
    req.url,
    {
      method: 'GET',
      headers: req.headers,
      preserveLargeIntegerFields: ['series_id', 'book_id', 'item_id', 'video_id', 'session_id'],
    },
    Date.now() + 12000,
    signal,
  );
  return parseRankResponse(payload, outerTab && subTab ? { outerTab, subTab } : rankType);
}

module.exports = {
  searchDramas,
  browseCategory,
  browseRank,
  parseSearchResponse,
  parseCategoryResponse,
  parseRankResponse,
  catalogCover,
};
