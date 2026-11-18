'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs/promises');
const { parseSearchResponse, parseCategoryResponse, parseRankResponse, catalogCover } = require('./discover.cjs');
const { parseHome } = require('../src/providers/catalog.ts');
const keychain = require('./keychain.cjs');
const { storeCookies, cookieHeaderFor, getAccountStatus, logoutAccount, mixEncode, normalizeMobile, restoreSession } = require('./auth.cjs');
const { createDownloadManager } = require('./downloads.cjs');

test('parseSearchResponse preserves large integer IDs and deduplicates entries', () => {
  const result = parseSearchResponse({
    search_tabs: [
      {
        has_more: true,
        search_id: 's1',
        next_offset: 20,
        data: [
          { book_data: [{ series_id: '7503745441910017049', series_name: '宴律，你的白月光回国了', thumb_url: 'https://p3.byteimg.com/cover.jpg', episode_cnt: 76, score: '9.4', tags: ['甜宠'] }] },
          { book_data: [{ series_id: '7503745441910017049', series_name: '重复条目' }] },
          { book_data: [{ series_id: 'not-an-id', series_name: '无效条目' }] },
        ],
      },
    ],
  });
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].id, '7503745441910017049');
  assert.equal(result.items[0].episodes, 76);
  assert.equal(result.hasMore, true);
  assert.deepEqual(result.cursor, { search_id: 's1', next_offset: 20 });

  const fallbackResult = parseSearchResponse({
    data: {
      has_more: false,
      book_list: [{ series_id: '7503745441910017050', series_name: '回退列表短剧', episode_cnt: 30 }],
    },
  });
  assert.equal(fallbackResult.items.length, 1);
  assert.equal(fallbackResult.hasMore, false);
});

test('parseHome filters null video_list rows and rejects untrusted covers', () => {
  const html = `<html><script>window._ROUTER_DATA = ${JSON.stringify({
    loaderData: {
      page: {
        isSuccess: true,
        homeSections: [
          {
            tab_name: '推荐',
            video_list: [
              null,
              {
                series_id: '7503745441910017049',
                series_title: '测试短剧',
                series_cover: 'https://p3-sign.byteimg.com/cover.jpg',
                episode_cnt: 60,
              },
            ],
          },
        ],
      },
    },
  })};</script></html>`;
  const sections = parseHome(html);
  assert.equal(sections.length, 1);
  assert.equal(sections[0].dramas.length, 1);
  assert.equal(sections[0].dramas[0].id, '7503745441910017049');
});

test('auth cookie jar scopes cookies by domain and clears on logout', async () => {
  assert.equal(keychain.isAvailable(), false);
  const noopStore = {
    isAvailable: () => false,
    readSecret: async () => null,
    saveSecret: async () => false,
    deleteSecret: async () => false,
  };
  await logoutAccount(noopStore);
  assert.equal(getAccountStatus().loggedIn, false);
  storeCookies({ 'set-cookie': ['sid=abc; Domain=.douyin.com; Path=/; HttpOnly', 'csrf=123; Path=/'] }, 'https://sso.douyin.com/passport/web/get_qrcode/');
  assert.match(cookieHeaderFor('https://sso.douyin.com/passport/account/info/v2/'), /sid=abc/);
  assert.match(cookieHeaderFor('https://sso.douyin.com/passport/account/info/v2/'), /csrf=123/);
  assert.equal(cookieHeaderFor('https://hongguoduanju.com/'), '');
  await logoutAccount(noopStore);
  assert.equal(cookieHeaderFor('https://sso.douyin.com/'), '');
});

test('auth mixEncode and normalizeMobile encode phone numbers cleanly', () => {
  assert.equal(normalizeMobile('13800138000'), '+8613800138000');
  assert.equal(normalizeMobile(' +86 138-0013-8000 '), '+8613800138000');
  assert.throws(() => normalizeMobile('12345'));
  // '+86' -> 0x2b^5=2e, 0x38^5=3d, 0x36^5=33
  assert.equal(mixEncode('+86'), '2e3d33');
});

test('restoreSession clears malformed keychain payload and logout deletes secret', async () => {
  let deleted = false;
  const mockStore = {
    isAvailable: () => true,
    readSecret: async () => 'not-json',
    saveSecret: async () => true,
    deleteSecret: async () => { deleted = true; return true; },
  };
  const status = await restoreSession(undefined, mockStore, true);
  assert.equal(status.loggedIn, false);
  assert.equal(deleted, true);
  deleted = false;
  await logoutAccount(mockStore);
  assert.equal(deleted, true);
});

