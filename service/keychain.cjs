'use strict';
const { execFile, spawn } = require('node:child_process');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);
const SAFE_ID = /^[a-zA-Z0-9._-]+$/;

function assertSafeId(value, name) {
  if (typeof value !== 'string' || !SAFE_ID.test(value)) {
    throw new TypeError(`${name} 格式无效`);
  }
}

function isAvailable() {
  return process.platform === 'darwin';
}

async function saveSecret(service, account, value) {
  if (!isAvailable()) return false;
  assertSafeId(service, 'service');
  assertSafeId(account, 'account');
  const encoded = Buffer.from(String(value), 'utf8').toString('base64');
  await new Promise((resolve, reject) => {
    const child = spawn('/usr/bin/security', ['-i'], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => {
      if (code === 0) resolve();
      else reject(new Error(stderr.trim() || `Keychain 写入失败（退出码 ${code}）`));
    });
    child.stdin.end(`add-generic-password -U -a ${account} -s ${service} -w "${encoded}"\n`);
  });
  return true;
}

async function readSecret(service, account) {
  if (!isAvailable()) return null;
  assertSafeId(service, 'service');
  assertSafeId(account, 'account');
  try {
    const { stdout } = await execFileAsync('/usr/bin/security', [
      'find-generic-password', '-a', account, '-s', service, '-w',
    ]);
    const raw = stdout.trim();
    if (!raw) return null;
    return Buffer.from(raw, 'base64').toString('utf8');
  } catch {
    return null;
  }
}

async function deleteSecret(service, account) {
  if (!isAvailable()) return false;
  assertSafeId(service, 'service');
  assertSafeId(account, 'account');
  try {
    await execFileAsync('/usr/bin/security', [
      'delete-generic-password', '-a', account, '-s', service,
    ]);
  } catch {
    // Ignore when item does not exist.
  }
  return true;
}

module.exports = { isAvailable, saveSecret, readSecret, deleteSecret };
