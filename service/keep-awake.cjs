'use strict';
// macOS 防息屏：播放期间用 caffeinate 持有显示休眠断言，暂停/退出即释放。
// `-w` 绑定本服务进程：服务被强杀时断言随之消失，不会遗留。
const { spawn } = require('node:child_process');

let child;

function stop() {
  if (!child) return;
  const dying = child;
  child = undefined;
  dying.removeAllListeners();
  try { dying.kill('SIGTERM'); } catch {}
}

function start() {
  if (child) return;
  // -d 防显示器休眠；-i 防系统空闲休眠；-s 防 AC 供电下系统休眠；-w 绑定本进程。
  try {
    const spawned = spawn('caffeinate', ['-d', '-i', '-s', '-w', String(process.pid)], { stdio: 'ignore' });
    spawned.on('error', () => { if (child === spawned) child = undefined; });
    spawned.on('exit', () => { if (child === spawned) child = undefined; });
    child = spawned;
  } catch {
    return; // 非 macOS 或无 caffeinate：静默降级
  }
}

function setKeepAwake(active) {
  if (active) start();
  else stop();
}

module.exports = { setKeepAwake, stopKeepAwake: stop };