test('download manager persists tasks, recovers interrupted runs on restart, retries and clears', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hg-dl-'));
  try {
    let shouldFail = true;
    const manager1 = createDownloadManager({
      downloadDir: dir,
      prepareMedia: async ({ seriesId, episodeId }) => {
        if (shouldFail) throw new Error('网络超时');
        return {
          seriesId,
          title: '测试短剧',
          episode: { episodeId: episodeId || '1001', index: 2 },
          quality: '1080p',
          codec: 'hevc',
          data: Buffer.from('mp4-bytes'),
        };
      },
    });
    const created = manager1.startDownload({ seriesId: '7503745441910017049', episodeId: '1001', quality: '1080p' });
    await new Promise(r => setTimeout(r, 30));
    await manager1.flushPersistence();
    assert.equal(manager1.listDownloads()[0].status, 'failed');

    // Simulate a leftover downloading task in tasks.json and restart.
    const indexPath = path.join(dir, 'tasks.json');
    const saved = JSON.parse(await fs.readFile(indexPath, 'utf8'));
    saved.push({
      id: 'interrupted1',
      seriesId: '7503745441910017049',
      episodeId: '1002',
      title: '中断任务',
      episodeIndex: 3,
      quality: '720p',
      codec: '',
      status: 'downloading',
      bytes: 0,
      createdAt: Date.now(),
      filePath: '',
    });
    await fs.writeFile(indexPath, JSON.stringify(saved));

    shouldFail = false;
    const manager2 = createDownloadManager({
      downloadDir: dir,
      prepareMedia: async ({ seriesId, episodeId }) => ({
        seriesId,
        title: '测试短剧',
        episode: { episodeId: episodeId || '1001', index: 2 },
        quality: '1080p',
        codec: 'hevc',
        data: Buffer.from('mp4-bytes'),
      }),
    });
    const listAfterRestart = manager2.listDownloads();
    const interrupted = listAfterRestart.find(t => t.id === 'interrupted1');
    assert.equal(interrupted.status, 'failed');
    assert.match(interrupted.error, /重启中断/);

    manager2.retryDownload(created.id);
    await new Promise(r => setTimeout(r, 30));
    await manager2.flushPersistence();
    const retried = manager2.listDownloads().find(t => t.id === created.id);
    assert.equal(retried.status, 'completed');
    assert.equal(retried.bytes, 9);

    const cleared = await manager2.clearDownloads('finished');
    assert.equal(cleared.cleared, 1);
    assert.equal(manager2.listDownloads().length, 1);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('catalogCover converts safe heic covers and parseCategoryResponse / parseRankResponse parse valid payloads', () => {
  assert.equal(
    catalogCover('https://p3-novel.byteimg.com/novel-pic/abc~tplv-noop.heic'),
    'https://p3-novel.byteimg.com/novel-pic/abc~tplv-shrink:640:0.image',
  );
  assert.equal(catalogCover('https://evil.test/novel-pic/abc~noop.heic'), '');

  const cat = parseCategoryResponse({
    code: 0,
    data: {
      has_more: true,
      next_offset: 20,
      session_id: 'sess-1',
      selector_rows: [
        { type: 'genre', items: [{ selector_item_id: 'short_play', show_name: '真人剧' }] },
        { type: 'category_dim_theme', items: [{ selector_item_id: 'cate_9165', show_name: '动作' }] },
      ],
      video_data: [
        {
          series_id: '7503745441910017049',
          title: '分类测试短剧',
          cover: 'https://p3-novel.byteimg.com/novel-pic/xyz~noop.heic',
          episode_cnt: 80,
          tag_info: { text: '今日上新' },
          sub_title_list: [{ content: '甜宠' }],
        },
      ],
    },
  });
  assert.equal(cat.items.length, 1);
  assert.equal(cat.items[0].badge, '今日上新');
  assert.equal(cat.selectors.length, 2);
  assert.equal(cat.hasMore, true);

  const rank = parseRankResponse({
    code: 0,
    data: {
      cell_view: {
        has_more: true,
        next_offset: 20,
        session_id: 'rank-sess',
        cell_selector: {
          outer_row: {
            items: [
              {
                selector_item_id: 'all',
                is_selected: true,
                sub_cell_selector: {
                  outer_row: { items: [{ selector_item_id: 'ranklist_hot_play_sc', is_selected: true }] },
                },
              },
            ],
          },
        },
        cell_data: [
          {
            video_data: [
              {
                series_id: '7503745441910017049',
                title: '榜单测试短剧',
                cover: 'https://p3.byteimg.com/cover.jpg',
                episode_cnt: 60,
                content_type: 1,
              },
            ],
          },
        ],
      },
    },
  }, 'hot-drama');
  assert.equal(rank.items.length, 1);
  assert.equal(rank.items[0].id, '7503745441910017049');
  assert.equal(rank.hasMore, true);
});
