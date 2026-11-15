'use strict';
const { bytes, allowedUrl } = require('./transport.cjs');

const AUTH_DOMAINS = ['hongguoduanju.com', 'douyin.com', 'snssdk.com', 'fqnovel.com'];
const PASSPORT_HOST = 'https://hongguoduanju.com';
const WEBSITE_ORIGIN = 'https://hongguoduanju.com';
const AUTH_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

// In-memory only: never persisted to disk, never returned to TSX or logs.
const cookieJar = new Map();
let currentUser = null;

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

function storeCookies(headers, requestUrl) {
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
    if (maxAge !== null && maxAge <= 0) cookieJar.delete(key);
    else cookieJar.set(key, { domain, name, value });
  }
}

function cookieHeaderFor(urlStr) {
  const host = new URL(urlStr).hostname.toLowerCase();
  const pairs = [];
  for (const { domain, name, value } of cookieJar.values()) {
    if (host === domain || host.endsWith(`.${domain}`)) pairs.push(`${name}=${value}`);
  }
  return pairs.join('; ');
}

async function authRequest(urlStr, signal, options = {}) {
  let current = allowedUrl(urlStr, AUTH_DOMAINS).href;
  let method = options.method || 'GET';
  let data = options.data;
  for (let hop = 0; hop < 6; hop += 1) {
    const cookie = cookieHeaderFor(current);
    const headers = {
      'User-Agent': AUTH_UA,
      Accept: 'application/json, text/plain, */*',
      Referer: `${WEBSITE_ORIGIN}/`,
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
    storeCookies(res.headers, current);
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
  const params = new URLSearchParams({
    service: WEBSITE_ORIGIN,
    next: WEBSITE_ORIGIN,
    aid: '513755',
    passport_jssdk_version: '3.4.10',
  });
  const res = await authRequest(`${PASSPORT_HOST}/passport/web/get_qrcode/?${params.toString()}`, signal);
  if (res.status !== 200) throw Object.assign(new Error(`获取二维码失败（HTTP ${res.status}）`), { code: 'AUTH_QR_HTTP' });
  const body = parseJson(res.text);
  const data = body?.data;
  if (!data || typeof data.token !== 'string' || !data.token) {
    throw Object.assign(new Error(data?.description || body?.message || '未能获取登录二维码'), { code: 'AUTH_QR_FAILED' });
  }
  return {
    token: data.token,
    qrcode: typeof data.qrcode === 'string' ? data.qrcode : '',
    qrcodeIndexUrl: typeof data.qrcode_index_url === 'string' ? data.qrcode_index_url : '',
    expireTime: Number(data.expire_time || 0),
  };
}

async function verifyAccount(signal) {
  const res = await authRequest(`${PASSPORT_HOST}/passport/account/info/v2/?aid=513755`, signal);
  if (res.status !== 200) throw Object.assign(new Error(`账号验证失败（HTTP ${res.status}）`), { code: 'AUTH_VERIFY_HTTP' });
  const body = parseJson(res.text);
  const data = body?.data;
  const userId = data?.user_id_str || (data?.user_id ? String(data.user_id) : '');
  if (!userId || !/^\d{1,30}$/.test(userId)) {
    throw Object.assign(new Error('未能确认账号身份'), { code: 'AUTH_VERIFY_INVALID' });
  }
  currentUser = {
    userId,
    nickname: typeof data.name === 'string' && data.name.trim() ? data.name.trim() : `用户 ${userId.slice(-4)}`,
    avatar: typeof data.avatar_url === 'string' ? data.avatar_url : '',
  };
  return currentUser;
}

async function pollQrLogin(token, signal) {
  if (typeof token !== 'string' || !token.trim()) {
    throw Object.assign(new Error('二维码令牌无效'), { code: 'INVALID_REQUEST' });
  }
  const params = new URLSearchParams({
    token: token.trim(),
    service: WEBSITE_ORIGIN,
    next: WEBSITE_ORIGIN,
    aid: '513755',
    passport_jssdk_version: '3.4.10',
  });
  const res = await authRequest(`${PASSPORT_HOST}/passport/web/check_qrconnect/?${params.toString()}`, signal);
  if (res.status !== 200) throw Object.assign(new Error(`扫码状态检查失败（HTTP ${res.status}）`), { code: 'AUTH_POLL_HTTP' });
  const body = parseJson(res.text);
  const status = String(body?.data?.status || '');
  if (status === '1' || status === 'new') return { status: 'waiting' };
  if (status === '2' || status === 'scanned') return { status: 'scanned' };
  if (status === '4' || status === 'expired') return { status: 'expired' };
  if (status === '5' || status === 'refused' || status === 'cancelled') return { status: 'cancelled' };
  if (status === '3' || status === 'confirmed') {
    if (typeof body?.data?.redirect_url === 'string' && body.data.redirect_url) {
      await authRequest(body.data.redirect_url, signal);
    }
    const user = await verifyAccount(signal);
    return { status: 'confirmed', user };
  }
  return { status: 'waiting' };
}

async function sendSmsCode({ mobile, captcha = '' } = {}, signal) {
  const normalized = normalizeMobile(mobile);
  const form = new URLSearchParams({
    mobile: mixEncode(normalized),
    type: '3731',
    mix_mode: '1',
    ...(typeof captcha === 'string' && captcha.trim() ? { captcha: captcha.trim() } : {}),
  });
  const res = await authRequest(
    `${PASSPORT_HOST}/passport/web/send_code/?aid=513755&account_sdk_source=web&passport_jssdk_version=3.4.10`,
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
  throw Object.assign(new Error(body?.data?.description || '发送验证码失败'), { code: 'AUTH_SMS_SEND_FAILED' });
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
    next: WEBSITE_ORIGIN,
    ...(typeof captcha === 'string' && captcha.trim() ? { captcha: captcha.trim() } : {}),
  });
  const res = await authRequest(
    `${PASSPORT_HOST}/passport/web/sms_login/?aid=513755&account_sdk_source=web&passport_jssdk_version=3.4.10`,
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
    throw Object.assign(new Error(body?.data?.description || '短信登录失败'), { code: 'AUTH_SMS_LOGIN_FAILED' });
  }
  if (typeof body?.data?.redirect_url === 'string' && body.data.redirect_url) {
    await authRequest(body.data.redirect_url, signal);
  }
  const user = await verifyAccount(signal);
  return { loggedIn: true, user };
}

function getAccountStatus() {
  return currentUser ? { loggedIn: true, user: currentUser } : { loggedIn: false };
}

function logoutAccount() {
  cookieJar.clear();
  currentUser = null;
  return { loggedIn: false };
}

module.exports = {
  createQrLogin,
  pollQrLogin,
  sendSmsCode,
  smsLogin,
  getAccountStatus,
  logoutAccount,
  storeCookies,
  cookieHeaderFor,
  mixEncode,
  normalizeMobile,
};
