'use strict';
const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { prepare, details } = require('./playback.cjs');
const { parseRange } = require('./range.cjs');
const { searchDramas, browseCategory, browseRank } = require('./discover.cjs');
const { fetchDanmaku } = require('./danmaku.cjs');
const { createQrLogin, pollQrLogin, sendSmsCode, smsLogin, fetchCloudHistory, fetchCloudBookshelf, restoreSession, getAccountStatus, logoutAccount } = require('./auth.cjs');
const { listDownloads, startDownload, retryDownload, cancelDownload, deleteDownload, clearDownloads, readDownloadedMedia } = require('./downloads.cjs');
const { setKeepAwake, stopKeepAwake } = require('./keep-awake.cjs');

const ALLOWED_QUALITIES = new Set(['auto', '1080p', '720p', '540p', '480p', '360p']);

async function readJsonBody(req, maxBytes = 4096) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw Object.assign(new Error('请求过大'), { code: 'INVALID_REQUEST' });
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString().trim();
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw Object.assign(new Error('请求 JSON 格式无效'), { code: 'INVALID_REQUEST' });
  }
}

const MAX_CACHED_EPISODES = 4;
const MEDIA_CACHE_TTL_MS = 30 * 60 * 1000;

function cacheKeyOf(seriesId, episodeId, quality) {
  return seriesId && episodeId ? `${seriesId}:${episodeId}:${quality || 'auto'}` : '';
}

function raceAbort(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(Object.assign(new Error('已取消'), { code: 'ERR_CANCELED' }));
  let onAbort;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      onAbort = () => reject(Object.assign(new Error('已取消'), { code: 'ERR_CANCELED' }));
      signal.addEventListener('abort', onAbort, { once: true });
    }),
  ]).finally(() => {
    if (onAbort) signal.removeEventListener('abort', onAbort);
  });
}

