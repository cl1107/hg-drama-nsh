'use strict';
const { getPlaybackDevice } = require('./vendor/hongguo/playback-device');
const { signedSearchRequest, requestJson } = require('./vendor/hongguo/app-source');

function str(value) {
  return typeof value === 'string' ? value.trim() : typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : '';
}

function parseSearchItem(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const book = raw.book_data?.[0] || raw.series_info || raw;
  const id = str(book.series_id || book.book_id);
  const title = str(book.series_name || book.book_name || book.title);
  if (!/^\d{1,30}$/.test(id) || !title) return null;
  const coverRaw = str(book.thumb_url || book.series_cover || book.cover);
  let cover = '';
  if (coverRaw) {
    try {
      const url = new URL(coverRaw);
      if (url.protocol === 'https:') cover = url.href;
    } catch {}
  }
  const episodes = Number(book.episode_cnt || book.serial_count || book.total_episode || 0);
  const score = str(book.score);
  const tags = Array.isArray(book.tags) ? book.tags.filter(t => typeof t === 'string') : [];
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
  const tabs = Array.isArray(payload.search_tabs) ? payload.search_tabs
    : Array.isArray(payload.data?.search_tabs) ? payload.data.search_tabs : [];
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

module.exports = { searchDramas, parseSearchResponse };
