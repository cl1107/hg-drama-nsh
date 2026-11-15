'use strict';
const { bytes, allowedUrl } = require('./transport.cjs');
const keychain = require('./keychain.cjs');
const { getPlaybackDevice } = require('./vendor/hongguo/playback-device');
const { signedAccountRequest, requestJson, preserveLargeJsonIntegers } = require('./vendor/hongguo/app-source');

const AUTH_DOMAINS = ['hongguoduanju.com', 'douyin.com', 'snssdk.com', 'fqnovel.com'];
const PASSPORT_HOST = 'https://hongguoduanju.com';
const WEBSITE_ORIGIN = 'https://hongguoduanju.com';
const AUTH_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
const WEB_QUERY = {
  aid: '513755',
  passport_jssdk_version: '3.4.10',
  passport_jssdk_type: 'normal',
  account_sdk_source: 'web',
  is_from_ttaccountsdk: '1',
  language: 'zh',
};
const KEYCHAIN_SERVICE = 'com.hgdrama.nsh.session';
const KEYCHAIN_ACCOUNT = 'default';

// In-memory cookie jar; persisted only to OS Keychain when available.
const cookieJar = new Map();
const qrJars = new Map();
const activePolls = new Map();
let currentUser = null;
let pendingVerification = false;
let restoredOnce = false;
let restorePromise = null;

function mixEncode(value) {
  const bytesBuf = Buffer.from(String(value), 'utf8');
  let out = '';
  for (let i = 0; i < bytesBuf.length; i += 1) {
    out += (bytesBuf[i] ^ 5).toString(16).padStart(2, '0');
  }
  return out;
}

function normalizeMobile(mobile) {
  const clean = String(mobile || '').trim().replace(/[\s-]/g, '');
  if (/^1[3-9]\d{9}$/.test(clean)) return `+86${clean}`;
  if (/^\+\d{7,15}$/.test(clean)) return clean;
  throw Object.assign(new Error('请输入有效的手机号'), { code: 'INVALID_REQUEST' });
}

function storeCookies(headers, requestUrl, jar = cookieJar) {
  const setCookie = headers?.['set-cookie'];
  if (!setCookie) return;
  const list = Array.isArray(setCookie) ? setCookie : [setCookie];
  const reqHost = new URL(requestUrl).hostname;
  for (const raw of list) {
    const parts = String(raw).split(';').map(s => s.trim());
    const eq = parts[0]?.indexOf('=') ?? -1;
    if (eq <= 0) continue;
    const name = parts[0].slice(0, eq).trim();
    const value = parts[0].slice(eq + 1).trim();
    let domain = reqHost;
    let maxAge = null;
    for (const attr of parts.slice(1)) {
      const idx = attr.indexOf('=');
      const k = (idx < 0 ? attr : attr.slice(0, idx)).trim().toLowerCase();
      const v = idx < 0 ? '' : attr.slice(idx + 1).trim();
      if (k === 'domain' && v) domain = v.replace(/^\./, '').toLowerCase();
      if (k === 'max-age' && /^-?\d+$/.test(v)) maxAge = Number(v);
    }
    const key = `${domain}:${name}`;
    if (maxAge !== null && maxAge <= 0) jar.delete(key);
    else jar.set(key, { domain, name, value });
  }
}

function cookieHeaderFor(urlStr, jar = cookieJar) {
  const host = new URL(urlStr).hostname.toLowerCase();
  const pairs = [];
  for (const { domain, name, value } of jar.values()) {
    if (host === domain || host.endsWith(`.${domain}`)) pairs.push(`${name}=${value}`);
  }
  return pairs.join('; ');
}

function jarHasSession(jar = cookieJar) {
  for (const { name, value } of jar.values()) {
    if ((name === 'sessionid' || name === 'sessionid_ss') && value) return true;
  }
  return false;
}

async function persistSession(store = keychain) {
  if (!currentUser || !cookieJar.size || !store.isAvailable()) return false;
  try {
    const payload = JSON.stringify({
      user: currentUser,
      cookies: Array.from(cookieJar.values()),
    });
    return await store.saveSecret(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT, payload);
  } catch {
    return false;
  }
}

