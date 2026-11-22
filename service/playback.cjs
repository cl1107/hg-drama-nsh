'use strict';
const { routerData } = require('../src/providers/catalog.ts');
const { fetchAppPlayUrl } = require('./vendor/hongguo/app-source');
const { bytes } = require('./transport.cjs');
const { decryptMp4Buffer } = require('../src/media/cenc.cjs');

const id = value => typeof value === 'string' && /^\d{1,30}$/.test(value);

const DETAIL_CACHE_TTL_MS = 10 * 60 * 1000;
const DETAIL_CACHE_MAX = 32;
const MEDIA_DOMAINS = ['qznovelvod.com', 'fqnovelvod.com', 'douyinvod.com'];
const MAX_MEDIA_BYTES = 256 * 1024 * 1024;
const CHUNK_BYTES = 1024 * 1024;
const CHUNK_CONCURRENCY = 6;

const detailCache = new Map();
const detailInflight = new Map();

function clearDetailCache() {
  detailCache.clear();
}

function makeAbortError() {
  return Object.assign(new Error('已取消'), { code: 'ERR_CANCELED' });
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw makeAbortError();
}

function raceWithSignal(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(makeAbortError());
  let onAbort;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      onAbort = () => reject(makeAbortError());
      signal.addEventListener('abort', onAbort, { once: true });
    }),
  ]).finally(() => {
    if (onAbort) signal.removeEventListener('abort', onAbort);
  });
}

function getCachedDetail(seriesId) {
  const entry = detailCache.get(seriesId);
  if (!entry) return null;
  if (entry.expires <= Date.now()) {
    detailCache.delete(seriesId);
    return null;
  }
  detailCache.delete(seriesId);
  detailCache.set(seriesId, entry);
  return { ...entry.value, episodes: entry.value.episodes.map(ep => ({ ...ep })) };
}

function setCachedDetail(seriesId, value) {
  if (detailCache.has(seriesId)) detailCache.delete(seriesId);
  while (detailCache.size >= DETAIL_CACHE_MAX) {
    detailCache.delete(detailCache.keys().next().value);
  }
  detailCache.set(seriesId, { value, expires: Date.now() + DETAIL_CACHE_TTL_MS });
}

async function fetchDetailUncached(seriesId) {
  const response = await bytes(`https://hongguoduanju.com/player/${seriesId}`, {
    domains: ['hongguoduanju.com'],
    maxBytes: 4 * 1024 * 1024,
  });
  if (response.status !== 200) {
    throw Object.assign(new Error(`剧集页面请求失败（HTTP ${response.status}）`), { code: 'DETAIL_HTTP' });
  }
  const loader = routerData(response.data.toString('utf8')).loaderData;
  const page = loader?.['player_(series_id)/page'];
  const detail = page?.seriesDetail;
  if (
    page?.isSuccess !== true ||
    detail?.series_id !== seriesId ||
    typeof detail.series_name !== 'string' ||
    !Array.isArray(detail.vid_list) ||
    !detail.vid_list.length ||
    !detail.vid_list.every(id)
  ) {
    throw Object.assign(new Error('剧集详情格式变化'), { code: 'INVALID_DETAIL' });
  }
  return {
    seriesId,
    title: detail.series_name,
    cover: typeof detail.series_cover === 'string' ? detail.series_cover : '',
    intro: typeof detail.series_intro === 'string' ? detail.series_intro : '',
    tags: Array.isArray(detail.tags) ? detail.tags.filter(t => typeof t === 'string') : [],
    episodeText: typeof detail.episode_right_text === 'string' ? detail.episode_right_text : '',
    recordNumber: typeof detail.record_number === 'string' ? detail.record_number : '',
    celebrities: Array.isArray(detail.celebrities)
      ? detail.celebrities
          .filter(c => c && typeof c.nickname === 'string' && c.nickname.trim())
          .slice(0, 8)
          .map(c => ({
            nickname: c.nickname,
            role: typeof c.sub_title === 'string' ? c.sub_title : '',
            avatar: typeof c.avatar === 'string' ? c.avatar : '',
          }))
      : [],
    episodes: detail.vid_list.map((episodeId, index) => ({ episodeId, index: index + 1 })),
  };
}

async function details(seriesId, signal) {
  if (!id(seriesId)) throw Object.assign(new Error('剧集编号无效'), { code: 'INVALID_ID' });
  throwIfAborted(signal);
  const cached = getCachedDetail(seriesId);
  if (cached) return cached;

  let inflight = detailInflight.get(seriesId);
  if (!inflight) {
    inflight = fetchDetailUncached(seriesId)
      .then(result => {
        setCachedDetail(seriesId, result);
        return result;
      })
      .finally(() => {
        if (detailInflight.get(seriesId) === inflight) detailInflight.delete(seriesId);
      });
    detailInflight.set(seriesId, inflight);
  }
  const value = await raceWithSignal(inflight, signal);
  return { ...value, episodes: value.episodes.map(ep => ({ ...ep })) };
}

