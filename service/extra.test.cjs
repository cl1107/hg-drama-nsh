'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseSearchResponse } = require('./discover.cjs');
const { storeCookies, cookieHeaderFor, getAccountStatus, logoutAccount, mixEncode, normalizeMobile } = require('./auth.cjs');

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
});

test('auth cookie jar scopes cookies by domain and clears on logout', () => {
  logoutAccount();
  assert.equal(getAccountStatus().loggedIn, false);
  storeCookies({ 'set-cookie': ['sid=abc; Domain=.douyin.com; Path=/; HttpOnly', 'csrf=123; Path=/'] }, 'https://sso.douyin.com/passport/web/get_qrcode/');
  assert.match(cookieHeaderFor('https://sso.douyin.com/passport/account/info/v2/'), /sid=abc/);
  assert.match(cookieHeaderFor('https://sso.douyin.com/passport/account/info/v2/'), /csrf=123/);
  assert.equal(cookieHeaderFor('https://hongguoduanju.com/'), '');
  logoutAccount();
  assert.equal(cookieHeaderFor('https://sso.douyin.com/'), '');
});

test('auth mixEncode and normalizeMobile encode phone numbers cleanly', () => {
  assert.equal(normalizeMobile('13800138000'), '+8613800138000');
  assert.equal(normalizeMobile(' +86 138-0013-8000 '), '+8613800138000');
  assert.throws(() => normalizeMobile('12345'));
  // '+86' -> 0x2b^5=2e, 0x38^5=3d, 0x36^5=33
  assert.equal(mixEncode('+86'), '2e3d33');
});
