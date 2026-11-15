'use strict';
const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { prepare, details } = require('./playback.cjs');
const { parseRange } = require('./range.cjs');
const { searchDramas } = require('./discover.cjs');
const { createQrLogin, pollQrLogin, getAccountStatus, logoutAccount } = require('./auth.cjs');
const { listDownloads, startDownload, cancelDownload, deleteDownload, readDownloadedMedia } = require('./downloads.cjs');

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

function createService({ token = crypto.randomBytes(32).toString('hex'), prepareMedia = prepare } = {}) {
  const files = new Map();
  let active;

  function registerMediaBuffer(data, host) {
    const mediaPath = `/media/${crypto.randomBytes(32).toString('hex')}`;
    for (const [key, value] of files) if (value.expires <= Date.now()) files.delete(key);
    // Two full episodes at most in this development-only cache.
    while (files.size >= 2) files.delete(files.keys().next().value);
    files.set(mediaPath, { data, expires: Date.now() + 30 * 60 * 1000 });
    return `http://${host}${mediaPath}`;
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
      json(res, 200, getAccountStatus());
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
      if (active) {
        json(res, 409, { code: 'BUSY', message: '已有一集正在准备，请稍后重试' });
        return;
      }
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
        const result = await prepareMedia({ seriesId: input.seriesId, episodeId: input.episodeId, quality, signal: controller.signal });
        if (controller.signal.aborted) return;
        const mediaUrl = registerMediaBuffer(result.data, host);
        const { data, ...metadata } = result;
        json(res, 200, { ...metadata, mediaUrl });
      } catch (error) {
        if (!controller.signal.aborted) {
          json(res, 502, { code: error.code || 'PLAYBACK_FAILED', message: error.message });
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
      } else if (url.pathname === '/search') {
        json(res, 200, await searchDramas({ keyword: input.keyword, page: input.page, cursor: input.cursor, signal: controller.signal }));
      } else if (url.pathname === '/auth/qr') {
        json(res, 200, await createQrLogin(controller.signal));
      } else if (url.pathname === '/auth/poll') {
        json(res, 200, await pollQrLogin(input.token, controller.signal));
      } else if (url.pathname === '/auth/logout') {
        json(res, 200, logoutAccount());
      } else if (url.pathname === '/downloads/start') {
        const quality = typeof input.quality === 'string' && ALLOWED_QUALITIES.has(input.quality) ? input.quality : 'auto';
        json(res, 200, startDownload({ seriesId: input.seriesId, episodeId: input.episodeId, quality }));
      } else if (url.pathname === '/downloads/cancel') {
        json(res, 200, cancelDownload(input.id));
      } else if (url.pathname === '/downloads/delete') {
        json(res, 200, await deleteDownload(input.id));
      } else if (url.pathname === '/downloads/play') {
        const { task, data } = await readDownloadedMedia(input.id);
        const mediaUrl = registerMediaBuffer(data, host);
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
    active?.abort();
    files.clear();
  });
  return { server, token };
}

async function start() {
  const { server, token } = createService();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const target = path.join(__dirname, '../.tmp/service-config.ts');
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, `export const serviceConfig = ${JSON.stringify({ baseUrl, token })};\n`, { mode: 0o600 });
  await fs.writeFile(path.join(__dirname, '../.tmp/service-ready'), String(process.pid));
  console.log('本机播放服务已启动（凭证仅写入被忽略的项目临时配置）');
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