function parseTotalFromContentRange(headerValue) {
  if (typeof headerValue !== 'string') return 0;
  const match = headerValue.match(/\/(\d+)\s*$/);
  if (!match) return 0;
  const total = Number(match[1]);
  if (!Number.isSafeInteger(total) || total <= 0 || total > MAX_MEDIA_BYTES) return 0;
  return total;
}

async function probeFirstChunk(candidate, signal, transportBytes = bytes) {
  throwIfAborted(signal);
  const res = await transportBytes(candidate.url, {
    domains: MEDIA_DOMAINS,
    headers: { 'User-Agent': candidate.userAgent, Range: `bytes=0-${CHUNK_BYTES - 1}` },
    signal,
    maxBytes: MAX_MEDIA_BYTES,
    timeout: 20000,
  });
  if (res.status === 200 && res.data?.length) {
    return { candidate, complete: true, data: res.data };
  }
  if (res.status === 206 && res.data?.length) {
    const totalBytes = parseTotalFromContentRange(res.headers?.['content-range']);
    if (totalBytes > 0 && res.data.length >= totalBytes) {
      return { candidate, complete: true, data: res.data.subarray(0, totalBytes) };
    }
    if (totalBytes > 0) {
      return { candidate, complete: false, firstChunk: res.data, totalBytes };
    }
    // Upstream returned 206 without a valid total size; fall back to full GET.
    const full = await transportBytes(candidate.url, {
      domains: MEDIA_DOMAINS,
      headers: { 'User-Agent': candidate.userAgent },
      signal,
      maxBytes: MAX_MEDIA_BYTES,
      timeout: 90000,
    });
    if (full.status === 200 && full.data?.length) {
      return { candidate, complete: true, data: full.data };
    }
    throw Object.assign(new Error(`媒体请求失败（HTTP ${full.status}）`), { code: 'MEDIA_HTTP' });
  }
  throw Object.assign(new Error(`媒体请求失败（HTTP ${res.status}）`), { code: 'MEDIA_HTTP' });
}

async function probeGroup(candidates, signal, transportBytes = bytes) {
  throwIfAborted(signal);
  const controllers = candidates.map(() => new AbortController());
  const abortAll = () => {
    for (const c of controllers) {
      if (!c.signal.aborted) c.abort();
    }
  };
  const onParentAbort = () => abortAll();
  signal?.addEventListener('abort', onParentAbort, { once: true });
  let lastError = null;
  try {
    return await new Promise((resolve, reject) => {
      let remaining = candidates.length;
      let settled = false;
      if (remaining === 0) {
        reject(Object.assign(new Error('媒体请求失败'), { code: 'MEDIA_HTTP' }));
        return;
      }
      candidates.forEach((candidate, idx) => {
        probeFirstChunk(candidate, controllers[idx].signal, transportBytes).then(
          probe => {
            if (settled) return;
            settled = true;
            abortAll();
            resolve(probe);
          },
          error => {
            if (settled) return;
            if (signal?.aborted) {
              settled = true;
              abortAll();
              reject(makeAbortError());
              return;
            }
            if (error?.code !== 'ERR_CANCELED') lastError = error;
            remaining -= 1;
            if (remaining === 0) {
              settled = true;
              reject(lastError || Object.assign(new Error('媒体请求失败'), { code: 'MEDIA_HTTP' }));
            }
          },
        );
      });
    });
  } finally {
    signal?.removeEventListener('abort', onParentAbort);
    abortAll();
  }
}

async function fetchChunkWithRetry(candidate, start, end, signal, transportBytes) {
  const expectedLength = end - start + 1;
  let lastError;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    throwIfAborted(signal);
    try {
      const res = await transportBytes(candidate.url, {
        domains: MEDIA_DOMAINS,
        headers: { 'User-Agent': candidate.userAgent, Range: `bytes=${start}-${end}` },
        signal,
        maxBytes: CHUNK_BYTES + 1024,
        timeout: 25000,
      });
      if (res.status === 206 && res.data && res.data.length === expectedLength) {
        return res.data;
      }
      lastError = Object.assign(new Error(`分片请求异常（HTTP ${res.status}）`), { code: 'MEDIA_HTTP' });
    } catch (error) {
      if (error?.code === 'ERR_CANCELED' || signal?.aborted) throw error;
      lastError = error;
    }
  }
  throw lastError || Object.assign(new Error('分片请求失败'), { code: 'MEDIA_HTTP' });
}

