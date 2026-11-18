'use strict';
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { prepare } = require('./playback.cjs');

const DEFAULT_DOWNLOAD_DIR = process.env.HG_NSH_DOWNLOAD_DIR || path.join(__dirname, '../.tmp/downloads');

function createDownloadManager({ downloadDir = DEFAULT_DOWNLOAD_DIR, prepareMedia = prepare } = {}) {
  const tasks = new Map();
  const controllers = new Map();
  const indexPath = path.join(downloadDir, 'tasks.json');
  let persistChain = Promise.resolve();

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

  function loadPersistedTasks() {
    try {
      if (!fsSync.existsSync(indexPath)) return;
      const raw = fsSync.readFileSync(indexPath, 'utf8');
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return;
      for (const item of parsed) {
        if (!item || typeof item.id !== 'string' || typeof item.seriesId !== 'string') continue;
        const filePath = typeof item.filePath === 'string' ? item.filePath : '';
        let status = item.status;
        let error = typeof item.error === 'string' ? item.error : undefined;
        if (status === 'downloading') {
          status = 'failed';
          error = '服务重启中断，可点击重试';
        } else if (status === 'completed' && (!filePath || !fsSync.existsSync(filePath))) {
          status = 'failed';
          error = '离线文件已丢失';
        }
        tasks.set(item.id, {
          id: item.id,
          seriesId: item.seriesId,
          episodeId: typeof item.episodeId === 'string' ? item.episodeId : '',
          title: typeof item.title === 'string' ? item.title : '未知短剧',
          episodeIndex: Number.isInteger(item.episodeIndex) && item.episodeIndex > 0 ? item.episodeIndex : 1,
          quality: typeof item.quality === 'string' ? item.quality : 'auto',
          codec: typeof item.codec === 'string' ? item.codec : '',
          status: status === 'completed' || status === 'cancelled' || status === 'failed' ? status : 'failed',
          bytes: typeof item.bytes === 'number' && item.bytes >= 0 ? item.bytes : 0,
          createdAt: typeof item.createdAt === 'number' ? item.createdAt : Date.now(),
          filePath,
          ...(error ? { error } : {}),
        });
      }
      // Clean up orphaned .part files from interrupted runs.
      for (const entry of fsSync.readdirSync(downloadDir)) {
        if (entry.endsWith('.part')) {
          try {
            fsSync.unlinkSync(path.join(downloadDir, entry));
          } catch {}
        }
      }
    } catch {
      // Ignore corrupt index and start clean.
    }
  }

  function persistTasks() {
    const snapshot = Array.from(tasks.values());
    persistChain = persistChain
      .then(async () => {
        await fs.mkdir(downloadDir, { recursive: true });
        const tmp = `${indexPath}.${process.pid}.tmp`;
        await fs.writeFile(tmp, JSON.stringify(snapshot, null, 2), { mode: 0o600 });
        await fs.rename(tmp, indexPath);
      })
      .catch(() => {});
    return persistChain;
  }

  function runTask(task) {
    const controller = new AbortController();
    controllers.set(task.id, controller);

    (async () => {
      try {
        const prepared = await prepareMedia({
          seriesId: task.seriesId,
          episodeId: task.episodeId || undefined,
          quality: task.quality,
          signal: controller.signal,
        });
        if (controller.signal.aborted) return;
        await fs.mkdir(downloadDir, { recursive: true });
        const fileName = `${prepared.seriesId}-${prepared.episode.episodeId}-${task.id}.mp4`;
        const target = path.join(downloadDir, fileName);
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
        delete task.error;
      } catch (error) {
        if (controller.signal.aborted) {
          task.status = 'cancelled';
          task.error = '已取消下载';
        } else {
          task.status = 'failed';
          task.error = error?.message || '下载失败';
        }
      } finally {
        controllers.delete(task.id);
        await persistTasks();
      }
    })();
  }

  loadPersistedTasks();

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
    void persistTasks();
    runTask(task);
    return sanitizeTask(task);
  }

  function retryDownload(id) {
    const task = tasks.get(id);
    if (!task) throw Object.assign(new Error('下载任务不存在'), { code: 'NOT_FOUND' });
    if (task.status === 'downloading' || task.status === 'completed') {
      return sanitizeTask(task);
    }
    task.status = 'downloading';
    task.bytes = 0;
    delete task.error;
    void persistTasks();
    runTask(task);
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
      void persistTasks();
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
    await persistTasks();
    return { deleted: id };
  }

  async function clearDownloads(scope = 'finished') {
    const removed = [];
    for (const [id, task] of Array.from(tasks.entries())) {
      if (task.status === 'downloading') continue;
      const shouldDelete =
        scope === 'all' ||
        (scope === 'completed' && task.status === 'completed') ||
        (scope === 'finished' && (task.status === 'failed' || task.status === 'cancelled'));
      if (!shouldDelete) continue;
      if (task.filePath) {
        await fs.rm(task.filePath, { force: true }).catch(() => {});
      }
      tasks.delete(id);
      removed.push(id);
    }
    await persistTasks();
    return { cleared: removed.length };
  }

  async function readDownloadedMedia(id) {
    const task = tasks.get(id);
    if (!task || task.status !== 'completed' || !task.filePath) {
      throw Object.assign(new Error('离线媒体不可用'), { code: 'NOT_FOUND' });
    }
    const data = await fs.readFile(task.filePath);
    return { task: sanitizeTask(task), data };
  }

  return {
    listDownloads,
    startDownload,
    retryDownload,
    cancelDownload,
    deleteDownload,
    clearDownloads,
    readDownloadedMedia,
    flushPersistence: () => persistChain,
  };
}

const defaultManager = createDownloadManager();

module.exports = {
  ...defaultManager,
  createDownloadManager,
};
