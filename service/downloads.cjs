'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { prepare } = require('./playback.cjs');

const DOWNLOAD_DIR = path.join(__dirname, '../.tmp/downloads');
const tasks = new Map();
const controllers = new Map();

function sanitizeTask(task) {
  return {
    id: task.id,
    seriesId: task.seriesId,
    episodeId: task.episodeId,
    title: task.title,
    episodeIndex: task.episodeIndex,
    quality: task.quality,
    codec: task.codec,
    status: task.status,
    bytes: task.bytes,
    createdAt: task.createdAt,
    ...(task.error ? { error: task.error } : {}),
  };
}

function listDownloads() {
  return Array.from(tasks.values()).map(sanitizeTask).sort((a, b) => b.createdAt - a.createdAt);
}

function startDownload({ seriesId, episodeId, quality = 'auto' }) {
  if (typeof seriesId !== 'string' || !/^\d{1,30}$/.test(seriesId)) {
    throw Object.assign(new Error('剧集编号无效'), { code: 'INVALID_REQUEST' });
  }
  if (episodeId !== undefined && (typeof episodeId !== 'string' || !/^\d{1,30}$/.test(episodeId))) {
    throw Object.assign(new Error('分集编号无效'), { code: 'INVALID_REQUEST' });
  }
  const id = crypto.randomBytes(12).toString('hex');
  const controller = new AbortController();
  const task = {
    id,
    seriesId,
    episodeId: episodeId || '',
    title: '正在获取剧集信息…',
    episodeIndex: 1,
    quality,
    codec: '',
    status: 'downloading',
    bytes: 0,
    createdAt: Date.now(),
    filePath: '',
  };
  tasks.set(id, task);
  controllers.set(id, controller);

  (async () => {
    try {
      const prepared = await prepare({ seriesId, episodeId, quality, signal: controller.signal });
      if (controller.signal.aborted) return;
      await fs.mkdir(DOWNLOAD_DIR, { recursive: true });
      const fileName = `${prepared.seriesId}-${prepared.episode.episodeId}-${id}.mp4`;
      const target = path.join(DOWNLOAD_DIR, fileName);
      const tmpTarget = `${target}.part`;
      await fs.writeFile(tmpTarget, prepared.data, { mode: 0o600 });
      await fs.rename(tmpTarget, target);
      if (controller.signal.aborted) {
        await fs.rm(target, { force: true }).catch(() => {});
        return;
      }
      task.episodeId = prepared.episode.episodeId;
      task.title = prepared.title;
      task.episodeIndex = prepared.episode.index;
      task.quality = prepared.quality;
      task.codec = prepared.codec;
      task.bytes = prepared.data.length;
      task.filePath = target;
      task.status = 'completed';
    } catch (error) {
      if (controller.signal.aborted) {
        task.status = 'cancelled';
        task.error = '已取消下载';
      } else {
        task.status = 'failed';
        task.error = error?.message || '下载失败';
      }
    } finally {
      controllers.delete(id);
    }
  })();

  return sanitizeTask(task);
}

function cancelDownload(id) {
  const task = tasks.get(id);
  if (!task) throw Object.assign(new Error('下载任务不存在'), { code: 'NOT_FOUND' });
  const controller = controllers.get(id);
  if (controller) {
    controller.abort();
    task.status = 'cancelled';
    task.error = '已取消下载';
  }
  return sanitizeTask(task);
}

async function deleteDownload(id) {
  const task = tasks.get(id);
  if (!task) throw Object.assign(new Error('下载任务不存在'), { code: 'NOT_FOUND' });
  const controller = controllers.get(id);
  if (controller) controller.abort();
  if (task.filePath) {
    await fs.rm(task.filePath, { force: true });
  }
  tasks.delete(id);
  return { deleted: id };
}

async function readDownloadedMedia(id) {
  const task = tasks.get(id);
  if (!task || task.status !== 'completed' || !task.filePath) {
    throw Object.assign(new Error('离线媒体不可用'), { code: 'NOT_FOUND' });
  }
  const data = await fs.readFile(task.filePath);
  return { task: sanitizeTask(task), data };
}

module.exports = {
  listDownloads,
  startDownload,
  cancelDownload,
  deleteDownload,
  readDownloadedMedia,
};