async function downloadRemainingChunks(probe, signal, transportBytes = bytes) {
  throwIfAborted(signal);
  const { candidate, firstChunk, totalBytes } = probe;
  const output = Buffer.allocUnsafe(totalBytes);
  firstChunk.copy(output, 0);

  const tasks = [];
  for (let start = firstChunk.length; start < totalBytes; start += CHUNK_BYTES) {
    tasks.push([start, Math.min(totalBytes - 1, start + CHUNK_BYTES - 1)]);
  }
  if (!tasks.length) return output;

  const groupController = new AbortController();
  const onParentAbort = () => {
    if (!groupController.signal.aborted) groupController.abort();
  };
  signal?.addEventListener('abort', onParentAbort, { once: true });

  let cursor = 0;
  try {
    const workers = Math.min(CHUNK_CONCURRENCY, tasks.length);
    await Promise.all(
      Array.from({ length: workers }, async () => {
        while (cursor < tasks.length) {
          throwIfAborted(groupController.signal);
          const idx = cursor++;
          const [start, end] = tasks[idx];
          const chunk = await fetchChunkWithRetry(candidate, start, end, groupController.signal, transportBytes);
          chunk.copy(output, start);
        }
      }),
    );
    return output;
  } catch (error) {
    if (!groupController.signal.aborted) groupController.abort();
    throwIfAborted(signal);
    throw error;
  } finally {
    signal?.removeEventListener('abort', onParentAbort);
  }
}

async function downloadSingleFallback(candidate, signal, transportBytes = bytes) {
  throwIfAborted(signal);
  const res = await transportBytes(candidate.url, {
    domains: MEDIA_DOMAINS,
    headers: { 'User-Agent': candidate.userAgent },
    signal,
    maxBytes: MAX_MEDIA_BYTES,
    timeout: 90000,
  });
  if (res.status === 200 && res.data?.length) return res.data;
  throw Object.assign(new Error(`媒体请求失败（HTTP ${res.status}）`), { code: 'MEDIA_HTTP' });
}

async function downloadFromVariants(ordered, signal, transportBytes = bytes) {
  const groups = [
    ordered.filter(v => v.codec === 'h264'),
    ordered.filter(v => v.codec !== 'h264'),
  ].filter(group => group.length > 0);

  let lastError;
  for (const group of groups) {
    let batchOffset = 0;
    while (batchOffset < group.length) {
      throwIfAborted(signal);
      const batch = batchOffset === 0 ? group.slice(0, 2) : group.slice(batchOffset, batchOffset + 1);
      batchOffset += batch.length;
      let probe;
      try {
        probe = await probeGroup(batch, signal, transportBytes);
      } catch (error) {
        if (error?.code === 'ERR_CANCELED' || signal?.aborted) throw error;
        lastError = error;
        continue;
      }
      if (probe.complete) {
        return { variant: probe.candidate, data: probe.data };
      }
      try {
        const data = await downloadRemainingChunks(probe, signal, transportBytes);
        return { variant: probe.candidate, data };
      } catch (error) {
        if (error?.code === 'ERR_CANCELED' || signal?.aborted) throw error;
        lastError = error;
        // Fallback once to a plain full GET on the winning host in case Range chunking stalled/rejected.
        try {
          const data = await downloadSingleFallback(probe.candidate, signal, transportBytes);
          return { variant: probe.candidate, data };
        } catch (fallbackErr) {
          if (fallbackErr?.code === 'ERR_CANCELED' || signal?.aborted) throw fallbackErr;
          lastError = fallbackErr;
        }
      }
    }
  }
  throw lastError || Object.assign(new Error('媒体请求失败'), { code: 'MEDIA_HTTP' });
}

async function prepare({ seriesId, episodeId, signal, quality = 'auto' }) {
  const detail = await details(seriesId, signal);
  const episode = episodeId ? detail.episodes.find(item => item.episodeId === episodeId) : detail.episodes[0];
  if (!episode) throw Object.assign(new Error('所选分集不属于本剧'), { code: 'INVALID_EPISODE' });
  const model = await fetchAppPlayUrl(episode.episodeId, { quality, signal });
  const variants = (model.variants || [model]).filter(v => ['h264', 'hevc'].includes(v.codec));
  if (!variants.length) throw Object.assign(new Error('本集没有兼容 H.264/HEVC 片源'), { code: 'NO_COMPATIBLE_SOURCE' });
  // The upstream model already enforces the quality tier; prefer AVC within that tier.
  const ordered = [...variants.filter(v => v.codec === 'h264'), ...variants.filter(v => v.codec !== 'h264')];
  const { variant, data: rawBytes } = await downloadFromVariants(ordered, signal);
  const data = variant.contentKey ? decryptMp4Buffer(rawBytes, Buffer.from(variant.contentKey, 'hex')) : rawBytes;
  return { ...detail, episode, codec: variant.codec, quality: variant.quality, encrypted: !!variant.contentKey, data };
}

module.exports = { details, prepare, downloadFromVariants, clearDetailCache };
