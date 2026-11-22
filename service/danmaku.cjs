'use strict';
const { signedMetadataRequest, requestJson } = require('./vendor/hongguo/app-source');

const DEFAULT_WINDOW_MS = 30000;
const DEFAULT_DURATION_MS = 120000;
const REQUEST_TIMEOUT_MS = 12000;

function parseId(value) {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' && Number.isSafeInteger(value)) return String(value);
  return '';
}

function parseJsonObject(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function parseDanmakuResponse(payload, startMs = 0) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw Object.assign(new Error('弹幕接口返回格式异常'), { code: 'INVALID_RESPONSE' });
  }
  if (payload.code !== 0) {
    throw Object.assign(new Error(typeof payload.message === 'string' && payload.message.trim() ? payload.message : '弹幕接口返回异常'), {
      code: 'UPSTREAM_ERROR',
    });
  }
  const data = payload.data && typeof payload.data === 'object' ? payload.data : {};
  const list = Array.isArray(data.data_list) ? data.data_list : [];
  const seen = new Set();
  const items = [];

  for (const entry of list) {
    const comment = entry?.comment;
    const id = parseId(comment?.comment_id);
    const text = typeof comment?.common?.content?.text === 'string' ? comment.common.content.text.trim() : '';
    const timeMs = Number(comment?.expand?.offset_time);
    const likeCount = Math.max(0, Math.floor(Number(comment?.stat?.digg_count) || 0));
    if (!id || !text || !Number.isFinite(timeMs) || timeMs < 0 || seen.has(id)) continue;
    seen.add(id);
    items.push({ id, text, timeMs: Math.floor(timeMs), likeCount });
  }

  items.sort((a, b) => (a.timeMs !== b.timeMs ? a.timeMs - b.timeMs : a.id.localeCompare(b.id)));

  const info = data.common_list_info && typeof data.common_list_info === 'object' ? data.common_list_info : {};
  const cursorObj = parseJsonObject(info.cursor);
  const safeStart = Math.max(0, Math.floor(Number(startMs) || 0));
  const extraNext = Number(data.extra?.next_query_danmaku_list_time);
  const cursorEnd = Number(cursorObj?.end_offset_time);
  const nextMs = Number.isFinite(extraNext) && extraNext > safeStart
    ? Math.floor(extraNext)
    : Number.isFinite(cursorEnd) && cursorEnd > safeStart
      ? Math.floor(cursorEnd)
      : safeStart + DEFAULT_WINDOW_MS;

  const danmakuCount = Number(cursorObj?.danmaku_count);
  const infoTotal = Number(info.total);
  const total = Number.isFinite(danmakuCount) && danmakuCount >= 0
    ? Math.floor(danmakuCount)
    : Number.isFinite(infoTotal) && infoTotal >= 0
      ? Math.floor(infoTotal)
      : items.length;

  return { items, nextMs, total };
}

async function fetchDanmaku({ seriesId, episodeId, startMs = 0, durationMs = 0, signal } = {}) {
  if (typeof seriesId !== 'string' || !/^\d{1,30}$/.test(seriesId)
    || typeof episodeId !== 'string' || !/^\d{1,30}$/.test(episodeId)) {
    throw Object.assign(new Error('剧集或分集编号无效'), { code: 'INVALID_REQUEST' });
  }
  const safeStart = Math.max(0, Math.floor(Number(startMs) || 0));
  const safeDuration = Math.max(0, Math.floor(Number(durationMs) || 0));
  const apiPath = `/novel/commentapi/comment/list/${episodeId}/v1/`;
  const payload = {
    comment_source: 601,
    server_channel: 1000,
    group_id: episodeId,
    group_type: 30,
    comment_type: 20,
    sort: 1,
    business_param: {
      book_id: seriesId,
      start_offset_time: safeStart,
      playlet_item_duration: safeDuration > 0 ? safeDuration : DEFAULT_DURATION_MS,
      need_danmaku_guide_type: [48],
    },
    count: 90,
    cursor: '0',
    aid: 8662,
    compliance_status: 0,
  };
  const signed = signedMetadataRequest(apiPath, { 'comment-source': '601', 'server-channel': '1000' }, payload);
  const res = await requestJson(
    signed.url,
    { method: 'POST', headers: signed.headers, data: signed.body },
    Date.now() + REQUEST_TIMEOUT_MS,
    signal,
  );
  return parseDanmakuResponse(res, safeStart);
}

module.exports = { fetchDanmaku, parseDanmakuResponse };