async function restoreSession(signal, store = keychain, force = false) {
  if (restoredOnce && !force) return getAccountStatus();
  if (restorePromise) return restorePromise;
  restorePromise = (async () => {
    try {
      const raw = await store.readSecret(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT);
      if (!raw) {
        restoredOnce = true;
        return getAccountStatus();
      }
      const parsed = parseJson(raw);
      if (!parsed || !Array.isArray(parsed.cookies) || !parsed.user?.userId) {
        await store.deleteSecret(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT);
        restoredOnce = true;
        return getAccountStatus();
      }
      cookieJar.clear();
      for (const item of parsed.cookies) {
        if (item?.domain && item?.name && typeof item?.value === 'string') {
          cookieJar.set(`${item.domain}:${item.name}`, {
            domain: String(item.domain),
            name: String(item.name),
            value: item.value,
          });
        }
      }
      currentUser = {
        userId: String(parsed.user.userId),
        nickname: String(parsed.user.nickname || `用户 ${String(parsed.user.userId).slice(-4)}`),
        avatar: String(parsed.user.avatar || ''),
      };
      try {
        await verifyAccount(signal, store);
        pendingVerification = false;
      } catch (error) {
        if (error?.code === 'AUTH_VERIFY_INVALID' || error?.status === 401) {
          cookieJar.clear();
          currentUser = null;
          pendingVerification = false;
          await store.deleteSecret(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT);
        } else {
          // Network/timeout: keep restored session as pending verification.
          pendingVerification = true;
        }
      }
      restoredOnce = true;
      return getAccountStatus();
    } finally {
      restorePromise = null;
    }
  })();
  return restorePromise;
}