function createService({ token = crypto.randomBytes(32).toString('hex'), prepareMedia = prepare, fetchDanmaku: fetchDanmakuList = fetchDanmaku, keepAwake = { setKeepAwake, stopKeepAwake } } = {}) {
  const files = new Map();
  const episodeCache = new Map();
  let active;
  let prefetch = null;
  let closed = false;

  function deleteMediaPath(mediaPath) {
    const entry = files.get(mediaPath);
    if (entry?.cacheKey && episodeCache.get(entry.cacheKey) === mediaPath) {
      episodeCache.delete(entry.cacheKey);
    }
    files.delete(mediaPath);
  }

  function pruneExpiredMedia() {
    const now = Date.now();
    for (const [key, value] of files) {
      if (value.expires <= now) deleteMediaPath(key);
    }
  }

  function registerMediaBuffer(data, host, metadata = null, cacheKey = '') {
    const mediaPath = `/media/${crypto.randomBytes(32).toString('hex')}`;
    pruneExpiredMedia();
    if (cacheKey && episodeCache.has(cacheKey)) {
      deleteMediaPath(episodeCache.get(cacheKey));
    }
    while (files.size >= MAX_CACHED_EPISODES) {
      deleteMediaPath(files.keys().next().value);
    }
    files.set(mediaPath, {
      data,
      metadata,
      cacheKey,
      expires: Date.now() + MEDIA_CACHE_TTL_MS,
    });
    if (cacheKey) episodeCache.set(cacheKey, mediaPath);
    return { mediaPath, mediaUrl: `http://${host}${mediaPath}` };
  }

  function getCachedMedia(cacheKey, host) {
    if (!cacheKey) return null;
    pruneExpiredMedia();
    const mediaPath = episodeCache.get(cacheKey);
    if (!mediaPath) return null;
    const entry = files.get(mediaPath);
    if (!entry || entry.expires <= Date.now()) {
      deleteMediaPath(mediaPath);
      return null;
    }
    // Refresh LRU order on cache hit.
    files.delete(mediaPath);
    files.set(mediaPath, entry);
    return entry.metadata ? { ...entry.metadata, mediaUrl: `http://${host}${mediaPath}` } : null;
  }

  function cancelPrefetch() {
    if (!prefetch) return;
    if (prefetch.timer) clearTimeout(prefetch.timer);
    if (!prefetch.controller.signal.aborted) prefetch.controller.abort();
    prefetch = null;
  }

  function schedulePrefetchNext(metadata, quality, host) {
    if (closed || !metadata || !Array.isArray(metadata.episodes) || !metadata.episode?.episodeId) return;
    const idx = metadata.episodes.findIndex(ep => ep.episodeId === metadata.episode.episodeId);
    const nextEp = idx >= 0 ? metadata.episodes[idx + 1] : null;
    if (!nextEp?.episodeId) return;
    const nextKey = cacheKeyOf(metadata.seriesId, nextEp.episodeId, quality);
    if (!nextKey || getCachedMedia(nextKey, host)) return;
    if (prefetch && prefetch.key === nextKey) return;

    cancelPrefetch();
    const pfController = new AbortController();
    const entry = {
      key: nextKey,
      controller: pfController,
      timer: null,
      promise: null,
      startNow: null,
    };
    entry.startNow = () => {
      if (entry.promise) return entry.promise;
      if (entry.timer) {
        clearTimeout(entry.timer);
        entry.timer = null;
      }
      entry.promise = (async () => {
        try {
          const res = await prepareMedia({
            seriesId: metadata.seriesId,
            episodeId: nextEp.episodeId,
            quality,
            signal: pfController.signal,
          });
          if (closed || pfController.signal.aborted) {
            return { ok: false, error: Object.assign(new Error('已取消'), { code: 'ERR_CANCELED' }) };
          }
          const { data, ...nextMeta } = res;
          const registered = registerMediaBuffer(data, host, nextMeta, nextKey);
          return { ok: true, payload: { ...nextMeta, mediaUrl: registered.mediaUrl } };
        } catch (error) {
          return { ok: false, error };
        } finally {
          if (prefetch === entry) prefetch = null;
        }
      })();
      return entry.promise;
    };
    entry.timer = setTimeout(() => {
      entry.timer = null;
      if (!closed && prefetch === entry && !pfController.signal.aborted) {
        void entry.startNow();
      }
    }, 150);
    entry.timer.unref?.();
    prefetch = entry;
  }

  function json(res, status, body) {
    if (!res.headersSent) {
      res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));
    }
  }

  const server = http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    const host = `127.0.0.1:${server.address().port}`;
    if (req.headers.host !== host || req.headers.origin) {
      res.writeHead(403).end();
      return;
    }
    const url = new URL(req.url, `http://${host}`);
    if (req.method === 'GET' || req.method === 'HEAD') {
      const media = files.get(url.pathname);
      if (media && media.expires > Date.now()) {
        const range = parseRange(req.headers.range, media.data.length);
        if (!range) {
          res.writeHead(416, { 'Content-Range': `bytes */${media.data.length}` }).end();
          return;
        }
        const headers = {
          'Content-Type': 'video/mp4',
          'Accept-Ranges': 'bytes',
          'Content-Length': range.end - range.start + 1,
        };
        if (range.partial) headers['Content-Range'] = `bytes ${range.start}-${range.end}/${media.data.length}`;
        res.writeHead(range.partial ? 206 : 200, headers);
        res.end(req.method === 'HEAD' ? undefined : media.data.subarray(range.start, range.end + 1));
        return;
      }
    }
    if (req.headers.authorization !== `Bearer ${token}`) {
      res.writeHead(401).end();
      return;
    }

    if (req.method === 'GET' && url.pathname === '/auth/status') {
      try {
        json(res, 200, await restoreSession());
      } catch {
        json(res, 200, getAccountStatus());
      }
      return;
    }
    if (req.method === 'GET' && url.pathname === '/auth/cloud-history') {
      try {
        json(res, 200, await fetchCloudHistory());
      } catch (error) {
        const status = error.code === 'AUTH_REQUIRED' ? 401 : 502;
        json(res, status, { code: error.code || 'CLOUD_HISTORY_ERROR', message: error.message });
      }
      return;
    }
    if (req.method === 'GET' && url.pathname === '/auth/cloud-bookshelf') {
      try {
        json(res, 200, await fetchCloudBookshelf());
      } catch (error) {
        const status = error.code === 'AUTH_REQUIRED' ? 401 : 502;
        json(res, status, { code: error.code || 'CLOUD_BOOKSHELF_ERROR', message: error.message });
      }
      return;
    }
    if (req.method === 'GET' && url.pathname === '/downloads') {
      json(res, 200, { items: listDownloads() });
      return;
    }

    if (req.method !== 'POST') {
      res.writeHead(404).end();
      return;
    }

    if (url.pathname === '/play') {
      if (active) active.abort();
      const controller = new AbortController();
      active = controller;
      const abort = () => controller.abort();
      res.once('close', abort);
      try {
        const input = await readJsonBody(req, 2048);
        if (!input || typeof input !== 'object' || typeof input.seriesId !== 'string' || !/^\d{1,30}$/.test(input.seriesId)
          || (input.episodeId !== undefined && typeof input.episodeId !== 'string')) {
          throw Object.assign(new Error('请求字段无效'), { code: 'INVALID_REQUEST' });
        }
        const quality = typeof input.quality === 'string' && ALLOWED_QUALITIES.has(input.quality) ? input.quality : 'auto';
        const requestKey = input.episodeId ? cacheKeyOf(input.seriesId, input.episodeId, quality) : '';
        const cached = getCachedMedia(requestKey, host);
        if (cached) {
          json(res, 200, cached);
          schedulePrefetchNext(cached, quality, host);
          return;
        }
        let payload;
        if (requestKey && prefetch && prefetch.key === requestKey) {
          const currentPrefetch = prefetch;
          const outcome = await raceAbort(currentPrefetch.startNow(), controller.signal);
          if (controller.signal.aborted) return;
          if (!outcome.ok) throw outcome.error;
          payload = outcome.payload;
        } else {
          cancelPrefetch();
          const result = await prepareMedia({ seriesId: input.seriesId, episodeId: input.episodeId, quality, signal: controller.signal });
          if (controller.signal.aborted) return;
          const { data, ...metadata } = result;
          const finalKey = cacheKeyOf(metadata.seriesId || input.seriesId, metadata.episode?.episodeId || input.episodeId, quality);
          const { mediaUrl } = registerMediaBuffer(data, host, metadata, finalKey);
          payload = { ...metadata, mediaUrl };
        }
        json(res, 200, payload);
        schedulePrefetchNext(payload, quality, host);
      } catch (error) {
        if (!controller.signal.aborted) {
          json(res, 502, { code: error.code || 'PLAYBACK_FAILED', message: error.message });
        } else if (!res.headersSent && !res.destroyed) {
          json(res, 499, { code: 'ERR_CANCELED', message: '已取消' });
        }
      } finally {
        res.off('close', abort);
        if (active === controller) active = undefined;
      }
      return;
    }

    const controller = new AbortController();
    const abort = () => controller.abort();
    res.once('close', abort);
    try {
      const input = await readJsonBody(req);
      if (url.pathname === '/detail') {
        if (typeof input.seriesId !== 'string' || !/^\d{1,30}$/.test(input.seriesId)) {
          throw Object.assign(new Error('剧集编号无效'), { code: 'INVALID_REQUEST' });
        }
        json(res, 200, await details(input.seriesId, controller.signal));
      } else if (url.pathname === '/danmaku') {
        if (typeof input.seriesId !== 'string' || !/^\d{1,30}$/.test(input.seriesId)
          || typeof input.episodeId !== 'string' || !/^\d{1,30}$/.test(input.episodeId)) {
          throw Object.assign(new Error('剧集或分集编号无效'), { code: 'INVALID_REQUEST' });
        }
        json(res, 200, await fetchDanmakuList({
          seriesId: input.seriesId,
          episodeId: input.episodeId,
          startMs: input.startMs,
          durationMs: input.durationMs,
          signal: controller.signal,
        }));
      } else if (url.pathname === '/search') {
        json(res, 200, await searchDramas({ keyword: input.keyword, page: input.page, cursor: input.cursor, signal: controller.signal }));
      } else if (url.pathname === '/discover/category') {
        json(res, 200, await browseCategory({
          genre: input.genre,
          theme: input.theme,
          role: input.role,
          epoch: input.epoch,
          sort: input.sort,
          gender: input.gender,
          onlineTime: input.onlineTime,
          offset: input.offset,
          sessionId: input.sessionId,
          needSelectorPanel: input.needSelectorPanel,
          limit: input.limit,
          signal: controller.signal,
        }));
      } else if (url.pathname === '/discover/rank') {
        json(res, 200, await browseRank({
          rankType: input.rankType,
          outerTab: input.outerTab,
          subTab: input.subTab,
          offset: input.offset,
          sessionId: input.sessionId,
          limit: input.limit,
          signal: controller.signal,
        }));
      } else if (url.pathname === '/auth/qr') {
        json(res, 200, await createQrLogin(controller.signal));
      } else if (url.pathname === '/auth/poll') {
        json(res, 200, await pollQrLogin(input.token, controller.signal));
      } else if (url.pathname === '/auth/sms/send') {
        json(res, 200, await sendSmsCode({ mobile: input.mobile, captcha: input.captcha }, controller.signal));
      } else if (url.pathname === '/auth/sms/login') {
        json(res, 200, await smsLogin({ mobile: input.mobile, code: input.code, captcha: input.captcha }, controller.signal));
      } else if (url.pathname === '/auth/logout') {
        json(res, 200, await logoutAccount());
      } else if (url.pathname === '/keep-awake') {
        keepAwake.setKeepAwake(input.active === true);
        json(res, 200, { active: input.active === true });
      } else if (url.pathname === '/downloads/start') {
        const quality = typeof input.quality === 'string' && ALLOWED_QUALITIES.has(input.quality) ? input.quality : 'auto';
        json(res, 200, startDownload({ seriesId: input.seriesId, episodeId: input.episodeId, quality }));
      } else if (url.pathname === '/downloads/retry') {
        json(res, 200, retryDownload(input.id));
      } else if (url.pathname === '/downloads/cancel') {
        json(res, 200, cancelDownload(input.id));
      } else if (url.pathname === '/downloads/delete') {
        json(res, 200, await deleteDownload(input.id));
      } else if (url.pathname === '/downloads/clear') {
        const scope = input.scope === 'all' || input.scope === 'completed' || input.scope === 'finished' ? input.scope : 'finished';
        json(res, 200, await clearDownloads(scope));
      } else if (url.pathname === '/downloads/play') {
        const { task, data } = await readDownloadedMedia(input.id);
        const { mediaUrl } = registerMediaBuffer(data, host);
        json(res, 200, {
          seriesId: task.seriesId,
          title: task.title,
          episode: { episodeId: task.episodeId, index: task.episodeIndex },
          episodes: [{ episodeId: task.episodeId, index: task.episodeIndex }],
          codec: task.codec || 'hevc',
          quality: task.quality || 'auto',
          encrypted: false,
          mediaUrl,
        });
      } else {
        res.writeHead(404).end();
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        const status = error.code === 'INVALID_REQUEST' || error.code === 'APP_INPUT' ? 400 : error.code === 'NOT_FOUND' ? 404 : 502;
        json(res, status, { code: error.code || 'SERVICE_ERROR', message: error.message });
      }
    } finally {
      res.off('close', abort);
    }
  });

  server.on('close', () => {
    closed = true;
    active?.abort();
    cancelPrefetch();
    keepAwake.stopKeepAwake();
    files.clear();
    episodeCache.clear();
  });
  return { server, token };
}

async function start() {
  await restoreSession(AbortSignal.timeout(2500)).catch(() => {});
  const { server, token } = createService();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const launchFile = process.env.HG_NSH_LAUNCH_FILE;
  if (launchFile) {
    // The launcher execs the UI in place. Stop serving when that process exits.
    const parent = process.ppid;
    if (parent === 1) process.exit(0);
    setInterval(() => {
      if (process.ppid !== parent) process.exit(0);
    }, 1000).unref();
    await fs.writeFile(launchFile + '.ready', `${baseUrl} ${token}\n`, { mode: 0o600 });
    await fs.rename(launchFile + '.ready', launchFile);
  } else {
    const target = path.join(__dirname, '../.tmp/service-config.ts');
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, `export const serviceConfig = ${JSON.stringify({ baseUrl, token })};\n`, { mode: 0o600 });
    await fs.writeFile(path.join(__dirname, '../.tmp/service-ready'), String(process.pid));
    console.log('本机播放服务已启动（凭证仅写入被忽略的项目临时配置）');
  }
  const stop = () => {
    server.close();
    process.exit(0);
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

if (require.main === module) {
  start().catch(() => {
    console.error('启动本机播放服务失败');
    process.exitCode = 1;
  });
}

module.exports = { createService };