async function authRequest(urlStr, signal, options = {}) {
  const jar = options.jar || cookieJar;
  let current = allowedUrl(urlStr, AUTH_DOMAINS).href;
  let method = options.method || 'GET';
  let data = options.data;
  for (let hop = 0; hop < 6; hop += 1) {
    const cookie = cookieHeaderFor(current, jar);
    const headers = {
      'User-Agent': AUTH_UA,
      Accept: 'application/json, text/javascript',
      Referer: `${WEBSITE_ORIGIN}/`,
      Origin: WEBSITE_ORIGIN,
      ...(options.contentType && data !== undefined ? { 'Content-Type': options.contentType } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
    };
    const res = await bytes(current, {
      domains: AUTH_DOMAINS,
      method,
      headers,
      data,
      signal,
      timeout: 12000,
    });
    storeCookies(res.headers, current, jar);
    if ([301, 302, 303, 307, 308].includes(res.status)) {
      const location = res.headers?.location;
      if (!location) throw Object.assign(new Error('登录跳转缺少目标地址'), { code: 'AUTH_REDIRECT' });
      current = allowedUrl(new URL(location, current).href, AUTH_DOMAINS).href;
      method = 'GET';
      data = undefined;
      continue;
    }
    return { status: res.status, text: res.data.toString('utf8') };
  }
  throw Object.assign(new Error('登录跳转次数过多'), { code: 'AUTH_REDIRECT_LIMIT' });
}

function parseJson(text) {
  try { return JSON.parse(text); } catch { return null; }
}

async function createQrLogin(signal) {
  const jar = new Map();
  const params = new URLSearchParams({
    ...WEB_QUERY,
    next: `${WEBSITE_ORIGIN}/`,
  });
  const res = await authRequest(`${PASSPORT_HOST}/passport/web/get_qrcode/?${params.toString()}`, signal, { jar });
  if (res.status !== 200) throw Object.assign(new Error(`获取二维码失败（HTTP ${res.status}）`), { code: 'AUTH_QR_HTTP' });
  const body = parseJson(res.text);
  const data = body?.data;
  if (!data || typeof data.token !== 'string' || !data.token) {
    throw Object.assign(new Error(data?.description || body?.message || '未能获取登录二维码'), { code: 'AUTH_QR_FAILED' });
  }
  qrJars.clear();
  qrJars.set(data.token, jar);
  return {
    token: data.token,
    qrcode: typeof data.qrcode === 'string' ? data.qrcode : '',
    qrcodeIndexUrl: typeof data.qrcode_index_url === 'string' ? data.qrcode_index_url : '',
    expireTime: Number(data.expire_time || 0),
  };
}

async function verifyAccount(signal, store = keychain, jar = cookieJar) {
  const params = new URLSearchParams(WEB_QUERY);
  const res = await authRequest(`${PASSPORT_HOST}/passport/account/info/v2/?${params.toString()}`, signal, { jar });
  if (res.status === 401) throw Object.assign(new Error('登录会话已失效'), { code: 'AUTH_VERIFY_INVALID', status: 401 });
  if (res.status !== 200) throw Object.assign(new Error(`账号验证失败（HTTP ${res.status}）`), { code: 'AUTH_VERIFY_HTTP', status: res.status });
  const body = parseJson(res.text);
  const data = body?.data;
  const userId = data?.user_id_str || (data?.user_id ? String(data.user_id) : '');
  if (!userId || !/^\d{1,30}$/.test(userId)) {
    throw Object.assign(new Error('未能确认账号身份'), { code: 'AUTH_VERIFY_INVALID' });
  }
  if (jar !== cookieJar) {
    cookieJar.clear();
    for (const [k, v] of jar.entries()) cookieJar.set(k, v);
  }
  currentUser = {
    userId,
    nickname: typeof data.name === 'string' && data.name.trim() ? data.name.trim() : `用户 ${userId.slice(-4)}`,
    avatar: typeof data.avatar_url === 'string' ? data.avatar_url : '',
  };
  pendingVerification = false;
  restoredOnce = true;
  await persistSession(store);
  return currentUser;
}

async function pollQrLogin(token, signal) {
  if (typeof token !== 'string' || !token.trim()) {
    throw Object.assign(new Error('二维码令牌无效'), { code: 'INVALID_REQUEST' });
  }
  const cleanToken = token.trim();
  if (activePolls.has(cleanToken)) return activePolls.get(cleanToken);

  const run = (async () => {
    const jar = qrJars.get(cleanToken) || new Map();
    qrJars.set(cleanToken, jar);
    const params = new URLSearchParams({
      ...WEB_QUERY,
      token: cleanToken,
      next: `${WEBSITE_ORIGIN}/`,
    });
    const res = await authRequest(`${PASSPORT_HOST}/passport/web/check_qrconnect/?${params.toString()}`, signal, { jar });
    if (res.status !== 200) throw Object.assign(new Error(`扫码状态检查失败（HTTP ${res.status}）`), { code: 'AUTH_POLL_HTTP' });
    const body = parseJson(res.text);
    const status = String(body?.data?.status || '');
    if (status === '5' || status === 'expired') {
      qrJars.delete(cleanToken);
      return { status: 'expired' };
    }
    if (status === '2' || status === 'scanned') return { status: 'scanned' };
    if (status !== '3' && status !== 'confirmed') return { status: 'waiting' };

    if (typeof body?.data?.redirect_url === 'string' && body.data.redirect_url) {
      await authRequest(body.data.redirect_url, signal, { jar });
    }
    if (!jarHasSession(jar)) {
      return { status: 'waiting' };
    }
    const user = await verifyAccount(signal, keychain, jar);
    qrJars.delete(cleanToken);
    return { status: 'confirmed', user };
  })();

  activePolls.set(cleanToken, run);
  try {
    return await run;
  } finally {
    activePolls.delete(cleanToken);
  }
}

async function sendSmsCode({ mobile, captcha = '' } = {}, signal) {
  const normalized = normalizeMobile(mobile);
  const form = new URLSearchParams({
    mobile: mixEncode(normalized),
    type: '3731',
    mix_mode: '1',
    ...(typeof captcha === 'string' && captcha.trim() ? { captcha: captcha.trim() } : {}),
  });
  const params = new URLSearchParams(WEB_QUERY);
  const res = await authRequest(
    `${PASSPORT_HOST}/passport/web/send_code/?${params.toString()}`,
    signal,
    {
      method: 'POST',
      contentType: 'application/x-www-form-urlencoded',
      data: form.toString(),
    },
  );
  if (res.status !== 200) throw Object.assign(new Error(`发送验证码失败（HTTP ${res.status}）`), { code: 'AUTH_SMS_HTTP' });
  const body = parseJson(res.text);
  if (body?.message === 'success') {
    return { sent: true, retryAfter: Number(body?.data?.retry_time || 60) };
  }
  if (typeof body?.data?.captcha === 'string' && body.data.captcha) {
    return {
      sent: false,
      captcha: body.data.captcha,
      message: body?.data?.description || '请输入图形验证码',
    };
  }
  const desc = body?.data?.description || '发送验证码失败';
  if (/滑块/.test(desc) || body?.data?.verify_center_decision_conf) {
    throw Object.assign(new Error('官网短信接口触发了滑块风控（滑动滑块进行验证），请使用上方“扫码登录”'), { code: 'AUTH_SMS_SLIDER' });
  }
  throw Object.assign(new Error(desc), { code: 'AUTH_SMS_SEND_FAILED' });
}

async function smsLogin({ mobile, code, captcha = '' } = {}, signal) {
  const normalized = normalizeMobile(mobile);
  const cleanCode = String(code || '').trim();
  if (!/^\d{4,8}$/.test(cleanCode)) {
    throw Object.assign(new Error('请输入 4–8 位短信验证码'), { code: 'INVALID_REQUEST' });
  }
  const form = new URLSearchParams({
    mobile: mixEncode(normalized),
    code: mixEncode(cleanCode),
    mix_mode: '1',
    next: `${WEBSITE_ORIGIN}/`,
    ...(typeof captcha === 'string' && captcha.trim() ? { captcha: captcha.trim() } : {}),
  });
  const params = new URLSearchParams(WEB_QUERY);
  const res = await authRequest(
    `${PASSPORT_HOST}/passport/web/sms_login/?${params.toString()}`,
    signal,
    {
      method: 'POST',
      contentType: 'application/x-www-form-urlencoded',
      data: form.toString(),
    },
  );
  if (res.status !== 200) throw Object.assign(new Error(`短信登录失败（HTTP ${res.status}）`), { code: 'AUTH_SMS_LOGIN_HTTP' });
  const body = parseJson(res.text);
  if (typeof body?.data?.captcha === 'string' && body.data.captcha && body?.message !== 'success') {
    return {
      loggedIn: false,
      captcha: body.data.captcha,
      message: body?.data?.description || '请输入图形验证码',
    };
  }
  if (body?.message !== 'success') {
    const desc = body?.data?.description || '短信登录失败';
    if (/滑块/.test(desc) || body?.data?.verify_center_decision_conf) {
      throw Object.assign(new Error('官网短信接口触发了滑块风控，请使用上方“扫码登录”'), { code: 'AUTH_SMS_SLIDER' });
    }
    throw Object.assign(new Error(desc), { code: 'AUTH_SMS_LOGIN_FAILED' });
  }
  if (typeof body?.data?.redirect_url === 'string' && body.data.redirect_url) {
    await authRequest(body.data.redirect_url, signal);
  }
  const user = await verifyAccount(signal);
  return { loggedIn: true, user };
}

async function fetchCloudHistory(signal) {
  if (!currentUser || !cookieJar.size) {
    throw Object.assign(new Error('请先登录后再读取云端历史'), { code: 'AUTH_REQUIRED' });
  }
  const identity = await getPlaybackDevice(requestJson);
  const req = signedAccountRequest('/reading/bookapi/read_history/list/v1/', {
    book_type: '2',
    limit: '0',
    offset: '0',
    last_min_read_timestamp_ms: '0',
    full_field: 'true',
    is_first_load: 'true',
    query_soft_deleted: 'false',
  }, identity);
  const cookie = cookieHeaderFor(req.url) || cookieHeaderFor(WEBSITE_ORIGIN);
  const res = await bytes(req.url, {
    domains: AUTH_DOMAINS,
    headers: {
      ...req.headers,
      ...(cookie ? { Cookie: cookie } : {}),
    },
    signal,
    timeout: 12000,
  });
  if (res.status !== 200) throw Object.assign(new Error(`云端历史请求失败（HTTP ${res.status}）`), { code: 'CLOUD_HISTORY_HTTP' });
  const normalized = preserveLargeJsonIntegers(res.data.toString('utf8'), ['book_id', 'book_id_str', 'series_id', 'item_id', 'vid', 'video_id']);
  const payload = parseJson(normalized);
  const list = Array.isArray(payload?.data?.data_list) ? payload.data.data_list : [];
  const items = [];
  for (const row of list) {
    if (row?.is_delete) continue;
    const seriesId = String(row?.book_id_str || row?.series_id || row?.book_id || '').trim();
    const title = String(row?.series_title || row?.book_name || row?.series_name || row?.title || '').trim();
    if (!/^\d{1,30}$/.test(seriesId) || !title) continue;
    const epId = String(row?.vid || row?.item_id || row?.video_id || '').trim();
    items.push({
      seriesId,
      title,
      cover: typeof row?.series_cover_url === 'string' ? row.series_cover_url : typeof row?.thumb_url === 'string' ? row.thumb_url : '',
      episodeId: /^\d{1,30}$/.test(epId) ? epId : '',
      episodeIndex: Number(row?.vid_index || row?.episode_index || row?.read_index || 1),
      totalEpisodes: Number(row?.episode_cnt || row?.episode_count || row?.serial_count || 0),
    });
  }
  return { items };
}

function getAccountStatus() {
  return currentUser
    ? { loggedIn: true, user: currentUser, persistent: keychain.isAvailable(), pendingVerification }
    : { loggedIn: false, persistent: keychain.isAvailable(), pendingVerification: false };
}

async function logoutAccount(store = keychain) {
  cookieJar.clear();
  qrJars.clear();
  currentUser = null;
  pendingVerification = false;
  restoredOnce = true;
  await store.deleteSecret(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT);
  return { loggedIn: false, persistent: store.isAvailable(), pendingVerification: false };
}

module.exports = {
  createQrLogin,
  pollQrLogin,
  sendSmsCode,
  smsLogin,
  fetchCloudHistory,
  restoreSession,
  getAccountStatus,
  logoutAccount,
  storeCookies,
  cookieHeaderFor,
  mixEncode,
  normalizeMobile,
};
